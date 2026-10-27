import Foundation

/// Decides, one playout step at a time, what a speaker's stream should play next. It knows nothing about
/// Opus, clocks or audio hardware, allocates nothing after init and is fully deterministic, so the render
/// thread can drive it under a lock and tests can replay network conditions exactly.
///
/// Time is counted in Mumble frame-number units (10 ms) for positions and in 48 kHz samples for delays.
/// The delay adapts like the web client's JitterPolicy, and every change in output gain is a ramp, so
/// starts, stops, losses and skips never step.
struct JitterBuffer {
    static let unitSamples = 480
    static let rampSamples = 480
    static let secondSamples = 48_000

    // 60 ms keeps two 20 ms packets in hand, the most common Mumble packet size, and matches the web client's
    // floor. Two packets of the sender's own length are the real minimum: one playing and one in flight.
    static let floorSamples = 48 * 60
    // Past 200 ms conversation starts to talk over itself; occasional concealment is the better trade.
    static let ceilingSamples = 48 * 200
    // A buffer this deep while playing means the render thread stalled while packets kept coming.
    static let skipAboveSamples = 48 * 400
    // Extra delay tolerated when starting; the rest is shed later by dropping quiet packets.
    static let startSlackSamples = 48 * 100
    // Opus concealment sounds natural for a few tens of milliseconds; after that it buzzes, so fade out.
    static let fullGainConcealSamples = 48 * 40
    static let lateToleranceUnits: UInt64 = 100
    // An earlier frame number this long after the last stream ended is a sender that restarted its count.
    static let restartAfterSamples = 48 * 200

    enum Action: Equatable {
        /// Decode this packet.
        case play(slot: Int)
        /// Decode the in-band FEC of this (the following) packet to rebuild the missing audio before it.
        case recover(slot: Int)
        /// Run Opus packet loss concealment.
        case conceal
    }

    struct Step: Equatable {
        var action: Action
        var frame: UInt64
        var samples: Int
        /// The gain ramps from `gainFrom` to `gainTo` over the first `rampSamples` of the step.
        var gainFrom: Float
        var gainTo: Float
        var resetsDecoder: Bool
    }

    struct Statistics: Equatable {
        var underruns = 0
        var concealedFrames = 0
        var recovered = 0
        var late = 0
        var duplicates = 0
        var reordered = 0
        var trims = 0
        var drops = 0
        var stretches = 0
        var targetSamples = 0
        var lowestBufferedSamples: Int?

        var hasEvents: Bool {
            underruns + concealedFrames + recovered + late + duplicates + reordered + trims + drops + stretches > 0
        }
    }

    /// The web client's adaptive delay: grow quickly when playback runs dry or nearly so, shrink slowly after
    /// a calm stretch, and double the calm needed whenever a shrink is followed by another grow.
    struct DelayPolicy {
        static let growSamples = 48 * 20
        static let shrinkSamples = 48 * 10
        static let dangerSamples = 48 * 10
        static let baseCalmWindows = 15
        static let maximumCalmWindows = 240

        private(set) var minimum: Int
        private(set) var maximum: Int
        private(set) var target: Int
        private var calmWindows = 0
        private var requiredCalmWindows = DelayPolicy.baseCalmWindows
        private var shrankLast = false

        init(minimum: Int, maximum: Int) {
            self.minimum = minimum
            self.maximum = max(maximum, minimum)
            target = minimum
        }

        mutating func setMinimum(_ newMinimum: Int) {
            minimum = newMinimum
            maximum = max(maximum, newMinimum)
            target = min(maximum, max(target, newMinimum))
        }

        /// Returns the samples added to the target.
        @discardableResult
        mutating func grow() -> Int {
            if shrankLast {
                requiredCalmWindows = min(Self.maximumCalmWindows, requiredCalmWindows * 2)
            }
            shrankLast = false
            calmWindows = 0
            let previous = target
            target = min(maximum, target + Self.growSamples)
            return target - previous
        }

        /// Called once per second of playout with the lowest level the buffer reached. Returns the change in target.
        mutating func observe(lowWater: Int?, cushion: Int) -> Int {
            if let lowWater, lowWater < Self.dangerSamples {
                return grow()
            }
            calmWindows += 1
            guard calmWindows >= requiredCalmWindows, target > minimum,
                  let lowWater, lowWater >= Self.shrinkSamples + cushion else { return 0 }
            if shrankLast {
                requiredCalmWindows = max(Self.baseCalmWindows, requiredCalmWindows / 2)
            }
            let previous = target
            target = max(minimum, target - Self.shrinkSamples)
            calmWindows = 0
            shrankLast = true
            return target - previous
        }
    }

    private struct Slot {
        var frame: UInt64 = 0
        var units = 0
        var length = 0
        var isTerminator = false
        var used = false
    }

    private enum State { case idle, buffering, playing }

    let maximumPayloadBytes: Int
    private var slots: [Slot]
    private var payloads: [UInt8]
    private var state = State.idle
    private var position: UInt64 = 0
    private var newestFrame: UInt64?
    private var gain: Float = 0
    private var packetUnits = 2
    private var lossRunSamples = 0
    private var isDry = false
    private var waitedSamples = 0
    private var endPending = false
    private var restartPending = false
    private var resetDecoderOnStart = true
    private var hasPlayed = false
    private var stretchDebt = 0
    private var lateInWindow = false
    private var playedInWindow = 0
    private var windowLow: Int?
    private var recentLow: Int?
    private var policy: DelayPolicy
    private var statistics = Statistics()

    // One Opus frame can be 1275 bytes, and a desktop Mumble on high quality
    // with 60 ms packets sends about 1200; anything larger is dropped as lost.
    init(slotCount: Int = 64, maximumPayloadBytes: Int = 1500) {
        self.maximumPayloadBytes = maximumPayloadBytes
        slots = [Slot](repeating: Slot(), count: slotCount)
        payloads = [UInt8](repeating: 0, count: slotCount * maximumPayloadBytes)
        policy = DelayPolicy(minimum: Self.floorSamples, maximum: Self.ceilingSamples)
    }

    var targetSamples: Int { policy.target }
    var packetSamples: Int { packetUnits * Self.unitSamples }
    var isIdle: Bool { state == .idle || (state == .buffering && earliestSlot() == nil) }
    var bufferedSamples: Int { Int(newestEnd - position) * Self.unitSamples }

    private var minimumTarget: Int { max(Self.floorSamples, 2 * packetSamples) }
    private var fullGainLimit: Int { max(Self.fullGainConcealSamples, packetSamples) }

    // MARK: Network side

    mutating func insert(frame: UInt64, samples: Int, payload: UnsafeRawBufferPointer, isTerminator: Bool) {
        guard payload.count <= maximumPayloadBytes, !payload.isEmpty || isTerminator else { return }
        let units = payload.isEmpty ? 0 : max(1, (samples + Self.unitSamples - 1) / Self.unitSamples)
        if units > 0, units != packetUnits {
            packetUnits = units
            policy.setMinimum(minimumTarget)
        }

        switch state {
        case .idle:
            // A straggler from the stream that just ended must not start a new one.
            if hasPlayed, frame < position, position - frame <= Self.lateToleranceUnits,
               waitedSamples < Self.restartAfterSamples {
                statistics.late += 1
                return
            }
            begin(at: frame)
        case .buffering where !hasPlayed && frame < position:
            if position - frame <= Self.lateToleranceUnits {
                position = frame
            } else {
                restart(at: frame)
            }
        case .buffering, .playing:
            if frame < position {
                if position - frame <= Self.lateToleranceUnits {
                    statistics.late += 1
                    lateInWindow = true
                    return
                }
                restart(at: frame)
            } else if frame > newestEnd + Self.lateToleranceUnits {
                restart(at: frame)
            }
        }

        if slot(at: frame) != nil {
            statistics.duplicates += 1
            return
        }
        if state == .buffering, earliestSlot() == nil { waitedSamples = 0 }
        if let newestFrame, frame < newestFrame {
            statistics.reordered += 1
        }
        newestFrame = max(newestFrame ?? frame, frame)

        let index: Int
        if let free = slots.firstIndex(where: { !$0.used }) {
            index = free
        } else {
            // Only reachable when far more than the ceiling is queued; the oldest packet is the one to lose.
            index = earliestSlot()!
            statistics.trims += 1
        }
        slots[index] = Slot(frame: frame, units: units, length: payload.count, isTerminator: isTerminator, used: true)
        payloads.withUnsafeMutableBytes { storage in
            let start = index * maximumPayloadBytes
            UnsafeMutableRawBufferPointer(rebasing: storage[start..<start + payload.count]).copyMemory(from: payload)
        }
    }

    mutating func insert(frame: UInt64, samples: Int, payload: [UInt8], isTerminator: Bool = false) {
        payload.withUnsafeBytes { insert(frame: frame, samples: samples, payload: $0, isTerminator: isTerminator) }
    }

    func withPayload<Result>(slot index: Int, _ body: (UnsafeRawBufferPointer) -> Result) -> Result {
        payloads.withUnsafeBytes { storage in
            let start = index * maximumPayloadBytes
            return body(UnsafeRawBufferPointer(rebasing: storage[start..<start + slots[index].length]))
        }
    }

    mutating func takeStatistics() -> Statistics {
        var taken = statistics
        taken.targetSamples = policy.target
        statistics = Statistics()
        return taken
    }

    // MARK: Playout side

    /// Time passed in which this stream produced nothing.
    mutating func idle(samples: Int) {
        guard state != .playing else { return }
        waitedSamples = min(waitedSamples + samples, Self.secondSamples)
        if state == .buffering, earliestSlot() == nil, waitedSamples >= Self.secondSamples {
            becomeIdle()
        }
    }

    /// The next thing to play, or nil while idle or buffering. `quiet` says whether the last decoded audio was
    /// near silence, the only time the delay is changed mid-stream.
    mutating func next(quiet: Bool) -> Step? {
        while true {
            switch state {
            case .idle:
                return nil
            case .buffering:
                guard let earliest = earliestSlot() else { return nil }
                if slots[earliest].frame > position + UInt64(packetUnits) {
                    position = slots[earliest].frame
                }
                let terminated = slots.contains { $0.used && $0.isTerminator }
                guard bufferedSamples >= policy.target || terminated || waitedSamples >= 2 * policy.target else {
                    return nil
                }
                // A burst after a stall would otherwise play late for good. A finished utterance plays whole.
                if !terminated, bufferedSamples > policy.target + max(packetSamples, Self.startSlackSamples) {
                    skipToTarget()
                }
                state = .playing
                hasPlayed = true
                stretchDebt = 0
                lossRunSamples = 0
                isDry = false
            case .playing:
                if restartPending {
                    if gain > 0 { return fadeOut() }
                    restartPending = false
                    resetDecoderOnStart = true
                    hasPlayed = false
                    state = .buffering
                    waitedSamples = 0
                    continue
                }
                if bufferedSamples > Self.skipAboveSamples {
                    if gain > 0 { return fadeOut() }
                    skipToTarget()
                }
                if endPending {
                    if slot(at: position) != nil {
                        endPending = false
                    } else if gain > 0 {
                        return fadeOut()
                    } else {
                        becomeIdle()
                        return nil
                    }
                }

                if let index = slot(at: position) {
                    let packet = slots[index]
                    if packet.units == 0 {
                        slots[index].used = false
                        endPending = packet.isTerminator
                        continue
                    }
                    if quiet, gain > 0, stretchDebt > 0 {
                        stretchDebt -= Self.unitSamples
                        statistics.stretches += 1
                        return makeStep(.conceal, samples: Self.unitSamples, gainTo: gain)
                    }
                    if quiet, canDrop(packet) {
                        slots[index].used = false
                        position += UInt64(packet.units)
                        let dropped = packet.units * Self.unitSamples
                        recentLow = recentLow.map { $0 - dropped }
                        windowLow = windowLow.map { $0 - dropped }
                        statistics.drops += 1
                        continue
                    }
                    slots[index].used = false
                    let step = makeStep(.play(slot: index), samples: packet.units * Self.unitSamples, gainTo: 1)
                    position += UInt64(packet.units)
                    endPending = packet.isTerminator
                    lossRunSamples = 0
                    isDry = false
                    noteBufferedLevel()
                    return step
                }

                if let later = earliestSlot() {
                    let gap = Int(slots[later].frame - position)
                    if gap <= packetUnits {
                        statistics.recovered += 1
                        lossRunSamples = 0
                        isDry = false
                        let step = makeStep(.recover(slot: later), samples: gap * Self.unitSamples, gainTo: 1)
                        position = slots[later].frame
                        return step
                    }
                    // Conceal up to the last packet's worth of the gap, which the next packet's FEC rebuilds.
                    let units = min(packetUnits, gap - packetUnits)
                    statistics.concealedFrames += units
                    let step = conceal(samples: units * Self.unitSamples)
                    position += UInt64(units)
                    return step
                }

                // Nothing has arrived: hold the position and conceal, so a packet that is merely late still plays.
                if !isDry {
                    isDry = true
                    statistics.underruns += 1
                    policy.grow()
                }
                if gain == 0 {
                    state = .buffering
                    waitedSamples = 0
                    return nil
                }
                statistics.concealedFrames += 1
                return conceal(samples: Self.unitSamples)
            }
        }
    }

    // MARK: Helpers

    private var newestEnd: UInt64 {
        var end = position
        for slot in slots where slot.used { end = max(end, slot.frame + UInt64(slot.units)) }
        return end
    }

    private func slot(at frame: UInt64) -> Int? {
        slots.firstIndex { $0.used && $0.frame == frame }
    }

    private func earliestSlot() -> Int? {
        var earliest: Int?
        for index in slots.indices where slots[index].used {
            if earliest == nil || slots[index].frame < slots[earliest!].frame { earliest = index }
        }
        return earliest
    }

    private mutating func makeStep(_ action: Action, samples: Int, gainTo: Float) -> Step {
        let step = Step(action: action, frame: position, samples: samples, gainFrom: gain, gainTo: gainTo,
                        resetsDecoder: resetDecoderOnStart)
        resetDecoderOnStart = false
        gain = gainTo
        notePlayed(samples)
        return step
    }

    private mutating func conceal(samples: Int) -> Step {
        lossRunSamples += samples
        return makeStep(.conceal, samples: samples, gainTo: lossRunSamples <= fullGainLimit ? gain : 0)
    }

    /// Concealment continues the waveform, so fading it out ends playback without a step.
    private mutating func fadeOut() -> Step {
        makeStep(.conceal, samples: Self.unitSamples, gainTo: 0)
    }

    /// Dropping a quiet packet shortens the delay only when the buffer has stayed above target for the last
    /// second and the packet after it is already here.
    private func canDrop(_ packet: Slot) -> Bool {
        guard gain > 0, let recentLow, slot(at: packet.frame + UInt64(packet.units)) != nil else { return false }
        let low = min(recentLow, windowLow ?? recentLow)
        return low - packet.units * Self.unitSamples >= policy.target - packetSamples
    }

    /// Only called while silent, so jumping the read position is inaudible.
    private mutating func skipToTarget() {
        let targetUnits = UInt64((policy.target + Self.unitSamples - 1) / Self.unitSamples)
        let end = newestEnd
        let keepFrom = end > targetUnits ? end - targetUnits : 0
        var resume: Int?
        for index in slots.indices where slots[index].used && slots[index].frame >= keepFrom {
            if resume == nil || slots[index].frame < slots[resume!].frame { resume = index }
        }
        if resume == nil {
            for index in slots.indices where slots[index].used {
                if resume == nil || slots[index].frame > slots[resume!].frame { resume = index }
            }
        }
        guard let resume, slots[resume].frame > position else { return }
        let start = slots[resume].frame
        for index in slots.indices where slots[index].used && slots[index].frame < start {
            slots[index].used = false
        }
        position = start
        statistics.trims += 1
    }

    private mutating func noteBufferedLevel() {
        let level = bufferedSamples
        windowLow = min(windowLow ?? level, level)
        statistics.lowestBufferedSamples = min(statistics.lowestBufferedSamples ?? level, level)
    }

    private mutating func notePlayed(_ samples: Int) {
        playedInWindow += samples
        guard playedInWindow >= Self.secondSamples else { return }
        playedInWindow -= Self.secondSamples
        // Low water only means something once the buffer has actually caught up with the last increase.
        var change = 0
        if lateInWindow {
            change = policy.grow()
        } else if stretchDebt == 0 {
            change = policy.observe(lowWater: windowLow, cushion: packetSamples)
        }
        if change > 0 && !isDry { stretchDebt += change }
        lateInWindow = false
        recentLow = windowLow
        windowLow = nil
    }

    private mutating func begin(at frame: UInt64) {
        clearSlots()
        state = .buffering
        position = frame
        waitedSamples = 0
        resetDecoderOnStart = true
        hasPlayed = false
    }

    private mutating func restart(at frame: UInt64) {
        clearSlots()
        endPending = false
        stretchDebt = 0
        position = frame
        if state == .playing && gain > 0 {
            restartPending = true
        } else {
            state = .buffering
            waitedSamples = 0
            resetDecoderOnStart = true
            hasPlayed = false
        }
    }

    private mutating func becomeIdle() {
        clearSlots()
        state = .idle
        waitedSamples = 0
        gain = 0
        endPending = false
        restartPending = false
        isDry = false
        lossRunSamples = 0
        stretchDebt = 0
        windowLow = nil
        recentLow = nil
        playedInWindow = 0
        lateInWindow = false
    }

    private mutating func clearSlots() {
        for index in slots.indices { slots[index].used = false }
        newestFrame = nil
    }
}
