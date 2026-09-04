import Foundation
import Observation
import WebRTC
import MumbleClient
import MumbleProtocol

/// A share someone in the channel has announced.
struct ActiveShare: Identifiable, Equatable {
    let id: String
    let sender: UInt32
    var title: String
    var width: Int
    var height: Int
    var hasAudio: Bool
    var lastSeen: Date
}

struct ShareStats: Equatable {
    var width = 0, height = 0
    var fps = 0
    var kbps = 0
    var codec = ""
    var summary: String {
        var parts: [String] = []
        if width > 0 { parts.append("\(width)×\(height)") }
        if fps > 0 { parts.append("\(fps) fps") }
        if kbps > 0 { parts.append(kbps >= 1000 ? String(format: "%.1f Mbps", Double(kbps) / 1000) : "\(kbps) kbps") }
        if !codec.isEmpty { parts.append(codec) }
        return parts.joined(separator: " · ")
    }
}

/// Watches screen shares announced over the plugin channel. Viewer only for now: iOS receives
/// a WebRTC stream from a sharer (Mutter Web, or another Mutter) — sharing from the phone
/// itself needs a ReplayKit broadcast extension and comes later.
@MainActor
@Observable
final class ScreenShareModel: NSObject {
    private(set) var shares: [String: ActiveShare] = [:]
    private(set) var watching: ActiveShare?
    private(set) var videoTrack: RTCVideoTrack?
    private(set) var stats = ShareStats()
    private(set) var connectionState = "Connecting…"
    private(set) var error: String?

    var turnServer: (url: String, username: String, password: String)?

    @ObservationIgnored private let client: MumbleClient
    @ObservationIgnored private let sender: SignalSender
    @ObservationIgnored private let reassembler = SignalReassembler()
    @ObservationIgnored private var pc: RTCPeerConnection?
    @ObservationIgnored private var expiryTimer: Timer?
    @ObservationIgnored private var statsTimer: Timer?
    @ObservationIgnored private var lastBytes: UInt64 = 0
    /// Trickled candidates that arrive before the offer is applied; flushed once it is.
    @ObservationIgnored private var pendingICE: [ICECandidateInit] = []
    @ObservationIgnored private var remoteDescriptionSet = false
    @ObservationIgnored private var lastStatsAt = Date()

    /// One factory for the app. WebRTC must never touch the audio session: Mutter's own engine
    /// owns it, and we only receive video here.
    @ObservationIgnored private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        RTCAudioSession.sharedInstance().useManualAudio = true
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    init(client: MumbleClient) {
        self.client = client
        self.sender = SignalSender(client: client)
        super.init()
        expiryTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.expireStale() }
        }
    }

    /// Sessions currently sharing, for badges in the channel tree.
    var sharingSessions: Set<UInt32> { Set(shares.values.map(\.sender)) }
    var availableShares: [ActiveShare] { shares.values.sorted { $0.lastSeen > $1.lastSeen } }
    func share(from session: UInt32) -> ActiveShare? { shares.values.first { $0.sender == session } }

    // MARK: - Inbound signaling

    func handle(_ p: PluginDataTransmissionMessage) {
        guard p.dataId == RTCSignal.dataId, let from = p.senderSession,
              let msg = reassembler.receive(from: from, data: p.data) else { return }
        switch msg.t {
        case "announce":
            let share = ActiveShare(id: msg.id, sender: from, title: msg.title ?? client.session.users[from]?.name ?? "Screen",
                                    width: msg.w ?? 0, height: msg.h ?? 0, hasAudio: msg.audio ?? false, lastSeen: Date())
            let isNew = shares[msg.id] == nil
            shares[msg.id] = share
            if var w = watching, w.id == msg.id { w.lastSeen = share.lastSeen; watching = w }
            if isNew { DiagnosticsLog.shared.add("share", "\(share.title) announced by session \(from)") }
        case "stop":
            shares[msg.id] = nil
            if watching?.id == msg.id { stopWatching(sendLeave: false); connectionState = "Sharing ended" }
        case "offer":
            guard let w = watching, w.id == msg.id, w.sender == from, let sdp = msg.sdp else { return }
            Task { await accept(offer: sdp, from: from, id: msg.id) }
        case "ice":
            guard watching?.id == msg.id else { return }
            let candidates = msg.c ?? []
            if let pc, remoteDescriptionSet { addCandidates(candidates, to: pc) } else { pendingICE.append(contentsOf: candidates) }
        default:
            break   // watch/answer/leave are sharer-side
        }
    }

    // MARK: - Watching

    func watch(_ share: ActiveShare) {
        if watching != nil { stopWatching(sendLeave: true) }
        watching = share
        error = nil
        stats = ShareStats()
        connectionState = "Connecting…"
        DiagnosticsLog.shared.add("share", "watching \(share.title)")
        sender.send(.watch(share.id), to: [share.sender])
    }

    private func addCandidates(_ candidates: [ICECandidateInit], to pc: RTCPeerConnection) {
        for c in candidates {
            pc.add(RTCIceCandidate(sdp: c.candidate, sdpMLineIndex: c.sdpMLineIndex ?? 0, sdpMid: c.sdpMid)) { error in
                if let error { DiagnosticsLog.shared.add("share", "ice candidate rejected: \(error.localizedDescription)") }
            }
        }
    }

    func stopWatching(sendLeave: Bool = true) {
        pendingICE.removeAll(); remoteDescriptionSet = false
        if let w = watching, sendLeave { sender.send(.leave(w.id), to: [w.sender]) }
        statsTimer?.invalidate(); statsTimer = nil
        pc?.close(); pc = nil
        videoTrack = nil
        watching = nil
    }

    func reset() {
        stopWatching(sendLeave: false)
        shares.removeAll()
        sender.reset()
    }

    private func expireStale() {
        let cutoff = Date().addingTimeInterval(-25)
        let stale = shares.values.filter { $0.lastSeen < cutoff }
        for s in stale {
            shares[s.id] = nil
            if watching?.id == s.id { stopWatching(sendLeave: false); connectionState = "Sharer went away" }
        }
    }

    private func accept(offer sdp: String, from sender: UInt32, id: String) async {
        pc?.close()
        remoteDescriptionSet = false
        let config = RTCConfiguration()
        var ice = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
        if let turn = turnServer, !turn.url.isEmpty {
            ice.append(RTCIceServer(urlStrings: [turn.url], username: turn.username, credential: turn.password))
        }
        config.iceServers = ice
        config.sdpSemantics = .unifiedPlan
        config.bundlePolicy = .maxBundle
        config.rtcpMuxPolicy = .require
        config.continualGatheringPolicy = .gatherOnce
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = Self.factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            error = "Couldn't start the viewer."; return
        }
        self.pc = pc
        let recv = RTCRtpTransceiverInit()
        recv.direction = .recvOnly
        pc.addTransceiver(of: .video, init: recv)

        do {
            try await pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp))
            remoteDescriptionSet = true
            if !pendingICE.isEmpty { addCandidates(pendingICE, to: pc); pendingICE.removeAll() }
            let answer = try await pc.answer(for: constraints)
            try await pc.setLocalDescription(answer)
            // Vanilla ICE: wait until gathering completes or 1.5 s, then send the whole answer.
            let deadline = Date().addingTimeInterval(1.5)
            while pc.iceGatheringState != .complete, Date() < deadline {
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            guard let local = pc.localDescription, watching?.id == id else { return }
            self.sender.send(.answer(id, sdp: local.sdp), to: [sender])
            startStats()
        } catch {
            self.error = error.localizedDescription
            DiagnosticsLog.shared.add("share", "answer failed: \(error.localizedDescription)")
            stopWatching(sendLeave: true)
        }
    }

    private func startStats() {
        statsTimer?.invalidate()
        lastBytes = 0; lastStatsAt = Date()
        statsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sampleStats() }
        }
    }

    private func sampleStats() {
        guard let pc else { return }
        pc.statistics { [weak self] report in
            Task { @MainActor in
                guard let self else { return }
                var s = self.stats
                let all = report.statistics
                for (_, stat) in all where stat.type == "inbound-rtp" && (stat.values["kind"] as? String) == "video" {
                    if let w = stat.values["frameWidth"] as? NSNumber { s.width = w.intValue }
                    if let h = stat.values["frameHeight"] as? NSNumber { s.height = h.intValue }
                    if let f = stat.values["framesPerSecond"] as? NSNumber { s.fps = Int(f.doubleValue.rounded()) }
                    if let b = stat.values["bytesReceived"] as? NSNumber {
                        let bytes = b.uint64Value
                        let dt = Date().timeIntervalSince(self.lastStatsAt)
                        if self.lastBytes > 0, dt > 0 { s.kbps = Int(Double(bytes - self.lastBytes) * 8 / 1000 / dt) }
                        self.lastBytes = bytes; self.lastStatsAt = Date()
                    }
                    if let codecId = stat.values["codecId"] as? String, let codec = all[codecId],
                       let mime = codec.values["mimeType"] as? String {
                        s.codec = mime.replacingOccurrences(of: "video/", with: "")
                    }
                }
                self.stats = s
            }
        }
    }
}

// MARK: - RTCPeerConnectionDelegate

extension ScreenShareModel: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        if let track = stream.videoTracks.first { Task { @MainActor in self.videoTrack = track } }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        let label: String
        switch newState {
        case .checking: label = "Connecting…"
        case .connected, .completed: label = "Live"
        case .disconnected: label = "Reconnecting…"
        case .failed: label = "Connection failed"
        case .closed: label = "Closed"
        default: label = "Connecting…"
        }
        Task { @MainActor in
            self.connectionState = label
            DiagnosticsLog.shared.add("share", "ice → \(label)")
            if newState == .failed { self.error = "Couldn't connect to the sharer. A TURN server may be needed on this network." }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        if let track = rtpReceiver.track as? RTCVideoTrack { Task { @MainActor in self.videoTrack = track } }
    }
}
