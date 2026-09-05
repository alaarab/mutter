#if canImport(Network)
import Foundation
import Network
import Security
import MumbleProtocol

public enum CertificateTrustQuestion: Sendable {
    case firstContact(ServerCertificateInfo)
    case changed(expected: Data, actual: ServerCertificateInfo)
}

public struct ConnectionOptions {
    public var username: String
    public var password: String?
    public var tokens: [String] = []
    public var identity: SecIdentity?
    public var expectedFingerprint: Data?
    public var clientRelease = "Mutter 0.1.0"
    public var osName = "iOS"
    public var osVersion = ""
    public var autoReconnect = true

    public init(username: String, password: String? = nil) {
        self.username = username
        self.password = password
    }
}

public protocol VoiceSink: AnyObject {
    func receiveAudio(_ packet: AudioPacket)
    func voiceStreamsDidReset()
}

public final class MumbleClient {
    public let session: ServerSession
    public weak var voiceSink: VoiceSink?
    public var certificateTrust: ((CertificateTrustQuestion) async -> Bool)?
    public var didAcceptCertificate: ((ServerEndpoint, ServerCertificateInfo) -> Void)?
    public var onPluginData: (@MainActor (PluginDataTransmissionMessage) -> Void)?

    private let queue = DispatchQueue(label: "mutter.mumble.client", qos: .userInteractive)
    private var control: ControlConnection?
    private var voice: VoiceConnection?
    private let crypt = CryptState()

    private var endpoint: ServerEndpoint?
    private var options: ConnectionOptions?
    private var serverVersion: ProtocolVersion = .unknown
    private var wireFormat: VoiceWireFormat = .legacy
    private var mySession: UInt32?
    private var isSynced = false
    private var intentionalDisconnect = false
    private var reconnectAttempt = 0
    private var usernameOverride: String?
    private var usernameInUseRetries = 0
    private var pendingCertificate: ServerCertificateInfo?

    private var pingTimer: DispatchSourceTimer?
    private var talkTimer: DispatchSourceTimer?
    private var lastControlReceiveAt = Date()
    private var lastUDPReply: Date?
    private var udpAvailable = false
    private var tcpPingSamples: [Double] = []
    private var udpPingSamples: [Double] = []
    private var tcpPacketsSent: UInt32 = 0
    private var frameNumber: UInt64 = 0
    private var talkers: [UInt32: Date] = [:]
    private var users: [UInt32: User] = [:]
    private var channels: [UInt32: Channel] = [:]

    @MainActor
    public init() {
        session = ServerSession()
    }

    public func connect(to endpoint: ServerEndpoint, options: ConnectionOptions) {
        queue.async {
            self.teardown(keepState: false)
            self.endpoint = endpoint
            self.options = options
            self.intentionalDisconnect = false
            self.reconnectAttempt = 0
            self.usernameOverride = nil
            self.usernameInUseRetries = 0
            self.ui { session in
                session.reset()
                session.messages = []
                session.notices = []
                session.lastError = nil
                session.endpoint = endpoint
                session.state = .connecting
            }
            self.openControl()
        }
    }

    public func disconnect() {
        queue.async {
            self.intentionalDisconnect = true
            self.teardown(keepState: false)
            self.ui { session in
                session.state = .disconnected
                session.isTransmitting = false
                session.appendNotice(.disconnected(reason: nil))
            }
        }
    }

    private func openControl() {
        guard let endpoint, let options else { return }
        let control = ControlConnection(endpoint: endpoint, identity: options.identity, queue: queue) { [weak self] trust, info, complete in
            self?.evaluateCertificate(trust: trust, info: info, complete: complete)
        }
        control.onEvent = { [weak self] event in self?.handleControl(event) }
        self.control = control
        control.start()
    }

    private func evaluateCertificate(trust: SecTrust, info: ServerCertificateInfo, complete: @escaping (Bool) -> Void) {
        pendingCertificate = info
        let expected = options?.expectedFingerprint
        if let expected {
            if expected == info.sha256Fingerprint {
                complete(true)
                return
            }
            ask(.changed(expected: expected, actual: info), complete: complete)
            return
        }
        if CertificateInspector.isSystemTrusted(trust) {
            complete(true)
            return
        }
        ask(.firstContact(info), complete: complete)
    }

    private func ask(_ question: CertificateTrustQuestion, complete: @escaping (Bool) -> Void) {
        guard let handler = certificateTrust else {
            if case .firstContact = question { complete(true) } else { complete(false) }
            return
        }
        Task {
            let ok = await handler(question)
            self.queue.async { complete(ok) }
        }
    }

    private func teardown(keepState: Bool) {
        pingTimer?.cancel()
        pingTimer = nil
        talkTimer?.cancel()
        talkTimer = nil
        control?.cancel()
        control = nil
        voice?.cancel()
        voice = nil
        udpAvailable = false
        lastUDPReply = nil
        isSynced = false
        mySession = nil
        talkers = [:]
        users = [:]
        channels = [:]
        frameNumber = 0
        tcpPingSamples = []
        udpPingSamples = []
        voiceSink?.voiceStreamsDidReset()
        if !keepState {
            serverVersion = .unknown
            wireFormat = .legacy
        }
    }

    private func fail(_ error: ConnectionError) {
        let wasSynced = isSynced
        let reconnecting = reconnectAttempt > 0
        teardown(keepState: true)
        let canRetry = (options?.autoReconnect ?? false) && !intentionalDisconnect && wasSynced
        switch error {
        case .rejected(.usernameInUse, _) where reconnecting || wasSynced:
            usernameInUseRetries += 1
            if usernameInUseRetries >= 2, let base = options?.username {
                usernameOverride = "\(base)\(usernameInUseRetries)"
            }
            scheduleReconnect(true, error: error)
        case .rejected, .certificateRejected, .certificateChanged:
            scheduleReconnect(false, error: error)
        default:
            scheduleReconnect(canRetry, error: error)
        }
    }

    private func scheduleReconnect(_ retry: Bool, error: ConnectionError) {
        if retry && reconnectAttempt < 6 {
            reconnectAttempt += 1
            let attempt = reconnectAttempt
            let delay = min(30.0, pow(2.0, Double(attempt)))
            ui { session in
                session.state = .reconnecting(attempt: attempt)
                session.lastError = error
                session.isTransmitting = false
                session.users = [:]
                session.channels = [:]
                session.appendNotice(.disconnected(reason: error.errorDescription))
            }
            queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, !self.intentionalDisconnect, self.control == nil else { return }
                self.ui { $0.state = .connecting }
                self.openControl()
            }
        } else {
            ui { session in
                session.state = .disconnected
                session.lastError = error
                session.isTransmitting = false
                session.appendNotice(.disconnected(reason: error.errorDescription))
            }
        }
    }

    private func handleControl(_ event: ControlConnection.Event) {
        switch event {
        case .ready:
            ui { $0.state = .authenticating }
            sendHandshake()
        case .frame(let frame):
            lastControlReceiveAt = Date()
            do {
                let message = try IncomingMessage.decode(type: frame.type, payload: frame.payload)
                handle(message)
            } catch {
            }
        case .failed(let error):
            if let nw = error as? NWError, case .tls(let status) = nw, status == errSSLPeerHandshakeFail || status == errSSLXCertChainInvalid || status == errSSLBadCert {
                fail(.certificateRejected)
            } else {
                fail(.network(error.localizedDescription))
            }
        case .closed:
            fail(.closedByServer)
        }
    }

    private func sendHandshake() {
        guard let options else { return }
        let version = VersionMessage(
            version: .client,
            release: options.clientRelease,
            os: options.osName,
            osVersion: options.osVersion
        )
        send(version)
        var auth = AuthenticateMessage(username: usernameOverride ?? options.username, password: options.password, tokens: options.tokens)
        auth.opus = true
        auth.clientType = 0
        send(auth)
    }

    private func send<M: ControlMessage>(_ message: M) {
        tcpPacketsSent &+= 1
        control?.send(ControlFraming.frame(message))
    }

    private func handle(_ message: IncomingMessage) {
        switch message {
        case .version(let version):
            serverVersion = version.protocolVersion
            wireFormat = VoiceWireFormat(serverVersion: serverVersion)
            ui { session in
                session.serverInfo.version = version.protocolVersion
                session.serverInfo.release = version.release
                session.serverInfo.os = version.os
                session.serverInfo.osVersion = version.osVersion
            }

        case .reject(let reject):
            intentionalDisconnect = true
            fail(.rejected(reject.type, reason: reject.reason))

        case .cryptSetup(let setup):
            handleCryptSetup(setup)

        case .codecVersion(let codec):
            if codec.opus != true {
                ui { $0.appendNotice(.info("This server does not allow Opus; voice will not work.")) }
            }

        case .channelState(let state):
            applyChannelState(state)

        case .channelRemove(let removal):
            channels[removal.channelId] = nil
            let removed = removal.channelId
            ui { $0.channels[removed] = nil }

        case .userState(let state):
            applyUserState(state)

        case .userRemove(let removal):
            handleUserRemove(removal)

        case .serverSync(let sync):
            handleServerSync(sync)

        case .serverConfig(let config):
            ui { session in
                if let maxBandwidth = config.maxBandwidth { session.serverInfo.maxBandwidth = maxBandwidth }
                if let welcome = config.welcomeText, session.serverInfo.welcomeText == nil { session.serverInfo.welcomeText = welcome }
                if let allowHTML = config.allowHtml { session.serverInfo.allowHTML = allowHTML }
                session.serverInfo.messageLength = config.messageLength
                session.serverInfo.imageMessageLength = config.imageMessageLength
                session.serverInfo.maxUsers = config.maxUsers
                if let recordingAllowed = config.recordingAllowed { session.serverInfo.recordingAllowed = recordingAllowed }
            }

        case .suggestConfig(let suggestion):
            ui { $0.serverInfo.suggestsPushToTalk = suggestion.pushToTalk }

        case .permissionQuery(let query):
            handlePermissionQuery(query)

        case .permissionDenied(let denial):
            let text = denial.userMessage
            ui { $0.appendNotice(.permissionDenied(text)) }

        case .pluginDataTransmission(let plugin):
            if let handler = onPluginData {
                Task { @MainActor in handler(plugin) }
            }

        case .textMessage(let text):
            handleTextMessage(text)

        case .ping(let ping):
            if let timestamp = ping.timestamp {
                let roundTrip = Double(nowMicros() &- timestamp) / 1000.0
                tcpPingSamples.append(roundTrip)
                if tcpPingSamples.count > 20 { tcpPingSamples.removeFirst() }
            }
            publishStats()

        case .udpTunnel(let tunnel):
            handleVoicePacket(tunnel.packet, viaTunnel: true)

        case .userList(let list):
            ui { $0.registeredUsers = list.users }

        case .userStats(let stats):
            guard let sessionID = stats.session else { return }
            ui { $0.users[sessionID]?.stats = stats }

        case .unhandled:
            break
        }
    }

    private func handleUserRemove(_ removal: UserRemoveMessage) {
        let name = users[removal.session]?.name ?? "Someone"
        let actorName = removal.actor.flatMap { users[$0]?.name }
        users[removal.session] = nil
        talkers[removal.session] = nil
        let wasKicked = removal.actor != nil && actorName != nil
        ui { session in
            session.users[removal.session] = nil
            if session.isConnected || removal.session == session.mySession {
                session.appendNotice(.userLeft(name: name, reason: removal.reason, wasKicked: wasKicked, wasBanned: removal.ban ?? false))
            }
        }
        if removal.session == mySession {
            intentionalDisconnect = true
            let reason = removal.reason ?? (removal.ban == true ? "You were banned." : "You were kicked.")
            fail(.network(reason))
        }
    }

    private func handleServerSync(_ sync: ServerSyncMessage) {
        mySession = sync.session
        isSynced = true
        reconnectAttempt = 0
        usernameInUseRetries = 0
        usernameOverride = nil
        let certificate = pendingCertificate
        let endpoint = self.endpoint
        let permissions = Permissions(rawValue: UInt32(truncatingIfNeeded: sync.permissions ?? 0))
        ui { session in
            session.mySession = sync.session
            session.serverInfo.welcomeText = sync.welcomeText
            session.serverInfo.maxBandwidth = sync.maxBandwidth
            session.serverInfo.permissions = permissions
            session.serverCertificate = certificate
            session.state = .connected
            session.appendNotice(.connected)
            if let welcome = sync.welcomeText, !welcome.isEmpty {
                session.appendMessage(ChatMessage(senderSession: nil, senderName: "Server", html: welcome, scope: .system))
            }
        }
        if let certificate, let endpoint { didAcceptCertificate?(endpoint, certificate) }
        startTimers()
        requestMissingBlobs()
    }

    private func handlePermissionQuery(_ query: PermissionQueryMessage) {
        guard let channelID = query.channelId else { return }
        let permissions = Permissions(rawValue: query.permissions ?? 0)
        channels[channelID]?.permissions = permissions
        ui { session in
            if query.flush == true {
                for key in session.channels.keys { session.channels[key]?.permissions = nil }
            }
            session.channels[channelID]?.permissions = permissions
        }
    }

    private func handleCryptSetup(_ setup: CryptSetupMessage) {
        if let key = setup.key, let clientNonce = setup.clientNonce, let serverNonce = setup.serverNonce {
            if crypt.setKey(key, clientNonce: clientNonce, serverNonce: serverNonce) {
                openVoice()
            }
        } else if let serverNonce = setup.serverNonce {
            _ = crypt.setDecryptIV([UInt8](serverNonce))
        } else {
            send(CryptSetupMessage(clientNonce: Data(crypt.encryptIV)))
        }
    }

    private func applyChannelState(_ state: ChannelStateMessage) {
        guard let channelID = state.channelId else { return }
        var channel = channels[channelID] ?? Channel(id: channelID, parentID: state.parent, name: state.name ?? "")
        if let parent = state.parent { channel.parentID = (channelID == Channel.rootID) ? nil : parent }
        if let name = state.name { channel.name = name }
        if let description = state.description {
            channel.description = description
            channel.descriptionHash = nil
        }
        if let descriptionHash = state.descriptionHash { channel.descriptionHash = descriptionHash }
        if let position = state.position { channel.position = position }
        if let temporary = state.temporary { channel.isTemporary = temporary }
        if let maxUsers = state.maxUsers { channel.maxUsers = maxUsers }
        if !state.links.isEmpty { channel.links = Set(state.links) }
        for link in state.linksAdd { channel.links.insert(link) }
        for link in state.linksRemove { channel.links.remove(link) }
        if let restricted = state.isEnterRestricted { channel.isEnterRestricted = restricted }
        if let canEnter = state.canEnter { channel.canEnter = canEnter }
        channels[channelID] = channel
        let snapshot = channel
        ui { session in
            var merged = snapshot
            merged.permissions = session.channels[channelID]?.permissions ?? snapshot.permissions
            session.channels[channelID] = merged
        }
    }

    private func applyUserState(_ state: UserStateMessage) {
        guard let sessionID = state.session else { return }
        let isNew = users[sessionID] == nil
        var user = users[sessionID] ?? User(session: sessionID, name: state.name ?? "")
        let previousChannel = user.channelID
        if let name = state.name { user.name = name }
        if let userID = state.userId { user.userID = userID }
        if let channelID = state.channelId { user.channelID = channelID }
        if let muted = state.mute { user.isMuted = muted }
        if let deafened = state.deaf { user.isDeafened = deafened }
        if let suppressed = state.suppress { user.isSuppressed = suppressed }
        if let selfMuted = state.selfMute { user.isSelfMuted = selfMuted }
        if let selfDeafened = state.selfDeaf { user.isSelfDeafened = selfDeafened }
        if let priority = state.prioritySpeaker { user.isPrioritySpeaker = priority }
        if let recording = state.recording { user.isRecording = recording }
        if let comment = state.comment {
            user.comment = comment
            user.commentHash = nil
        }
        if let commentHash = state.commentHash { user.commentHash = commentHash }
        if let hash = state.hash { user.hash = hash }
        if let texture = state.texture {
            user.texture = texture
            user.textureHash = nil
        }
        if let textureHash = state.textureHash { user.textureHash = textureHash }
        for channelID in state.listeningChannelAdd { user.listeningChannels.insert(channelID) }
        for channelID in state.listeningChannelRemove { user.listeningChannels.remove(channelID) }
        users[sessionID] = user

        let synced = isSynced
        let me = mySession
        let actorName = state.actor.flatMap { users[$0]?.name }
        let moved = state.channelId != nil && !isNew && previousChannel != user.channelID
        let movedToChannelName = moved ? (channels[user.channelID]?.name ?? "a channel") : nil
        let snapshot = user

        ui { session in
            var merged = snapshot
            if let existing = session.users[sessionID] {
                merged.isTalking = existing.isTalking
                merged.talkingContext = existing.talkingContext
                merged.isLocallyMuted = existing.isLocallyMuted
                merged.localVolume = existing.localVolume
                merged.lastTalkedAt = existing.lastTalkedAt
                merged.stats = existing.stats
            }
            session.users[sessionID] = merged
            guard synced else { return }
            if isNew {
                session.appendNotice(.userJoined(name: merged.name))
            } else if let target = movedToChannelName {
                let myChannel = session.me?.channelID
                let involvesMe = sessionID == me || previousChannel == myChannel || merged.channelID == myChannel
                if involvesMe {
                    let actor = (state.actor == sessionID) ? nil : actorName
                    session.appendNotice(.userMoved(name: merged.name, toChannel: target, byActor: actor))
                }
            }
        }

        if state.commentHash != nil && state.comment == nil {
            send(RequestBlobMessage(sessionComment: [sessionID]))
        }
        if state.textureHash != nil && state.texture == nil {
            send(RequestBlobMessage(sessionTexture: [sessionID]))
        }
    }

    private func requestMissingBlobs() {
        let wanted = channels.values.filter { $0.descriptionHash != nil && $0.description == nil }.map { $0.id }
        if !wanted.isEmpty { send(RequestBlobMessage(channelDescription: wanted)) }
    }

    private func handleTextMessage(_ text: TextMessageMessage) {
        let senderName = text.actor.flatMap { users[$0]?.name } ?? "Server"
        let scope: MessageScope
        if let me = mySession, text.sessions.contains(me) {
            scope = .user(text.actor ?? 0)
        } else if let channelID = text.channelIds.first {
            scope = .channel(channelID)
        } else if let treeID = text.treeIds.first {
            scope = .tree(treeID)
        } else {
            scope = .system
        }
        let message = ChatMessage(senderSession: text.actor, senderName: senderName, html: text.message, scope: scope)
        ui { session in
            session.appendMessage(message)
            session.appendNotice(.textMessage(message))
        }
    }

    private func openVoice() {
        guard let endpoint else { return }
        voice?.cancel()
        let connection = VoiceConnection(endpoint: endpoint, queue: queue)
        connection.onDatagram = { [weak self] data in self?.handleDatagram(data) }
        connection.onFailure = { [weak self] _ in
            self?.udpAvailable = false
        }
        voice = connection
        connection.start()
        queue.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.sendUDPPing() }
    }

    private func handleDatagram(_ data: Data) {
        guard let plain = crypt.decrypt(data) else { return }
        handleVoicePacket(plain, viaTunnel: false)
    }

    private func handleVoicePacket(_ data: Data, viaTunnel: Bool) {
        guard let packet = VoiceCodec.decode(data, format: wireFormat) else { return }
        switch packet {
        case .ping(let ping):
            if !viaTunnel {
                lastUDPReply = Date()
                let roundTrip = Double(nowMicros() &- ping.timestamp) / 1000.0
                if roundTrip >= 0 && roundTrip < 60_000 {
                    udpPingSamples.append(roundTrip)
                    if udpPingSamples.count > 20 { udpPingSamples.removeFirst() }
                }
                if !udpAvailable {
                    udpAvailable = true
                    ui { $0.stats.isUsingUDP = true }
                }
            }
        case .audio(let audio):
            guard let sender = audio.senderSession else { return }
            if users[sender]?.isLocallyMuted == true { return }
            voiceSink?.receiveAudio(audio)
            noteTalking(sender, context: audio.context, ended: audio.isTerminator)
        }
    }

    private func noteTalking(_ sender: UInt32, context: AudioContext, ended: Bool) {
        let wasTalking = talkers[sender] != nil
        if ended {
            talkers[sender] = nil
            if wasTalking {
                ui { session in
                    session.users[sender]?.isTalking = false
                    session.users[sender]?.lastTalkedAt = Date()
                }
            }
            return
        }
        talkers[sender] = Date()
        if !wasTalking {
            ui { session in
                session.users[sender]?.isTalking = true
                session.users[sender]?.talkingContext = context
            }
        }
    }

    private func sweepTalkers() {
        let cutoff = Date().addingTimeInterval(-0.4)
        let stale = talkers.filter { $0.value < cutoff }.map { $0.key }
        guard !stale.isEmpty else { return }
        for sessionID in stale { talkers[sessionID] = nil }
        ui { session in
            for id in stale {
                session.users[id]?.isTalking = false
                session.users[id]?.lastTalkedAt = Date()
            }
        }
    }

    public func sendAudio(opus: Data, frameCount: Int, isTerminator: Bool, target: VoiceTargetID = .normal) {
        queue.async {
            guard self.isSynced else { return }
            var packet = AudioPacket()
            packet.target = target
            packet.frameNumber = self.frameNumber
            packet.opusData = opus
            packet.isTerminator = isTerminator
            self.frameNumber &+= UInt64(max(1, frameCount))
            let encoded = VoiceCodec.encodeAudio(packet, format: self.wireFormat)
            if self.udpAvailable, let voice = self.voice, let encrypted = self.crypt.encrypt(encoded) {
                voice.send(encrypted)
            } else {
                self.send(UDPTunnelMessage(packet: encoded))
            }
        }
    }

    public func sendPluginData(to receivers: [UInt32], dataId: String, data: Data) {
        guard !receivers.isEmpty, data.count <= PluginDataTransmissionMessage.maxDataLength else { return }
        queue.async {
            guard self.isSynced else { return }
            self.send(PluginDataTransmissionMessage(receiverSessions: receivers, dataId: dataId, data: data))
        }
    }

    public func setTransmitting(_ on: Bool) {
        ui { $0.isTransmitting = on }
    }

    private func sendUDPPing() {
        guard crypt.isValid, let voice else { return }
        let ping = UDPPing(timestamp: nowMicros())
        if let encrypted = crypt.encrypt(VoiceCodec.encodePing(ping, format: wireFormat)) {
            voice.send(encrypted)
        }
    }

    private func startTimers() {
        lastControlReceiveAt = Date()
        pingTimer?.cancel()
        let pingSource = DispatchSource.makeTimerSource(queue: queue)
        pingSource.schedule(deadline: .now() + 1, repeating: 5.0)
        pingSource.setEventHandler { [weak self] in self?.tick() }
        pingSource.resume()
        pingTimer = pingSource

        talkTimer?.cancel()
        let talkSource = DispatchSource.makeTimerSource(queue: queue)
        talkSource.schedule(deadline: .now() + 0.25, repeating: 0.25)
        talkSource.setEventHandler { [weak self] in self?.sweepTalkers() }
        talkSource.resume()
        talkTimer = talkSource
    }

    private func tick() {
        var ping = PingMessage(timestamp: nowMicros())
        ping.good = crypt.good
        ping.late = crypt.late
        ping.lost = crypt.lost
        ping.resync = crypt.resync
        ping.udpPackets = voice?.packetsSent ?? 0
        ping.tcpPackets = tcpPacketsSent
        ping.udpPingAvg = Float(average(udpPingSamples))
        ping.udpPingVar = Float(variance(udpPingSamples))
        ping.tcpPingAvg = Float(average(tcpPingSamples))
        ping.tcpPingVar = Float(variance(tcpPingSamples))
        send(ping)
        sendUDPPing()

        if isSynced, Date().timeIntervalSince(lastControlReceiveAt) > 20 {
            fail(.timeout)
            return
        }

        if udpAvailable, let last = lastUDPReply, Date().timeIntervalSince(last) > 10 {
            udpAvailable = false
            ui { session in
                session.stats.isUsingUDP = false
                session.appendNotice(.info("UDP is blocked on this network. Voice is tunnelled over TCP."))
            }
        }

        if crypt.isValid, udpAvailable,
           Date().timeIntervalSince(crypt.lastGood) > 5, Date().timeIntervalSince(crypt.lastRequest) > 5 {
            crypt.markResyncRequested()
            send(CryptSetupMessage())
        }
        publishStats()
    }

    private func publishStats() {
        var stats = ConnectionStats()
        stats.tcpPingAverageMs = average(tcpPingSamples)
        stats.udpPingAverageMs = average(udpPingSamples)
        stats.udpGood = crypt.good
        stats.udpLate = crypt.late
        stats.udpLost = crypt.lost
        stats.udpResync = crypt.resync
        stats.udpPacketsSent = voice?.packetsSent ?? 0
        stats.tcpPacketsSent = tcpPacketsSent
        stats.isUsingUDP = udpAvailable
        stats.bytesIn = (control?.bytesIn ?? 0) &+ (voice?.bytesIn ?? 0)
        stats.bytesOut = (control?.bytesOut ?? 0) &+ (voice?.bytesOut ?? 0)
        ui { $0.stats = stats }
    }

    private func average(_ values: [Double]) -> Double {
        values.isEmpty ? 0 : values.reduce(0, +) / Double(values.count)
    }

    private func variance(_ values: [Double]) -> Double {
        guard values.count > 1 else { return 0 }
        let mean = average(values)
        return values.reduce(0) { $0 + ($1 - mean) * ($1 - mean) } / Double(values.count - 1)
    }

    private func nowMicros() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds / 1000
    }

    private func sendUserState(session: UInt32, _ configure: (inout UserStateMessage) -> Void) {
        var state = UserStateMessage()
        state.session = session
        configure(&state)
        send(state)
    }

    private func updateSelf(_ configure: @escaping (inout UserStateMessage) -> Void) {
        queue.async {
            guard let me = self.mySession else { return }
            self.sendUserState(session: me, configure)
        }
    }

    private func updateUser(_ session: UInt32, _ configure: @escaping (inout UserStateMessage) -> Void) {
        queue.async { self.sendUserState(session: session, configure) }
    }

    private func sendChannelState(_ configure: @escaping (inout ChannelStateMessage) -> Void) {
        queue.async {
            var change = ChannelStateMessage()
            configure(&change)
            self.send(change)
        }
    }

    public func join(channel channelID: UInt32) {
        updateSelf { $0.channelId = channelID }
    }

    public func setSelfMute(_ muted: Bool) {
        updateSelf { state in
            state.selfMute = muted
            if !muted { state.selfDeaf = false }
        }
    }

    public func setSelfDeaf(_ deaf: Bool) {
        updateSelf { state in
            state.selfDeaf = deaf
            if deaf { state.selfMute = true }
        }
    }

    public func setComment(_ comment: String) {
        updateSelf { $0.comment = comment }
    }

    public func setRecording(_ on: Bool) {
        updateSelf { $0.recording = on }
    }

    public func setPrioritySpeaker(session: UInt32, on: Bool) {
        updateUser(session) { $0.prioritySpeaker = on }
    }

    public func setListening(channel channelID: UInt32, listening: Bool) {
        updateSelf { state in
            if listening {
                state.listeningChannelAdd = [channelID]
            } else {
                state.listeningChannelRemove = [channelID]
            }
        }
    }

    public func registerSelf() {
        updateSelf { $0.userId = 0 }
    }

    public func moveUser(session: UInt32, to channelID: UInt32) {
        updateUser(session) { $0.channelId = channelID }
    }

    public func serverMute(session: UInt32, mute: Bool) {
        updateUser(session) { $0.mute = mute }
    }

    public func serverDeafen(session: UInt32, deaf: Bool) {
        updateUser(session) { state in
            state.deaf = deaf
            if deaf { state.mute = true }
        }
    }

    public func kick(session: UInt32, reason: String, ban: Bool) {
        queue.async {
            self.send(UserRemoveMessage(session: session, reason: reason, ban: ban))
        }
    }

    public func sendText(html: String, to scope: MessageScope) {
        queue.async {
            let text: TextMessageMessage
            switch scope {
            case .channel(let id): text = TextMessageMessage(message: html, channelIds: [id])
            case .tree(let id): text = TextMessageMessage(message: html, treeIds: [id])
            case .user(let id): text = TextMessageMessage(message: html, sessions: [id])
            case .system: return
            }
            guard self.isSynced, self.control != nil else {
                self.ui { $0.appendNotice(.info("Not connected — message not sent.")) }
                return
            }
            self.send(text)
            let myName = self.mySession.flatMap { self.users[$0]?.name } ?? "Me"
            let message = ChatMessage(senderSession: self.mySession, senderName: myName, html: html, scope: scope, isOwn: true)
            self.ui { $0.appendMessage(message) }
        }
    }

    public func createChannel(name: String, parent: UInt32, temporary: Bool, description: String? = nil) {
        sendChannelState { change in
            change.parent = parent
            change.name = name
            change.temporary = temporary
            change.description = description
        }
    }

    public func removeChannel(_ id: UInt32) {
        queue.async { self.send(ChannelRemoveMessage(channelId: id)) }
    }

    public func renameChannel(_ id: UInt32, name: String) {
        sendChannelState { change in
            change.channelId = id
            change.name = name
        }
    }

    public func linkChannels(_ id: UInt32, add: [UInt32] = [], remove: [UInt32] = []) {
        sendChannelState { change in
            change.channelId = id
            change.linksAdd = add
            change.linksRemove = remove
        }
    }

    public func requestPermissions(channel id: UInt32) {
        queue.async { self.send(PermissionQueryMessage(channelId: id)) }
    }

    public func requestStats(session: UInt32, statsOnly: Bool = false) {
        queue.async { self.send(UserStatsMessage(session: session, statsOnly: statsOnly)) }
    }

    public func requestRegisteredUsers() {
        queue.async { self.send(UserListMessage()) }
    }

    public func renameRegisteredUser(id: UInt32, name: String) {
        queue.async {
            var list = UserListMessage()
            list.users = [RegisteredUser(userId: id, name: name)]
            self.send(list)
        }
    }

    public func removeRegisteredUser(id: UInt32) {
        queue.async {
            var list = UserListMessage()
            list.users = [RegisteredUser(userId: id)]
            self.send(list)
            self.ui { session in session.registeredUsers.removeAll { $0.userId == id } }
        }
    }

    public func setVoiceTarget(_ id: VoiceTargetID, entries: [VoiceTargetEntry]) {
        queue.async { self.send(VoiceTargetMessage(id: UInt32(id.rawValue), targets: entries)) }
    }

    public func setLocalMute(session: UInt32, muted: Bool) {
        queue.async {
            self.users[session]?.isLocallyMuted = muted
            self.ui { $0.users[session]?.isLocallyMuted = muted }
        }
    }

    public func setLocalVolume(session: UInt32, volume: Float) {
        queue.async {
            self.users[session]?.localVolume = volume
            self.ui { $0.users[session]?.localVolume = volume }
        }
    }

    private func ui(_ body: @escaping @MainActor (ServerSession) -> Void) {
        let session = self.session
        DispatchQueue.main.async {
            MainActor.assumeIsolated { body(session) }
        }
    }
}
#endif
