import Foundation
import Observation
import WebRTC
import MumbleClient
import MumbleProtocol

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
    var width = 0
    var height = 0
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
    @ObservationIgnored private var peerConnection: RTCPeerConnection?
    @ObservationIgnored private var pruneTimer: Timer?
    @ObservationIgnored private var statsTimer: Timer?
    @ObservationIgnored private var lastBytes: UInt64 = 0
    @ObservationIgnored private var pendingCandidates: [ICECandidateInit] = []
    @ObservationIgnored private var remoteDescriptionSet = false
    @ObservationIgnored private var lastStatsAt = Date()

    private static let gatheringDeadline: TimeInterval = 1.5
    private static let gatheringPollNanoseconds: UInt64 = 50_000_000
    private static let defaultStun = "stun:stun.l.google.com:19302"

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
        pruneTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pruneDepartedSharers() }
        }
    }

    var sharingSessions: Set<UInt32> { Set(shares.values.map(\.sender)) }
    var availableShares: [ActiveShare] { shares.values.sorted { $0.lastSeen > $1.lastSeen } }

    func share(from session: UInt32) -> ActiveShare? {
        shares.values.first { $0.sender == session }
    }

    func handle(_ plugin: PluginDataTransmissionMessage) {
        guard plugin.dataId == RTCSignal.dataId,
              let from = plugin.senderSession,
              let message = reassembler.receive(from: from, data: plugin.data) else { return }
        switch message.kind {
        case .announce:
            handleAnnounce(message, from: from)
        case .stop:
            shares[message.id] = nil
            if watching?.id == message.id {
                stopWatching(sendLeave: false)
                connectionState = "Sharing ended"
            }
        case .offer:
            guard let current = watching, current.id == message.id, current.sender == from, let sdp = message.sdp else { return }
            Task { await accept(offer: sdp, from: from, id: message.id) }
        case .ice:
            guard watching?.id == message.id else { return }
            let candidates = message.candidates ?? []
            if let peerConnection, remoteDescriptionSet {
                addCandidates(candidates, to: peerConnection)
            } else {
                pendingCandidates.append(contentsOf: candidates)
            }
        case .watch, .answer, .leave:
            break
        }
    }

    private func handleAnnounce(_ message: SignalMessage, from sender: UInt32) {
        let share = ActiveShare(
            id: message.id,
            sender: sender,
            title: message.title ?? client.session.users[sender]?.name ?? "Screen",
            width: message.width ?? 0,
            height: message.height ?? 0,
            hasAudio: message.audio ?? false,
            lastSeen: Date()
        )
        let isNew = shares[message.id] == nil
        shares[message.id] = share
        if var current = watching, current.id == message.id {
            current.lastSeen = share.lastSeen
            watching = current
        }
        if isNew { DiagnosticsLog.shared.add("share", "\(share.title) announced by session \(sender)") }
    }

    func watch(_ share: ActiveShare) {
        if watching != nil { stopWatching(sendLeave: true) }
        watching = share
        error = nil
        stats = ShareStats()
        connectionState = "Connecting…"
        DiagnosticsLog.shared.add("share", "watching \(share.title)")
        sender.send(.watch(share.id), to: [share.sender])
    }

    private func addCandidates(_ candidates: [ICECandidateInit], to peerConnection: RTCPeerConnection) {
        for candidate in candidates {
            let ice = RTCIceCandidate(sdp: candidate.candidate, sdpMLineIndex: candidate.sdpMLineIndex ?? 0, sdpMid: candidate.sdpMid)
            peerConnection.add(ice) { error in
                if let error { DiagnosticsLog.shared.add("share", "ice candidate rejected: \(error.localizedDescription)") }
            }
        }
    }

    func stopWatching(sendLeave: Bool = true) {
        pendingCandidates.removeAll()
        remoteDescriptionSet = false
        if let current = watching, sendLeave { sender.send(.leave(current.id), to: [current.sender]) }
        statsTimer?.invalidate()
        statsTimer = nil
        peerConnection?.close()
        peerConnection = nil
        videoTrack = nil
        watching = nil
    }

    func reset() {
        stopWatching(sendLeave: false)
        shares.removeAll()
        sender.reset()
    }

    private func pruneDepartedSharers() {
        let roster = client.session.users
        for share in shares.values where roster[share.sender] == nil {
            shares[share.id] = nil
            if watching?.id == share.id {
                stopWatching(sendLeave: false)
                connectionState = "Sharer left"
            }
        }
    }

    private func makeConfiguration() -> RTCConfiguration {
        let configuration = RTCConfiguration()
        var iceServers = [RTCIceServer(urlStrings: [Self.defaultStun])]
        if let turn = turnServer, !turn.url.isEmpty {
            iceServers.append(RTCIceServer(urlStrings: [turn.url], username: turn.username, credential: turn.password))
        }
        configuration.iceServers = iceServers
        configuration.sdpSemantics = .unifiedPlan
        configuration.bundlePolicy = .maxBundle
        configuration.rtcpMuxPolicy = .require
        configuration.continualGatheringPolicy = .gatherOnce
        return configuration
    }

    private func accept(offer sdp: String, from sharer: UInt32, id: String) async {
        peerConnection?.close()
        remoteDescriptionSet = false
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let connection = Self.factory.peerConnection(with: makeConfiguration(), constraints: constraints, delegate: self) else {
            error = "Couldn't start the viewer."
            return
        }
        peerConnection = connection
        let receiveOnly = RTCRtpTransceiverInit()
        receiveOnly.direction = .recvOnly
        connection.addTransceiver(of: .video, init: receiveOnly)

        do {
            try await connection.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: sdp))
            remoteDescriptionSet = true
            if !pendingCandidates.isEmpty {
                addCandidates(pendingCandidates, to: connection)
                pendingCandidates.removeAll()
            }
            let answer = try await connection.answer(for: constraints)
            try await connection.setLocalDescription(answer)
            await waitForGathering(connection)
            guard let local = connection.localDescription, watching?.id == id else { return }
            sender.send(.answer(id, sdp: local.sdp), to: [sharer])
            startStats()
        } catch {
            self.error = error.localizedDescription
            DiagnosticsLog.shared.add("share", "answer failed: \(error.localizedDescription)")
            stopWatching(sendLeave: true)
        }
    }

    private func waitForGathering(_ connection: RTCPeerConnection) async {
        let deadline = Date().addingTimeInterval(Self.gatheringDeadline)
        while connection.iceGatheringState != .complete, Date() < deadline {
            try? await Task.sleep(nanoseconds: Self.gatheringPollNanoseconds)
        }
    }

    private func startStats() {
        statsTimer?.invalidate()
        lastBytes = 0
        lastStatsAt = Date()
        statsTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sampleStats() }
        }
    }

    private func sampleStats() {
        guard let peerConnection else { return }
        peerConnection.statistics { [weak self] report in
            Task { @MainActor in
                self?.apply(report)
            }
        }
    }

    private func apply(_ report: RTCStatisticsReport) {
        var updated = stats
        let all = report.statistics
        for (_, entry) in all where entry.type == "inbound-rtp" && (entry.values["kind"] as? String) == "video" {
            if let width = entry.values["frameWidth"] as? NSNumber { updated.width = width.intValue }
            if let height = entry.values["frameHeight"] as? NSNumber { updated.height = height.intValue }
            if let fps = entry.values["framesPerSecond"] as? NSNumber { updated.fps = Int(fps.doubleValue.rounded()) }
            if let received = entry.values["bytesReceived"] as? NSNumber {
                let bytes = received.uint64Value
                let elapsed = Date().timeIntervalSince(lastStatsAt)
                if lastBytes > 0, elapsed > 0 {
                    updated.kbps = Int(Double(bytes - lastBytes) * 8 / 1000 / elapsed)
                }
                lastBytes = bytes
                lastStatsAt = Date()
            }
            if let codecId = entry.values["codecId"] as? String,
               let codec = all[codecId],
               let mime = codec.values["mimeType"] as? String {
                updated.codec = mime.replacingOccurrences(of: "video/", with: "")
            }
        }
        stats = updated
    }
}

extension ScreenShareModel: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        if let track = stream.videoTracks.first {
            Task { @MainActor in self.videoTrack = track }
        }
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
            if newState == .failed {
                self.error = "Couldn't connect to the sharer. A TURN server may be needed on this network."
            }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        if let track = rtpReceiver.track as? RTCVideoTrack {
            Task { @MainActor in self.videoTrack = track }
        }
    }
}
