import Foundation
import Observation
import WebRTC
import MumbleClient
import MumbleProtocol

final class VP8OnlyEncoderFactory: NSObject, RTCVideoEncoderFactory {
    func createEncoder(_ info: RTCVideoCodecInfo) -> RTCVideoEncoder? {
        info.name == kRTCVideoCodecVp8Name ? RTCVideoEncoderVP8.vp8Encoder() : nil
    }

    func supportedCodecs() -> [RTCVideoCodecInfo] {
        [RTCVideoCodecInfo(name: kRTCVideoCodecVp8Name)]
    }
}

struct OwnScreenShare: Equatable {
    let id: String
    let width: Int
    let height: Int
    var viewers: Int
}

@MainActor
@Observable
final class ScreenSharer: NSObject {
    private(set) var sharing: OwnScreenShare?
    private(set) var problem: String?
    private(set) var isReady = false

    @ObservationIgnored private let client: MumbleClient
    @ObservationIgnored private let sender: SignalSender
    @ObservationIgnored private let configuration: () -> RTCConfiguration
    @ObservationIgnored private let receiver = BroadcastReceiver()
    @ObservationIgnored private var watchLimiter = ShareWatchLimiter()
    @ObservationIgnored private var videoSource: RTCVideoSource?
    @ObservationIgnored private var videoCapturer: RTCVideoCapturer?
    @ObservationIgnored private var videoTrack: RTCVideoTrack?
    @ObservationIgnored private var announced: Set<UInt32> = []
    @ObservationIgnored private var viewers: [UInt32: ViewerConnection] = [:]
    @ObservationIgnored private var membershipTimer: Timer?
    @ObservationIgnored private var broadcastConnected = false

    static let title = "iPhone screen"
    private static let shareIdLength = 8
    private static let gatheringDeadline: TimeInterval = 2.5
    private static let gatheringPollNanoseconds: UInt64 = 50_000_000
    private static let maximumBitrate: NSNumber = 2_500_000

    @ObservationIgnored private static let factory: RTCPeerConnectionFactory = {
        _ = ScreenShareModel.factory
        return RTCPeerConnectionFactory(encoderFactory: VP8OnlyEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
    }()

    @MainActor final class ViewerConnection {
        let connection: RTCPeerConnection
        var answered = false
        var connected = false
        var waitingCandidates: [ICECandidateInit] = []
        let localCandidates = ICECandidateBatcher()

        init(connection: RTCPeerConnection) {
            self.connection = connection
        }
    }

    init(client: MumbleClient, sender: SignalSender, configuration: @escaping () -> RTCConfiguration) {
        self.client = client
        self.sender = sender
        self.configuration = configuration
        super.init()
        receiver.onConnect = { [weak self] in
            Task { @MainActor in self?.broadcastDidConnect() }
        }
        receiver.onDisconnect = { [weak self] in
            Task { @MainActor in self?.broadcastDidDisconnect() }
        }
        receiver.onFrame = { [weak self] frame in
            self?.capture(frame)
        }
    }

    nonisolated private func capture(_ frame: RTCVideoFrame) {
        Task { @MainActor in
            guard let source = self.videoSource, let capturer = self.videoCapturer else {
                let quarterTurn = frame.rotation == ._90 || frame.rotation == ._270
                let width = Int(quarterTurn ? frame.height : frame.width)
                let height = Int(quarterTurn ? frame.width : frame.height)
                self.beginSharing(width: width, height: height)
                return
            }
            source.capturer(capturer, didCapture: frame)
        }
    }

    var isAvailable: Bool { receiver.isAvailable }

    func prepare() {
        problem = nil
        guard !isReady else { return }
        isReady = receiver.start()
        if !isReady { DiagnosticsLog.shared.add("share", "screen sharing unavailable: no app group container") }
    }

    func shutDown() {
        stop()
        receiver.stop()
        isReady = false
        broadcastConnected = false
    }

    func stop() {
        endSharing()
        receiver.disconnectClient()
    }

    func handle(_ message: SignalMessage, from session: UInt32) {
        guard let current = sharing, message.id == current.id else { return }
        switch message.kind {
        case .watch:
            Task { await offer(to: session, shareId: current.id) }
        case .answer:
            if let sdp = message.sdp { answer(from: session, sdp: sdp) }
        case .leave:
            closeViewer(session)
            publishViewerCount()
        case .ice:
            guard let viewer = viewers[session] else { return }
            let candidates = Array((message.candidates ?? []).prefix(256).filter { $0.candidate.utf8.count <= 4096 })
            if viewer.answered {
                add(candidates, to: viewer.connection)
            } else {
                viewer.waitingCandidates.append(contentsOf: candidates.prefix(256 - viewer.waitingCandidates.count))
            }
        case .announce, .stop, .offer:
            break
        }
    }

    private func broadcastDidConnect() {
        broadcastConnected = true
        problem = nil
        guard client.session.state == .connected else {
            problem = "Connect to a server before sharing your screen."
            receiver.disconnectClient()
            return
        }
        DiagnosticsLog.shared.add("share", "broadcast extension connected")
    }

    private func broadcastDidDisconnect() {
        broadcastConnected = false
        DiagnosticsLog.shared.add("share", "broadcast extension disconnected")
        endSharing()
    }

    private func beginSharing(width: Int, height: Int) {
        guard broadcastConnected, sharing == nil, client.session.state == .connected else { return }
        let source = Self.factory.videoSource(forScreenCast: true)
        let capturer = RTCVideoCapturer(delegate: source)
        let id = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(Self.shareIdLength))
        let track = Self.factory.videoTrack(with: source, trackId: "screen-\(id)")
        videoSource = source
        videoCapturer = capturer
        videoTrack = track
        sharing = OwnScreenShare(id: id, width: width, height: height, viewers: 0)
        announced = []
        watchLimiter.reset()
        announce(to: channelMembers())
        membershipTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.followMembership() }
        }
        DiagnosticsLog.shared.add("share", "sharing the screen at \(width)×\(height)")
    }

    private func endSharing() {
        guard let current = sharing else { return }
        sender.send(SignalMessage(kind: .stop, id: current.id), to: Array(announced))
        for session in Array(viewers.keys) { closeViewer(session) }
        membershipTimer?.invalidate()
        membershipTimer = nil
        announced = []
        videoTrack = nil
        videoCapturer = nil
        videoSource = nil
        sharing = nil
        DiagnosticsLog.shared.add("share", "stopped sharing the screen")
    }

    private func channelMembers() -> [UInt32] {
        guard let me = client.session.mySession, let channel = client.session.users[me]?.channelID else { return [] }
        return client.session.users.values
            .filter { $0.session != me && $0.channelID == channel }
            .map(\.session)
    }

    private func isChannelMember(_ session: UInt32) -> Bool {
        channelMembers().contains(session)
    }

    private func announce(to recipients: [UInt32]) {
        guard let current = sharing, !recipients.isEmpty else { return }
        announced.formUnion(recipients)
        var message = SignalMessage(kind: .announce, id: current.id)
        message.shareKind = "screen"
        message.title = Self.title
        message.width = current.width
        message.height = current.height
        message.audio = false
        sender.send(message, to: recipients)
    }

    private func followMembership() {
        guard let current = sharing else { return }
        guard client.session.state == .connected else {
            stop()
            return
        }
        let members = Set(channelMembers())
        watchLimiter.forgetAll(except: Set(client.session.users.keys))
        let departed = announced.subtracting(members)
        if !departed.isEmpty {
            announced.subtract(departed)
            sender.send(SignalMessage(kind: .stop, id: current.id), to: Array(departed))
        }
        for session in viewers.keys where !members.contains(session) {
            closeViewer(session)
        }
        announce(to: Array(members.subtracting(announced)))
        publishViewerCount()
    }

    private func offer(to session: UInt32, shareId: String) async {
        guard sharing?.id == shareId, let track = videoTrack, isChannelMember(session), watchLimiter.allow(session) else { return }
        announced.insert(session)
        closeViewer(session)
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let connection = Self.factory.peerConnection(with: configuration(), constraints: constraints, delegate: self) else { return }
        let viewer = ViewerConnection(connection: connection)
        viewers[session] = viewer
        let sendOnly = RTCRtpTransceiverInit()
        sendOnly.direction = .sendOnly
        sendOnly.streamIds = ["mutter-\(shareId)"]
        if let transceiver = connection.addTransceiver(with: track, init: sendOnly) {
            limitEncoding(transceiver.sender)
        }
        func isCurrent() -> Bool { sharing?.id == shareId && viewers[session] === viewer }
        do {
            let offer = try await connection.offer(for: constraints)
            guard isCurrent() else { return }
            try await connection.setLocalDescription(offer)
            guard isCurrent() else { return }
            let deadline = Date().addingTimeInterval(Self.gatheringDeadline)
            while connection.iceGatheringState != .complete, Date() < deadline {
                try? await Task.sleep(nanoseconds: Self.gatheringPollNanoseconds)
            }
            guard isCurrent(), let local = connection.localDescription else { return }
            var message = SignalMessage(kind: .offer, id: shareId)
            message.sdp = local.sdp
            sender.send(message, to: [session], replacing: "offer:\(session):\(shareId)", scope: viewer.localCandidates.scope)
            viewer.localCandidates.activate(localSDP: local.sdp) { [weak self, weak viewer] candidates in
                guard let self, let viewer, self.sharing?.id == shareId, self.viewers[session] === viewer else { return }
                self.sender.send(SignalMessage(kind: .ice, id: shareId, candidates: candidates),
                                 to: [session], scope: viewer.localCandidates.scope)
            }
        } catch {
            guard isCurrent() else { return }
            DiagnosticsLog.shared.add("share", "offer failed: \(error.localizedDescription)")
            closeViewer(session)
        }
    }

    private func answer(from session: UInt32, sdp: String) {
        guard let viewer = viewers[session], !viewer.answered else { return }
        let viewerIdentity = ObjectIdentifier(viewer)
        viewer.connection.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { [weak self] error in
            let failure = error?.localizedDescription
            Task { @MainActor in
                guard let self, let viewer = self.viewers[session], ObjectIdentifier(viewer) == viewerIdentity else { return }
                if let failure {
                    DiagnosticsLog.shared.add("share", "answer rejected: \(failure)")
                    return
                }
                viewer.answered = true
                self.add(viewer.waitingCandidates, to: viewer.connection)
                viewer.waitingCandidates.removeAll()
            }
        }
    }

    private func add(_ candidates: [ICECandidateInit], to connection: RTCPeerConnection) {
        for candidate in candidates {
            let ice = RTCIceCandidate(sdp: candidate.candidate, sdpMLineIndex: candidate.sdpMLineIndex ?? 0, sdpMid: candidate.sdpMid)
            connection.add(ice) { _ in }
        }
    }

    private func limitEncoding(_ rtpSender: RTCRtpSender) {
        let parameters = rtpSender.parameters
        for encoding in parameters.encodings {
            encoding.maxBitrateBps = Self.maximumBitrate
            encoding.maxFramerate = NSNumber(value: BroadcastChannel.framesPerSecond)
        }
        parameters.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainResolution.rawValue)
        rtpSender.parameters = parameters
    }

    private func closeViewer(_ session: UInt32) {
        guard let viewer = viewers.removeValue(forKey: session) else { return }
        sender.cancel(scope: viewer.localCandidates.scope)
        viewer.localCandidates.cancel()
        viewer.connection.close()
    }

    private func publishViewerCount() {
        guard var current = sharing else { return }
        let count = viewers.values.filter(\.connected).count
        if current.viewers != count {
            current.viewers = count
            sharing = current
        }
    }

    private func viewerSession(for connection: RTCPeerConnection) -> UInt32? {
        viewers.first { $0.value.connection === connection }?.key
    }
}

extension ScreenSharer: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Task { @MainActor in
            guard let session = self.viewerSession(for: peerConnection), let viewer = self.viewers[session] else { return }
            viewer.connected = newState == .connected || newState == .completed
            if newState == .failed || newState == .closed {
                self.closeViewer(session)
            }
            self.publishViewerCount()
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let value = ICECandidateInit(candidate: candidate.sdp, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex)
        Task { @MainActor in
            guard let session = self.viewerSession(for: peerConnection), let viewer = self.viewers[session] else { return }
            viewer.localCandidates.add(value)
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
