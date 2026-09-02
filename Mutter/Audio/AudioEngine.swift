import Foundation
import AVFoundation
import Observation
import os
import MumbleProtocol
import MumbleClient

enum TransmitMode: String, Codable, CaseIterable, Identifiable {
    case pushToTalk
    case voiceActivity
    case continuous

    var id: String { rawValue }

    var title: String {
        switch self {
        case .pushToTalk: return "Push to talk"
        case .voiceActivity: return "Voice activity"
        case .continuous: return "Always on"
        }
    }

    var symbol: String {
        switch self {
        case .pushToTalk: return "hand.tap"
        case .voiceActivity: return "waveform"
        case .continuous: return "mic.fill"
        }
    }
}

enum AudioRoute: String, Codable, CaseIterable, Identifiable {
    case earpiece
    case speaker
    case bluetooth

    var id: String { rawValue }

    var title: String {
        switch self {
        case .earpiece: return "Phone"
        case .speaker: return "Speaker"
        case .bluetooth: return "Bluetooth"
        }
    }

    var symbol: String {
        switch self {
        case .earpiece: return "iphone.gen3"
        case .speaker: return "speaker.wave.3.fill"
        case .bluetooth: return "headphones"
        }
    }
}

/// Captures the microphone, encodes Opus packets for the client, and plays back remote users.
@Observable
final class AudioEngine: VoiceSink {
    // Observed by the UI (updated on main, ~20 Hz).
    private(set) var inputLevelDb: Float = -80
    private(set) var isTransmitting = false
    private(set) var isRunning = false
    private(set) var lastError: String?
    private(set) var currentRoute: String = ""
    /// Estimated ambient noise level in dB, tracked while the gate is closed.
    private(set) var noiseFloorDb: Float = -60
    /// The threshold the gate is actually using (auto or manual).
    private(set) var effectiveThresholdDb: Float = -38

    // Configuration
    var transmitMode: TransmitMode = .voiceActivity { didSet { updateGate(force: true) } }
    var vadThresholdDb: Float = -38
    /// Derive the gate threshold from the measured noise floor instead of the manual slider.
    var autoSensitivity = true
    /// Apple's voice processing I/O: echo cancellation, automatic gain, and the system
    /// Voice Isolation mic mode. Changing it rebuilds the audio graph.
    var useVoiceProcessing = true { didSet { if oldValue != useVoiceProcessing { rebuildIfRunning() } } }
    var noiseSuppression: NoiseSuppressor.Level = .strong { didSet { processingQueue.async { self.suppressor?.level = self.noiseSuppression } } }
    var bitrate: Int32 = 40_000 { didSet { encoder?.setBitrate(bitrate) } }
    var frameMilliseconds: Int = 20
    var isPushToTalkPressed = false { didSet { updateGate(force: false) } }
    var isMuted = false { didSet { updateGate(force: true) } }
    var isDeafened = false
    var outputGain: Float = 1.0
    var route: AudioRoute = .speaker { didSet { applyOutputRoute() } }
    /// Mix with other apps' audio instead of fighting over the session. This is what lets a
    /// video or music app play without interrupting the call (and vice versa).
    var mixWithOthers = true { didSet { applyOutputRoute() } }
    /// Voice target for outgoing packets: `.normal` for the channel, 1 for the whisper/shout target.
    var transmitTarget: VoiceTargetID = .normal

    /// Encoded packets ready for the network. Called on the audio processing queue.
    var onEncodedPacket: ((Data, Int, Bool, VoiceTargetID) -> Void)?
    var onTransmitChanged: ((Bool) -> Void)?

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var encoder: OpusEncoderWrapper?
    @ObservationIgnored private var converter: AVAudioConverter?
    @ObservationIgnored private let processingQueue = DispatchQueue(label: "mutter.audio.encode", qos: .userInteractive)
    @ObservationIgnored private var pending: [Float] = []
    @ObservationIgnored private var gateOpen = false
    @ObservationIgnored private var lastVoiceAt: TimeInterval = 0
    @ObservationIgnored private var sendTerminator = false
    @ObservationIgnored private var streams: [UInt32: UserStream] = [:]
    @ObservationIgnored private var streamsLock = os_unfair_lock()
    @ObservationIgnored private var sourceNode: AVAudioSourceNode?
    @ObservationIgnored private var levelTick = 0
    @ObservationIgnored private var localVolumes: [UInt32: Float] = [:]
    @ObservationIgnored private var suppressor: NoiseSuppressor? = NoiseSuppressor()
    @ObservationIgnored private var floorDb: Float = -60
    @ObservationIgnored private var openFrames = 0

    private static let format48kMono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!

    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            self?.handleInterruption(note)
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            self?.handleRouteChange(note)
        })
    }

    deinit {
        for o in observers { NotificationCenter.default.removeObserver(o) }
    }

    // MARK: - Lifecycle

    func start() {
        guard !isRunning else { return }
        do {
            try configureSession()
            encoder = try OpusEncoderWrapper(bitrate: bitrate)
            try buildGraph()
            try engine.start()
            isRunning = true
            lastError = nil
            refreshRoute()
        } catch {
            DiagnosticsLog.shared.add("audio", "engine start failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
            isRunning = false
        }
    }

    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        if let sourceNode { engine.detach(sourceNode) }
        sourceNode = nil
        encoder = nil
        converter = nil
        pending = []
        processingQueue.async { self.suppressor?.reset() }
        isRunning = false
        gateOpen = false
        isTransmitting = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Bluetooth is only in the category options when the user picked it, so "Earpiece"
    /// and "Speaker" stay put even while a headset is connected.
    private var categoryOptions: AVAudioSession.CategoryOptions {
        var options: AVAudioSession.CategoryOptions
        switch route {
        case .bluetooth: options = [.allowBluetooth, .allowBluetoothA2DP]
        case .speaker: options = [.defaultToSpeaker]
        case .earpiece: options = []
        }
        if mixWithOthers { options.insert(.mixWithOthers) }
        return options
    }

    /// Restarts a paused engine after an interruption or on returning to the foreground.
    func ensureRunning() {
        guard isRunning else { return }
        if !engine.isRunning {
            DiagnosticsLog.shared.add("audio", "resuming engine")
            try? AVAudioSession.sharedInstance().setActive(true)
            try? engine.start()
        }
    }

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: categoryOptions)
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.01)
        try session.setActive(true)
    }

    private func applyOutputRoute() {
        guard isRunning else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: categoryOptions)
        try? session.overrideOutputAudioPort(route == .speaker ? .speaker : .none)
        refreshRoute()
    }

    private func rebuildIfRunning() {
        guard isRunning else { return }
        stop()
        start()
    }

    private func buildGraph() throws {
        let input = engine.inputNode
        // Must happen before the tap is installed and before the engine starts.
        do {
            try input.setVoiceProcessingEnabled(useVoiceProcessing)
        } catch {
            // Some simulators and devices refuse; carry on without it.
        }
        if useVoiceProcessing {
            input.isVoiceProcessingBypassed = false
            if #available(iOS 17.0, *) {
                input.isVoiceProcessingAGCEnabled = true
            }
        }
        let hardwareFormat = input.outputFormat(forBus: 0)
        guard hardwareFormat.sampleRate > 0 else { throw NSError(domain: "Mutter", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone available."]) }
        converter = AVAudioConverter(from: hardwareFormat, to: AudioEngine.format48kMono)

        input.removeTap(onBus: 0)
        let tapFrames = AVAudioFrameCount(hardwareFormat.sampleRate * 0.02)
        input.installTap(onBus: 0, bufferSize: tapFrames, format: hardwareFormat) { [weak self] buffer, _ in
            self?.handleInput(buffer)
        }

        let source = AVAudioSourceNode(format: AudioEngine.format48kMono) { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
            guard let self else { return noErr }
            let abl = UnsafeMutableAudioBufferListPointer(audioBufferList)
            guard let buf = abl.first?.mData else { return noErr }
            let out = buf.assumingMemoryBound(to: Float.self)
            let n = Int(frameCount)
            for i in 0..<n { out[i] = 0 }
            self.render(into: out, frames: n)
            return noErr
        }
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: AudioEngine.format48kMono)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
        sourceNode = source
        engine.prepare()
    }

    // MARK: - Capture path

    private func handleInput(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = 48_000.0 / buffer.format.sampleRate
        let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: AudioEngine.format48kMono, frameCapacity: outCapacity) else { return }
        var consumed = false
        var error: NSError?
        _ = converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, out.frameLength > 0, let channel = out.floatChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
        processingQueue.async { [weak self] in self?.process(samples) }
    }

    private func process(_ samples: [Float]) {
        let cleaned = suppressor?.process(samples) ?? samples
        pending.append(contentsOf: cleaned)
        let frameSize = 48 * frameMilliseconds
        while pending.count >= frameSize {
            let frame = Array(pending[0..<frameSize])
            pending.removeFirst(frameSize)
            encodeFrame(frame)
        }
    }

    private func encodeFrame(_ frame: [Float]) {
        // Level metering
        var sum: Float = 0
        for s in frame { sum += s * s }
        let rms = sqrt(sum / Float(frame.count))
        let db = max(-80, 20 * log10(max(rms, 1e-9)))
        levelTick += 1
        if levelTick % 3 == 0 {
            let level = db
            DispatchQueue.main.async { self.inputLevelDb = level }
        }

        // Noise floor: drops instantly to any quieter frame, rises at ~0.5 dB/s while the gate is closed.
        if !gateOpen {
            if db < floorDb { floorDb = db } else { floorDb += 0.01 }
            floorDb = min(max(floorDb, -80), -20)
        }
        let threshold: Float = autoSensitivity ? min(max(floorDb + 12, -60), -15) : vadThresholdDb
        if levelTick % 5 == 0 {
            let f = floorDb, t = threshold
            DispatchQueue.main.async { self.noiseFloorDb = f; self.effectiveThresholdDb = t }
        }

        // Gate decision
        let now = Date().timeIntervalSinceReferenceDate
        var shouldSend: Bool
        switch transmitMode {
        case .pushToTalk:
            shouldSend = isPushToTalkPressed
        case .continuous:
            shouldSend = true
        case .voiceActivity:
            // Open after two consecutive loud frames (kills single clicks), close 350 ms after the last one.
            if db >= threshold {
                openFrames += 1
                if openFrames >= 2 || gateOpen { lastVoiceAt = now }
            } else {
                openFrames = 0
            }
            shouldSend = now - lastVoiceAt < 0.35
        }
        if isMuted { shouldSend = false }

        if shouldSend != gateOpen {
            gateOpen = shouldSend
            if !shouldSend { sendTerminator = true }
            let open = shouldSend
            DispatchQueue.main.async {
                self.isTransmitting = open
                self.onTransmitChanged?(open)
            }
        }

        guard let encoder, gateOpen || sendTerminator else { return }
        let terminator = !gateOpen && sendTerminator
        sendTerminator = false
        let packet: Data
        do {
            packet = try frame.withUnsafeBufferPointer { try encoder.encode($0.baseAddress!, frameSize: frame.count) }
        } catch {
            return
        }
        onEncodedPacket?(packet, frame.count / 480, terminator, transmitTarget)
        if terminator { encoder.reset() }
    }

    private func updateGate(force: Bool) {
        // Gate changes are evaluated per frame in encodeFrame; nothing else to do here.
        _ = force
    }

    // MARK: - Playback path (VoiceSink)

    func receiveAudio(_ packet: AudioPacket) {
        guard !isDeafened, let sender = packet.senderSession else { return }
        os_unfair_lock_lock(&streamsLock)
        var stream = streams[sender]
        if stream == nil, let s = try? UserStream(session: sender) {
            s.volume = localVolumes[sender] ?? 1.0
            streams[sender] = s
            stream = s
        }
        os_unfair_lock_unlock(&streamsLock)
        stream?.push(packet)
        pruneIdleStreams()
    }

    func voiceStreamsDidReset() {
        os_unfair_lock_lock(&streamsLock)
        streams = [:]
        os_unfair_lock_unlock(&streamsLock)
    }

    func setVolume(_ volume: Float, for session: UInt32) {
        os_unfair_lock_lock(&streamsLock)
        localVolumes[session] = volume
        streams[session]?.volume = volume
        os_unfair_lock_unlock(&streamsLock)
    }

    private var pruneCounter = 0
    private func pruneIdleStreams() {
        pruneCounter += 1
        guard pruneCounter % 200 == 0 else { return }
        os_unfair_lock_lock(&streamsLock)
        for (k, s) in streams where s.isIdle { streams[k] = nil }
        os_unfair_lock_unlock(&streamsLock)
    }

    private func render(into out: UnsafeMutablePointer<Float>, frames: Int) {
        guard !isDeafened else { return }
        os_unfair_lock_lock(&streamsLock)
        let active = Array(streams.values)
        os_unfair_lock_unlock(&streamsLock)
        for s in active { s.mix(into: out, frames: frames, masterGain: outputGain) }
        // Soft limiter: transparent below 0.8, then rounds off instead of clipping (which sounds like static).
        for i in 0..<frames {
            let v = out[i]
            let a = abs(v)
            if a > 0.8 {
                let over = a - 0.8
                let limited = 0.8 + 0.2 * (1 - exp(-over / 0.2))
                out[i] = v < 0 ? -limited : limited
            }
        }
    }

    // MARK: - Session events

    private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            DiagnosticsLog.shared.add("audio", "interruption began (another app took the audio session)")
            engine.pause()
        case .ended:
            let optionsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            DiagnosticsLog.shared.add("audio", "interruption ended (shouldResume: \(options.contains(.shouldResume)))")
            if options.contains(.shouldResume) || isRunning {
                try? AVAudioSession.sharedInstance().setActive(true)
                try? engine.start()
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ note: Notification) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isRunning else { return }
            // Input format may change with the route; rebuild the tap/converter.
            self.engine.inputNode.removeTap(onBus: 0)
            if let sourceNode = self.sourceNode {
                self.engine.disconnectNodeOutput(sourceNode)
                self.engine.detach(sourceNode)
                self.sourceNode = nil
            }
            try? self.buildGraph()
            if !self.engine.isRunning { try? self.engine.start() }
            self.refreshRoute()
        }
    }

    private func refreshRoute() {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        let newRoute = outputs.map { $0.portName }.joined(separator: ", ")
        if newRoute != currentRoute {
            DiagnosticsLog.shared.add("audio", "output route → \(newRoute.isEmpty ? "none" : newRoute)")
        }
        currentRoute = newRoute
    }
}
