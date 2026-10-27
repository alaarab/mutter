import Foundation
import MumbleProtocol

// Stands in for Opus: the first payload byte is the packet length in 10 ms units, the second identifies the
// packet, and every decoded sample is a constant so any gain step shows up as a jump between samples.
final class OpusDecoderWrapper {
    static let maximumFrameSamples = 5760
    static let level: Float = 0.1
    static var calls: [String] = []
    init() throws {}
    static func samples(in packet: Data) -> Int? { packet.first.map { Int($0) * 480 } }
    func reset() { Self.calls.append("reset") }
    func decode(_ packet: UnsafeRawBufferPointer?, fec: Bool = false, samples: Int,
                into output: UnsafeMutablePointer<Float>, capacity: Int) -> Int {
        let count: Int
        if let packet {
            count = fec ? samples : Int(packet[0]) * 480
            Self.calls.append(fec ? "fec \(packet[1])" : "play \(packet[1])")
        } else {
            count = samples
            Self.calls.append("plc \(samples)")
        }
        for index in 0..<count { output[index] = Self.level }
        return count
    }
}

struct Arrival {
    var at: Int
    var frame: UInt64
    var units: Int
    var terminator = false
}

struct Run {
    var steps: [JitterBuffer.Step] = []
    var statistics = JitterBuffer.Statistics()
    var playedAt: [UInt64: Int] = [:]
    var firstPlayAt: Int?

    var plays: [JitterBuffer.Step] { steps.filter { if case .play = $0.action { return true } else { return false } } }
    var recoveries: [JitterBuffer.Step] { steps.filter { if case .recover = $0.action { return true } else { return false } } }
    var conceals: [JitterBuffer.Step] { steps.filter { $0.action == .conceal } }
}

func check(_ condition: Bool, _ message: @autoclosure () -> String) {
    if !condition {
        print("FAIL: \(message())")
        exit(1)
    }
}

/// Plays arrivals through a jitter buffer in 10 ms render ticks, checking on every step that the gain never jumps
/// and only changes over a full ramp. Successive runs continue where the last one stopped.
struct Player {
    var buffer = JitterBuffer()
    var time = 0
    var buffered = 0
    var gain: Float = 0

    mutating func run(_ arrivals: [Arrival], until end: Int, quiet: Bool = false, stalled: Range<Int> = 0..<0,
                      label: String) -> Run {
        var run = Run()
        var pending = arrivals.filter { $0.at >= time && $0.at < end }.sorted { $0.at < $1.at }[...]
        while time < end {
            while let arrival = pending.first, arrival.at <= time {
                pending.removeFirst()
                buffer.insert(frame: arrival.frame, samples: arrival.units * 480,
                              payload: [UInt8(arrival.units), UInt8(truncatingIfNeeded: arrival.frame)],
                              isTerminator: arrival.terminator)
            }
            if !stalled.contains(time) {
                while buffered < 480 {
                    guard let step = buffer.next(quiet: quiet) else {
                        check(gain == 0, "\(label): went silent at gain \(gain) at \(time)")
                        buffer.idle(samples: 480 - buffered)
                        buffered = 480
                        break
                    }
                    check(step.gainFrom == gain, "\(label): gain jumped from \(gain) to \(step.gainFrom) at \(time)")
                    if step.gainFrom != step.gainTo {
                        check(step.samples >= JitterBuffer.rampSamples, "\(label): \(step.samples)-sample ramp at \(time)")
                    }
                    gain = step.gainTo
                    run.steps.append(step)
                    if case .play = step.action {
                        run.playedAt[step.frame] = time + buffered
                        run.firstPlayAt = run.firstPlayAt ?? time + buffered
                    }
                    buffered += step.samples
                }
                buffered -= 480
            }
            time += 480
        }
        run.statistics = buffer.takeStatistics()
        return run
    }
}

func stream(frames: StrideTo<Int>, units: Int, delay: (Int) -> Int = { _ in 240 }, terminateLast: Bool = true) -> [Arrival] {
    let all = Array(frames)
    return all.map { frame in
        Arrival(at: frame * 480 + delay(frame), frame: UInt64(frame), units: units, terminator: terminateLast && frame == all.last)
    }
}

// After a steady second, packets are held back and released together every 100 ms, the way Wi-Fi power saving
// delivers them.
func bursts(_ frame: Int) -> Int { frame < 100 ? 240 : (frame * 480 / 4800 + 1) * 4800 - frame * 480 + 240 }

func jitterBufferChecks() {
    // Steady 20 ms packets: nothing concealed, 60 ms of delay, one fade-out after the terminator.
    var player = Player()
    var run = player.run(stream(frames: stride(from: 0, to: 600, by: 2), units: 2), until: 48 * 7000, label: "steady 20 ms")
    check(run.plays.count == 300 && run.conceals.count == 1 && run.recoveries.isEmpty, "steady 20 ms: \(run.plays.count) plays")
    check(run.conceals[0].gainTo == 0 && run.steps.last == run.conceals[0], "steady 20 ms: does not end with one fade-out")
    check(run.statistics.underruns == 0 && run.statistics.targetSamples == 48 * 60, "steady 20 ms: \(run.statistics)")
    check(run.firstPlayAt! - 240 <= 48 * 60, "steady 20 ms: started \(run.firstPlayAt!) samples in")
    check(run.steps.first!.resetsDecoder && run.steps.first!.gainFrom == 0, "steady 20 ms: does not start fresh with a fade-in")

    // 60 ms packets: the floor becomes two packets.
    player = Player()
    run = player.run(stream(frames: stride(from: 0, to: 600, by: 6), units: 6), until: 48 * 7000, label: "60 ms")
    check(run.plays.count == 100 && run.conceals.count == 1 && run.statistics.underruns == 0, "60 ms: \(run.statistics)")
    check(run.statistics.targetSamples == 48 * 120, "60 ms: target \(run.statistics.targetSamples)")

    // Bursty delivery: the delay grows until playback stops running dry, and stays under the ceiling.
    player = Player()
    let bursty = stream(frames: stride(from: 0, to: 3000, by: 2), units: 2, delay: bursts)
    run = player.run(bursty, until: 48 * 10_000, label: "bursts")
    check(run.statistics.underruns > 0 && run.statistics.targetSamples > 48 * 60, "bursts: did not adapt \(run.statistics)")
    check(run.statistics.targetSamples <= JitterBuffer.ceilingSamples, "bursts: target over ceiling")
    run = player.run(bursty, until: 48 * 31_000, label: "bursts settled")
    check(run.statistics.underruns == 0 && run.statistics.concealedFrames == 0 && run.plays.last?.frame == 2998,
          "bursts: still running dry \(run.statistics)")

    // While the speaker is quiet, a delay that grows before running dry is realised by stretching quiet audio.
    player = Player()
    run = player.run(bursty, until: 48 * 31_000, quiet: true, label: "stretch")
    check(run.statistics.stretches > 0 && run.plays.last?.frame == 2998, "stretch: \(run.statistics)")

    // A lost packet with the next one already here is rebuilt from that packet's FEC.
    player = Player()
    run = player.run(stream(frames: stride(from: 0, to: 200, by: 2), units: 2).filter { $0.frame != 40 },
                   until: 48 * 3000, label: "one lost")
    check(run.recoveries.count == 1 && run.recoveries[0].frame == 40 && run.recoveries[0].samples == 960,
          "one lost: \(run.recoveries)")
    check(run.statistics.concealedFrames == 0 && run.plays.count == 99, "one lost: \(run.statistics)")

    // Two lost in a row: the first is concealed, the second rebuilt from the FEC in the packet after.
    player = Player()
    run = player.run(stream(frames: stride(from: 0, to: 200, by: 2), units: 2).filter { $0.frame != 40 && $0.frame != 42 },
                   until: 48 * 3000, label: "two lost")
    check(run.statistics.concealedFrames == 2 && run.statistics.recovered == 1 && run.recoveries[0].frame == 42,
          "two lost: \(run.statistics)")
    check(run.conceals.first!.frame == 40 && run.conceals.first!.gainTo == 1, "two lost: concealment did not keep full gain")

    // A lost packet just before the network stalls: conceal while waiting, then rebuild it from the next packet.
    player = Player()
    run = player.run(stream(frames: stride(from: 0, to: 200, by: 2), units: 2) { $0 >= 42 ? 240 + 48 * 70 : 240 }
                    .filter { $0.frame != 40 }, until: 48 * 3000, label: "lost then late")
    check(run.statistics.underruns == 1 && run.statistics.recovered == 1 && run.statistics.late == 0,
          "lost then late: \(run.statistics)")

    // A reordered pair inside the buffer plays in order with nothing concealed.
    player = Player()
    var swapped = stream(frames: stride(from: 0, to: 200, by: 2), units: 2)
    swapped[20].at = swapped[21].at + 10
    run = player.run(swapped, until: 48 * 3000, label: "reordered")
    let order = run.plays.map(\.frame)
    check(run.statistics.reordered == 1 && order == order.sorted() && order.count == 100 && run.statistics.concealedFrames == 0,
          "reordered: \(run.statistics)")

    // Duplicates are played once; a copy that turns up after its turn is late.
    player = Player()
    var duplicated = stream(frames: stride(from: 0, to: 200, by: 2), units: 2)
    duplicated.append(Arrival(at: duplicated[20].at + 5, frame: 40, units: 2))
    duplicated.append(Arrival(at: duplicated[40].at, frame: 30, units: 2))
    run = player.run(duplicated, until: 48 * 3000, label: "duplicates")
    check(run.plays.count == 100 && run.statistics.duplicates == 1 && run.statistics.late == 1, "duplicates: \(run.statistics)")

    // A 500 ms network stall then everything at once: fade out, wait, skip the backlog in silence, fade back in.
    player = Player()
    let stalled = stream(frames: stride(from: 0, to: 600, by: 2), units: 2) { frame in
        (100..<150).contains(frame) ? (150 - frame) * 480 + 240 : 240
    }
    run = player.run(stalled, until: 48 * 7000, label: "stall")
    check(run.statistics.underruns == 1 && run.statistics.trims == 1, "stall: \(run.statistics)")
    check(run.statistics.concealedFrames <= 5, "stall: concealed \(run.statistics.concealedFrames) frames")
    let behind = run.playedAt[598]! - (598 * 480 + 240)
    check(behind <= run.statistics.targetSamples + 960, "stall: still \(behind) samples behind")

    // The render thread stops for 600 ms while packets keep coming: fade out, skip, fade in.
    player = Player()
    run = player.run(stream(frames: stride(from: 0, to: 600, by: 2), units: 2), until: 48 * 7000,
                   stalled: 48 * 1000..<48 * 1600, label: "render stall")
    check(run.statistics.trims == 1 && run.statistics.underruns == 0, "render stall: \(run.statistics)")

    // A terminator ends with a fade; the next utterance starts afresh even though its frame numbers start over.
    player = Player()
    var talk = stream(frames: stride(from: 0, to: 40, by: 2), units: 2)
    talk += stream(frames: stride(from: 0, to: 40, by: 2), units: 2).map { var a = $0; a.at += 48 * 1500; return a }
    run = player.run(talk, until: 48 * 3000, label: "terminator")
    let fresh = run.steps.filter(\.resetsDecoder)
    check(run.plays.count == 40 && fresh.count == 2 && run.statistics.underruns == 0 && run.statistics.late == 0,
          "terminator: \(run.statistics), \(fresh.count) fresh starts")
    check(run.conceals.count == 2 && run.conceals.allSatisfy { $0.gainTo == 0 && $0.samples == 480 }, "terminator: fade-outs")
    check(player.buffer.isIdle, "terminator: not idle")

    // A calm network while the speaker is quiet: the grown delay comes back down by dropping quiet packets.
    player = Player()
    _ = player.run(bursty, until: 48 * 10_000, label: "grow")
    let grown = player.buffer.targetSamples
    run = player.run(stream(frames: stride(from: 1000, to: 26_000, by: 2), units: 2), until: 48 * 260_000,
                   quiet: true, label: "shrink")
    check(player.buffer.targetSamples < grown && run.statistics.drops > 0 && run.statistics.underruns == 0,
          "shrink: \(grown) -> \(player.buffer.targetSamples), \(run.statistics)")
    let last = run.plays.last!.frame
    let lag = run.playedAt[last]! - (Int(last) * 480 + 240)
    check(lag <= player.buffer.targetSamples + 960, "shrink: still \(lag) samples behind at target \(player.buffer.targetSamples)")

    print("PASS: jitter buffer handles steady, 60 ms, bursty, lost, reordered, duplicate, stalled and terminated streams")
}

func render(_ stream: UserStream, _ arrivals: [Arrival], until end: Int) -> [Float] {
    var pending = arrivals.sorted { $0.at < $1.at }[...]
    var output: [Float] = []
    var time = 0
    var block = [Float](repeating: 0, count: 480)
    while time < end {
        while let arrival = pending.first, arrival.at <= time {
            pending.removeFirst()
            var packet = AudioPacket()
            packet.frameNumber = arrival.frame
            packet.opusData = Data([UInt8(arrival.units), UInt8(truncatingIfNeeded: arrival.frame)])
            packet.isTerminator = arrival.terminator
            stream.push(packet)
        }
        for index in block.indices { block[index] = 0 }
        block.withUnsafeMutableBufferPointer { _ = stream.mix(into: $0.baseAddress!, frames: $0.count, masterGain: 1) }
        output += block
        time += 480
    }
    return output
}

func userStreamChecks() throws {
    // Concealment keeps time: a gap of 1 to 3 packets is filled exactly, for every Mumble packet length.
    for milliseconds in [10, 20, 40, 60] {
        for lost in 1...3 {
            let units = milliseconds / 10
            let last = (lost + 1) * units
            let output = render(try UserStream(session: 1), [Arrival(at: 0, frame: 0, units: units),
                                                             Arrival(at: 0, frame: UInt64(last), units: units, terminator: true)],
                                until: 48_000)
            let played = output.lastIndex { $0 != 0 }! + 1
            // Then the fade-out, whose last sample reaches zero.
            check(played == (lost + 2) * milliseconds * 48 + JitterBuffer.rampSamples - 1, "\(milliseconds) ms, \(lost) lost: played \(played)")
        }
    }

    // End to end, the output never jumps: bursts, a stall, losses and two utterances, all at a constant level.
    let speaker = try UserStream(session: 1)
    var arrivals = stream(frames: stride(from: 0, to: 1000, by: 2), units: 2) { frame in
        (100..<150).contains(frame) ? (150 - frame) * 480 + 240 : bursts(frame)
    }.filter { $0.frame % 34 != 0 || $0.frame == 0 }
    arrivals += stream(frames: stride(from: 0, to: 200, by: 6), units: 6).map { var a = $0; a.at += 48 * 12_000; return a }
    OpusDecoderWrapper.calls = []
    let output = render(speaker, arrivals, until: 48 * 16_000)
    var largest: Float = 0
    for index in 1..<output.count { largest = max(largest, abs(output[index] - output[index - 1])) }
    let allowed = OpusDecoderWrapper.level * Float.pi / 2 / Float(JitterBuffer.rampSamples) * 1.01
    check(largest <= allowed, "output jumped by \(largest), allowed \(allowed)")
    check(output.first == 0 && output.last == 0, "output does not start and end silent")
    check(OpusDecoderWrapper.calls.contains { $0.hasPrefix("fec") } && OpusDecoderWrapper.calls.contains { $0.hasPrefix("plc") },
          "losses were not concealed and recovered")
    check(OpusDecoderWrapper.calls.filter { $0 == "reset" }.count == 2, "decoder not reset once per utterance")
    let summary = speaker.diagnosticsSummary(now: 100)
    check(summary?.contains("fec") == true && summary?.contains("underruns") == true, "diagnostics: \(summary ?? "nil")")
    check(speaker.diagnosticsSummary(now: 101) == nil, "diagnostics not quiet once reported")
    print("PASS: playout keeps time across losses and never steps the output gain")
}

@main struct AudioProbe {
    static func main() throws {
        jitterBufferChecks()
        try userStreamChecks()
    }
}
