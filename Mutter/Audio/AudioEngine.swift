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

/// Where sound goes when no headset is connected.
enum AudioRoute: String, Codable, CaseIterable, Identifiable {
    case earpiece
    case speaker

    var id: String { rawValue }

    var title: String {
        switch self {
        case .earpiece: return "iPhone"
        case .speaker: return "Speaker"
        }
    }

    var symbol: String {
        switch self {
        case .earpiece: return "iphone.gen3"
        case .speaker: return "speaker.wave.3.fill"
        }
    }
}

/// A place sound can go, listed the way the Phone app lists them: the
/// iPhone itself, the loudspeaker, and each connected headset by its name.
struct AudioOutput: Identifiable, Hashable {
    enum Kind: Hashable {
        case phone
        case speaker
        case device(uid: String)
    }

    let kind: Kind
    let title: String
    let symbol: String
    var id: Kind { kind }

    static let phone = AudioOutput(kind: .phone, title: AudioRoute.earpiece.title, symbol: AudioRoute.earpiece.symbol)
    static let speaker = AudioOutput(kind: .speaker, title: AudioRoute.speaker.title, symbol: AudioRoute.speaker.symbol)
}

@Observable
final class AudioEngine: VoiceSink {
    private(set) var inputLevelDb: Float = -80
    private(set) var isTransmitting = false
    private(set) var isRunning = false
    private(set) var lastError: String?
    private(set) var currentRoute: String = ""
    private(set) var outputs: [AudioOutput] = [.phone, .speaker]
    private(set) var activeOutput: AudioOutput.Kind = .speaker
    private(set) var noiseFloorDb: Float = -60
    private(set) var effectiveThresholdDb: Float = -38

    var transmitMode: TransmitMode = .voiceActivity
    var vadThresholdDb: Float = -38
    var autoSensitivity = true
    var useVoiceProcessing = true { didSet { if oldValue != useVoiceProcessing { rebuildIfRunning() } } }
    var noiseSuppression: NoiseSuppressor.Level = .strong { didSet { processingQueue.async { self.suppressor?.level = self.noiseSuppression } } }
    var bitrate: Int32 = 40_000 {
        didSet {
            let updated = bitrate
            processingQueue.async { self.encoder?.setBitrate(updated) }
        }
    }
    var frameMilliseconds: Int = 20
    var isPushToTalkPressed = false
    var isMuted = false
    var isDeafened = false
    var outputGain: Float = 1.0
    var route: AudioRoute = .speaker {
        didSet {
            selectedDeviceUID = nil
            applyOutputRoute()
        }
    }
    var mixWithOthers = true { didSet { applyOutputRoute(); applyOtherAudioDucking() } }
    var transmitTarget: VoiceTargetID = .normal

    var onEncodedPacket: ((Data, Int, Bool, VoiceTargetID) -> Void)?
    var onTransmitChanged: ((Bool) -> Void)?

    @ObservationIgnored private var engine = AVAudioEngine()
    @ObservationIgnored private var encoder: OpusEncoderWrapper?
    @ObservationIgnored private let processingQueue = DispatchQueue(label: "mutter.audio.encode", qos: .userInteractive)
    @ObservationIgnored private var pending: [Float] = []
    @ObservationIgnored private var gateOpen = false
    @ObservationIgnored private var lastVoiceAt: TimeInterval = 0
    @ObservationIgnored private var sendTerminator = false
    @ObservationIgnored private var streams: [UInt32: UserStream] = [:]
    @ObservationIgnored private var renderedStreams: [UserStream] = []
    @ObservationIgnored private let streamsLock = OSAllocatedUnfairLock()
    @ObservationIgnored private var lastPruneAt = Date()
    @ObservationIgnored private var sourceNode: AVAudioSourceNode?
    @ObservationIgnored private var levelTick = 0
    @ObservationIgnored private var localVolumes: [UInt32: Float] = [:]
    @ObservationIgnored private var suppressor: NoiseSuppressor? = NoiseSuppressor()
    @ObservationIgnored private var floorDb: Float = -60
    @ObservationIgnored private var openFrames = 0
    @ObservationIgnored private var isRebuilding = false
    /// The headset chosen for this call; nil means `route`.
    @ObservationIgnored private var selectedDeviceUID: String?
    @ObservationIgnored private var knownDeviceUIDs: Set<String> = []
    @ObservationIgnored private var rebuildScheduled = false
    @ObservationIgnored private var playoutDiagnostics: DispatchSourceTimer?

    private static let format48kMono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 1, interleaved: false)!
    private static let maximumStreamCount = 64
    private static let pruneInterval: TimeInterval = 2
    private static let retiredStreamGracePeriod: TimeInterval = 1

    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var configurationObserver: NSObjectProtocol?

    init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            self?.handleInterruption(note)
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            self?.handleRouteChange(note)
        })
        observeConfigurationChanges()
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
    }

    private func observeConfigurationChanges() {
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.scheduleRebuild(reason: "engine configuration changed")
        }
    }

    func start() {
        guard !isRunning else { return }
        do {
            try configureSession()
            let freshEncoder = try OpusEncoderWrapper(bitrate: bitrate)
            processingQueue.sync { installCaptureState(encoder: freshEncoder) }
            try buildGraph()
            try engine.start()
            isRunning = true
            lastError = nil
            // A headset already connected takes the call, as it would a phone call.
            if selectedDeviceUID == nil { selectedDeviceUID = Self.headsetInputs().first?.uid }
            applyOutputRoute()
            startPlayoutDiagnostics()
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
        playoutDiagnostics?.cancel()
        playoutDiagnostics = nil
        processingQueue.async { self.installCaptureState(encoder: nil) }
        isRunning = false
        isTransmitting = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Reads each stream's playout counters once a second, off the render thread, so a crackle heard on a
    /// device can be matched to an underrun, a loss or a skip in the exported log.
    private func startPlayoutDiagnostics() {
        playoutDiagnostics?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(200))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let now = ProcessInfo.processInfo.systemUptime
            for stream in withStreams({ Array(self.streams.values) }) {
                if let summary = stream.diagnosticsSummary(now: now) { DiagnosticsLog.shared.add("audio", summary) }
            }
        }
        timer.resume()
        playoutDiagnostics = timer
    }

    private func installCaptureState(encoder freshEncoder: OpusEncoderWrapper?) {
        encoder = freshEncoder
        pending = []
        gateOpen = false
        sendTerminator = false
        openFrames = 0
        suppressor?.reset()
    }

    // Bluetooth is always allowed: iOS only lists a connected headset, and
    // only plays to it, when the category allows it.
    private var categoryOptions: AVAudioSession.CategoryOptions {
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP]
        if route == .speaker { options.insert(.defaultToSpeaker) }
        if mixWithOthers { options.insert(.mixWithOthers) }
        return options
    }

    /// Plays through a connected headset for this call, or nil for `route`.
    func useDevice(_ uid: String?) {
        selectedDeviceUID = uid
        applyOutputRoute()
    }

    private static let headsetPortTypes: Set<AVAudioSession.Port> = [.bluetoothHFP, .bluetoothLE, .headsetMic, .carAudio, .usbAudio]

    private static func headsetInputs() -> [AVAudioSessionPortDescription] {
        (AVAudioSession.sharedInstance().availableInputs ?? []).filter { headsetPortTypes.contains($0.portType) }
    }

    private static func symbol(for port: AVAudioSession.Port) -> String {
        switch port {
        case .carAudio: return "car.fill"
        case .usbAudio: return "cable.connector"
        case .HDMI, .airPlay: return "tv"
        default: return "headphones"
        }
    }

    func ensureRunning() {
        guard isRunning, !isRebuilding else { return }
        let session = AVAudioSession.sharedInstance()
        if !session.isOtherAudioPlaying || !engine.isRunning {
            try? session.setActive(true)
        }
        if !engine.isRunning || engine.outputNode.outputFormat(forBus: 0).sampleRate == 0 {
            rebuildGraph(reason: "playback was dead")
        }
    }

    private func scheduleRebuild(reason: String) {
        guard isRunning, !isRebuilding, !rebuildScheduled else { return }
        rebuildScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            self.rebuildScheduled = false
            self.rebuildGraph(reason: reason)
        }
    }

    private func rebuildGraph(reason: String = "recovery") {
        guard isRunning, !isRebuilding else { return }
        isRebuilding = true
        DiagnosticsLog.shared.add("audio", "rebuilding graph (\(reason))")
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        if let sourceNode {
            engine.disconnectNodeOutput(sourceNode)
            engine.detach(sourceNode)
            self.sourceNode = nil
        }
        do {
            try buildGraph()
            try engine.start()
            lastError = nil
            refreshRoute()
        } catch {
            DiagnosticsLog.shared.add("audio", "rebuild failed: \(error.localizedDescription)")
            lastError = error.localizedDescription
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.isRebuilding = false
        }
    }

    // Voice chat mode asks the system for its own echo cancellation, which only pairs with the
    // voice-processing I/O unit; without it, default mode keeps playback on the plain output.
    private var sessionMode: AVAudioSession.Mode { useVoiceProcessing ? .voiceChat : .default }

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: sessionMode, options: categoryOptions)
        try session.setPreferredSampleRate(48_000)
        try session.setPreferredIOBufferDuration(0.01)
        try session.setActive(true)
    }

    private func applyOutputRoute() {
        guard isRunning else { return }
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: sessionMode, options: categoryOptions)
        if let uid = selectedDeviceUID {
            try? session.overrideOutputAudioPort(.none)
            // A headset with a microphone is chosen through its input; one
            // without (A2DP-only) is where iOS plays once nothing is preferred.
            try? session.setPreferredInput(session.availableInputs?.first { $0.uid == uid })
        } else {
            // Preferring the built-in microphone keeps sound on the iPhone even
            // with a headset connected, as choosing iPhone in the Phone app does.
            try? session.setPreferredInput(session.availableInputs?.first { $0.portType == .builtInMic })
            try? session.overrideOutputAudioPort(route == .speaker ? .speaker : .none)
        }
        refreshRoute()
    }

    // The voice-processing I/O unit replaces both input and output. Switching it on a running
    // engine leaves the mixer wired to the old output format and playback goes silent, so a
    // change of voice processing starts over with a fresh engine.
    private func rebuildIfRunning() {
        guard isRunning else { return }
        DiagnosticsLog.shared.add("audio", "voice processing \(useVoiceProcessing ? "on" : "off"), restarting engine")
        stop()
        engine = AVAudioEngine()
        observeConfigurationChanges()
        start()
    }

    private func applyOtherAudioDucking() {
        guard #available(iOS 17.0, *), engine.inputNode.isVoiceProcessingEnabled else { return }
        // This controls other apps, independently of the session mixing option.
        // Keep echo cancellation, noise suppression and AGC enabled.
        engine.inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(
            enableAdvancedDucking: ObjCBool(mixWithOthers), duckingLevel: mixWithOthers ? .min : .default)
    }

    private func buildGraph() throws {
        let input = engine.inputNode
        if input.isVoiceProcessingEnabled != useVoiceProcessing {
            do {
                try input.setVoiceProcessingEnabled(useVoiceProcessing)
            } catch {
                DiagnosticsLog.shared.add("audio", "could not turn voice processing \(useVoiceProcessing ? "on" : "off"): \(error.localizedDescription)")
            }
        }
        if useVoiceProcessing {
            input.isVoiceProcessingBypassed = false
            if #available(iOS 17.0, *) {
                input.isVoiceProcessingAGCEnabled = true
            }
        }
        applyOtherAudioDucking()
        let hardwareFormat = input.outputFormat(forBus: 0)
        guard hardwareFormat.sampleRate > 0,
              let converter = AVAudioConverter(from: hardwareFormat, to: AudioEngine.format48kMono) else {
            throw NSError(domain: "Mutter", code: 1, userInfo: [NSLocalizedDescriptionKey: "No microphone available."])
        }

        input.removeTap(onBus: 0)
        let tapFrames = AVAudioFrameCount(hardwareFormat.sampleRate * 0.02)
        input.installTap(onBus: 0, bufferSize: tapFrames, format: hardwareFormat) { [weak self] buffer, _ in
            self?.handleInput(buffer, converter: converter)
        }

        let source = AVAudioSourceNode(format: AudioEngine.format48kMono) { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
            guard let self else { return noErr }
            let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
            guard let data = buffers.first?.mData else { return noErr }
            let output = data.assumingMemoryBound(to: Float.self)
            let frames = Int(frameCount)
            for index in 0..<frames { output[index] = 0 }
            self.render(into: output, frames: frames)
            return noErr
        }
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: AudioEngine.format48kMono)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
        sourceNode = source
        engine.prepare()
    }

    private func handleInput(_ buffer: AVAudioPCMBuffer, converter: AVAudioConverter) {
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
        var sum: Float = 0
        for sample in frame { sum += sample * sample }
        let rms = sqrt(sum / Float(frame.count))
        let db = max(-80, 20 * log10(max(rms, 1e-9)))
        levelTick += 1
        if levelTick % 3 == 0 {
            let level = db
            DispatchQueue.main.async { self.inputLevelDb = level }
        }

        if !gateOpen {
            if db < floorDb { floorDb = db } else { floorDb += 0.01 }
            floorDb = min(max(floorDb, -80), -20)
        }
        let threshold: Float = autoSensitivity ? min(max(floorDb + 12, -60), -15) : vadThresholdDb
        if levelTick % 5 == 0 {
            let floorSnapshot = floorDb
            let thresholdSnapshot = threshold
            DispatchQueue.main.async {
                self.noiseFloorDb = floorSnapshot
                self.effectiveThresholdDb = thresholdSnapshot
            }
        }

        let now = Date().timeIntervalSinceReferenceDate
        var shouldSend: Bool
        switch transmitMode {
        case .pushToTalk:
            shouldSend = isPushToTalkPressed
        case .continuous:
            shouldSend = true
        case .voiceActivity:
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

    private func withStreams<Result>(_ body: () -> Result) -> Result {
        streamsLock.lock()
        defer { streamsLock.unlock() }
        return body()
    }

    func receiveAudio(_ packet: AudioPacket) {
        guard !isDeafened, let sender = packet.senderSession else { return }
        pruneIdleStreamsIfDue()
        guard let stream = existingStream(for: sender) ?? addStream(for: sender) else { return }
        stream.push(packet)
    }

    private func existingStream(for sender: UInt32) -> UserStream? {
        withStreams { streams[sender] }
    }

    private func addStream(for sender: UInt32) -> UserStream? {
        if withStreams({ streams.count }) >= Self.maximumStreamCount {
            pruneIdleStreams()
            guard withStreams({ streams.count }) < Self.maximumStreamCount else { return nil }
        }
        guard let created = try? UserStream(session: sender) else { return nil }
        let previousSnapshot = withStreams { () -> [UserStream] in
            created.volume = localVolumes[sender] ?? 1.0
            streams[sender] = created
            return publishRenderedStreams()
        }
        releaseAwayFromRenderThread([previousSnapshot])
        return created
    }

    func voiceStreamsDidReset() {
        let retired = withStreams { () -> [[UserStream]] in
            let removed = Array(streams.values)
            streams = [:]
            return [removed, publishRenderedStreams()]
        }
        releaseAwayFromRenderThread(retired)
    }

    func setVolume(_ volume: Float, for session: UInt32) {
        withStreams {
            localVolumes[session] = volume
            streams[session]?.volume = volume
        }
    }

    private func pruneIdleStreamsIfDue() {
        guard Date().timeIntervalSince(lastPruneAt) >= Self.pruneInterval else { return }
        pruneIdleStreams()
    }

    private func pruneIdleStreams() {
        lastPruneAt = Date()
        let candidates = withStreams { streams }
        let idleSessions = candidates.filter { $0.value.isIdle }.map(\.key)
        guard !idleSessions.isEmpty else { return }
        let retired = withStreams { () -> [[UserStream]] in
            var removed: [UserStream] = []
            for session in idleSessions {
                if let stream = streams.removeValue(forKey: session) { removed.append(stream) }
            }
            return [removed, publishRenderedStreams()]
        }
        releaseAwayFromRenderThread(retired)
    }

    private func publishRenderedStreams() -> [UserStream] {
        let previous = renderedStreams
        renderedStreams = Array(streams.values)
        return previous
    }

    private func releaseAwayFromRenderThread(_ retired: [[UserStream]]) {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + Self.retiredStreamGracePeriod) {
            withExtendedLifetime(retired) {}
        }
    }

    private func render(into out: UnsafeMutablePointer<Float>, frames: Int) {
        guard !isDeafened else { return }
        let active = withStreams { renderedStreams }
        for stream in active { stream.mix(into: out, frames: frames, masterGain: outputGain) }
        for index in 0..<frames {
            let sample = out[index]
            let magnitude = abs(sample)
            if magnitude > 0.8 {
                let over = magnitude - 0.8
                let limited = 0.8 + 0.2 * (1 - exp(-over / 0.2))
                out[index] = sample < 0 ? -limited : limited
            }
        }
    }

    private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            DiagnosticsLog.shared.add("audio", "interruption began (another app took the audio session)")
            engine.pause()
        case .ended:
            guard isRunning else { return }
            let optionsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
            DiagnosticsLog.shared.add("audio", "interruption ended (shouldResume: \(options.contains(.shouldResume)))")
            guard options.contains(.shouldResume) else { return }
            try? AVAudioSession.sharedInstance().setActive(true)
            scheduleRebuild(reason: "interruption ended")
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ note: Notification) {
        let reasonValue = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue)
        if isRunning {
            if reason == .newDeviceAvailable, let added = Self.headsetInputs().first(where: { !knownDeviceUIDs.contains($0.uid) }) {
                // A headset that connects mid-call takes the sound, like a phone call.
                DiagnosticsLog.shared.add("audio", "headset connected: \(added.portName)")
                useDevice(added.uid)
            } else if reason == .oldDeviceUnavailable {
                // Back to iPhone or Speaker when the chosen headset goes away;
                // reapplied either way, since iOS falls back to the earpiece.
                useDevice(selectedDeviceUID.flatMap { isConnected($0) ? $0 : nil })
            } else {
                refreshRoute()
            }
        }
        guard !isRebuilding else { return }
        scheduleRebuild(reason: "route changed")
    }

    private func isConnected(_ uid: String) -> Bool {
        let session = AVAudioSession.sharedInstance()
        return (session.availableInputs ?? []).contains { $0.uid == uid } || session.currentRoute.outputs.contains { $0.uid == uid }
    }

    private func refreshRoute() {
        let session = AVAudioSession.sharedInstance()
        let playing = session.currentRoute.outputs
        let newRoute = playing.map { $0.portName }.joined(separator: ", ")
        if newRoute != currentRoute {
            DiagnosticsLog.shared.add("audio", "output route → \(newRoute.isEmpty ? "none" : newRoute)")
        }
        currentRoute = newRoute

        var devices = Self.headsetInputs().map { AudioOutput(kind: .device(uid: $0.uid), title: $0.portName, symbol: Self.symbol(for: $0.portType)) }
        let active: AudioOutput.Kind
        switch playing.first?.portType {
        case .builtInReceiver?: active = .phone
        case .builtInSpeaker?: active = .speaker
        case nil: active = route == .speaker ? .speaker : .phone
        case let port?:
            // Headphones without a microphone, or a Bluetooth speaker, are
            // only visible as where sound is playing.
            let output = playing[0]
            if let match = devices.first(where: { $0.kind == .device(uid: output.uid) || $0.title == output.portName }) {
                active = match.kind
            } else {
                let device = AudioOutput(kind: .device(uid: output.uid), title: output.portName, symbol: Self.symbol(for: port))
                devices.append(device)
                active = device.kind
            }
        }
        knownDeviceUIDs = Set(devices.compactMap { if case .device(let uid) = $0.kind { return uid } else { return nil } })
        outputs = [.phone, .speaker] + devices
        if activeOutput != active { activeOutput = active }
    }
}
