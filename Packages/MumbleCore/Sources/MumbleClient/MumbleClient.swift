#if canImport(Network)
import Foundation
import Network
import Security
import MumbleProtocol

/// What to do about a server certificate the app has not seen before, or that changed.
public enum CertificateTrustQuestion: Sendable {
    case firstContact(ServerCertificateInfo)
    case changed(expected: Data, actual: ServerCertificateInfo)
}

public struct ConnectionOptions {
    public var username: String
    public var password: String?
    public var tokens: [String] = []
    public var identity: SecIdentity?
    /// SHA-256 of the server certificate we accepted last time. nil on first contact.
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

/// Receives decoded audio from the network. Called on the client's network queue.
public protocol VoiceSink: AnyObject {
    func receiveAudio(_ packet: AudioPacket)
    func voiceStreamsDidReset()
}

/// The Mumble client: owns the control and voice connections, drives the handshake,
/// keeps `session` in sync, and shuttles Opus frames in both directions.
public final class MumbleClient {
    public let session: ServerSession
    public weak var voiceSink: VoiceSink?
    /// Asked when a server presents an unknown or changed certificate. Return true to accept.
    public var certificateTrust: ((CertificateTrustQuestion) async -> Bool)?
    /// Called when a connection succeeds so the app can remember the fingerprint.
    public var didAcceptCertificate: ((ServerEndpoint, ServerCertificateInfo) -> Void)?

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
    private var pendingCertificate: ServerCertificateInfo?

    private var pingTimer: DispatchSourceTimer?
    private var talkTimer: DispatchSourceTimer?
    private var lastUDPReply: Date?
    private var udpAvailable = false
    private var tcpPingSamples: [Double] = []
    private var udpPingSamples: [Double] = []
    private var tcpPacketsSent: UInt32 = 0
    private var frameNumber: UInt64 = 0
    private var talkers: [UInt32: Date] = [:]
    private var users: [UInt32: User] = [:]     // authoritative copy on the network queue
    private var channels: [UInt32: Channel] = [:]

    @MainActor
    public init() {
        session = ServerSession()
    }

    // MARK: - Connection lifecycle

    public func connect(to endpoint: ServerEndpoint, options: ConnectionOptions) {
        queue.async {
            self.teardown(keepState: false)
            self.endpoint = endpoint
            self.options = options
            self.intentionalDisconnect = false
            self.reconnectAttempt = 0
            self.ui { s in
                s.reset()
                s.messages = []
                s.notices = []
                s.lastError = nil
                s.endpoint = endpoint
                s.state = .connecting
            }
            self.openControl()
        }
    }

    public func disconnect() {
        queue.async {
            self.intentionalDisconnect = true
            self.teardown(keepState: false)
            self.ui { s in
                s.state = .disconnected
                s.isTransmitting = false
                s.appendNotice(.disconnected(reason: nil))
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
            // No UI hook: trust on first use, refuse changes.
            if case .firstContact = question { complete(true) } else { complete(false) }
            return
        }
        Task {
            let ok = await handler(question)
            self.queue.async { complete(ok) }
        }
    }

    private func teardown(keepState: Bool) {
        pingTimer?.cancel(); pingTimer = nil
        talkTimer?.cancel(); talkTimer = nil
        control?.cancel(); control = nil
        voice?.cancel(); voice = nil
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
        teardown(keepState: true)
        let canRetry = (options?.autoReconnect ?? false) && !intentionalDisconnect && wasSynced
        if case .rejected = error { scheduleReconnect(false, error: error); return }
        if case .certificateRejected = error { scheduleReconnect(false, error: error); return }
        if case .certificateChanged = error { scheduleReconnect(false, error: error); return }
        scheduleReconnect(canRetry, error: error)
    }

    private func scheduleReconnect(_ retry: Bool, error: ConnectionError) {
        if retry && reconnectAttempt < 6 {
            reconnectAttempt += 1
            let attempt = reconnectAttempt
            let delay = min(30.0, pow(2.0, Double(attempt)))
            ui { s in
                s.state = .reconnecting(attempt: attempt)
                s.lastError = error
                s.isTransmitting = false
                s.appendNotice(.disconnected(reason: error.errorDescription))
            }
            queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, !self.intentionalDisconnect, self.control == nil else { return }
                self.ui { $0.state = .connecting }
                self.openControl()
            }
        } else {
            ui { s in
                s.state = .disconnected
                s.lastError = error
                s.isTransmitting = false
                s.appendNotice(.disconnected(reason: error.errorDescription))
            }
        }
    }

    // MARK: - Control channel

    private func handleControl(_ event: ControlConnection.Event) {
        switch event {
        case .ready:
            ui { $0.state = .authenticating }
            sendHandshake()
        case .frame(let frame):
            do {
                let message = try IncomingMessage.decode(type: frame.type, payload: frame.payload)
                handle(message)
            } catch {
                // A malformed message is not fatal; skip it.
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
        var auth = AuthenticateMessage(username: options.username, password: options.password, tokens: options.tokens)
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
        case .version(let v):
            serverVersion = v.protocolVersion
            wireFormat = VoiceWireFormat(serverVersion: serverVersion)
            ui { s in
                s.serverInfo.version = v.protocolVersion
                s.serverInfo.release = v.release
                s.serverInfo.os = v.os
                s.serverInfo.osVersion = v.osVersion
            }

        case .reject(let r):
            intentionalDisconnect = true
            fail(.rejected(r.type, reason: r.reason))

        case .cryptSetup(let c):
            handleCryptSetup(c)

        case .codecVersion(let c):
            if c.opus != true {
                ui { $0.appendNotice(.info("This server does not allow Opus; voice will not work.")) }
            }

        case .channelState(let c):
            applyChannelState(c)

        case .channelRemove(let c):
            channels[c.channelId] = nil
            let removed = c.channelId
            ui { $0.channels[removed] = nil }

        case .userState(let u):
            applyUserState(u)

        case .userRemove(let u):
            let name = users[u.session]?.name ?? "Someone"
            let actorName = u.actor.flatMap { users[$0]?.name }
            users[u.session] = nil
            talkers[u.session] = nil
            let wasKicked = u.actor != nil && actorName != nil
            ui { s in
                s.users[u.session] = nil
                if s.isConnected || u.session == s.mySession {
                    s.appendNotice(.userLeft(name: name, reason: u.reason, wasKicked: wasKicked, wasBanned: u.ban ?? false))
                }
            }
            if u.session == mySession {
                intentionalDisconnect = true
                let reason = u.reason ?? (u.ban == true ? "You were banned." : "You were kicked.")
                fail(.network(reason))
            }

        case .serverSync(let sync):
            mySession = sync.session
            isSynced = true
            reconnectAttempt = 0
            let cert = pendingCertificate
            let ep = endpoint
            let permissions = Permissions(rawValue: UInt32(truncatingIfNeeded: sync.permissions ?? 0))
            ui { s in
                s.mySession = sync.session
                s.serverInfo.welcomeText = sync.welcomeText
                s.serverInfo.maxBandwidth = sync.maxBandwidth
                s.serverInfo.permissions = permissions
                s.serverCertificate = cert
                s.state = .connected
                s.appendNotice(.connected)
                if let welcome = sync.welcomeText, !welcome.isEmpty {
                    s.appendMessage(ChatMessage(senderSession: nil, senderName: "Server", html: welcome, scope: .system))
                }
            }
            if let cert, let ep { didAcceptCertificate?(ep, cert) }
            startTimers()
            requestMissingBlobs()

        case .serverConfig(let c):
            ui { s in
                if let v = c.maxBandwidth { s.serverInfo.maxBandwidth = v }
                if let v = c.welcomeText, s.serverInfo.welcomeText == nil { s.serverInfo.welcomeText = v }
                if let v = c.allowHtml { s.serverInfo.allowHTML = v }
                s.serverInfo.messageLength = c.messageLength
                s.serverInfo.imageMessageLength = c.imageMessageLength
                s.serverInfo.maxUsers = c.maxUsers
                if let v = c.recordingAllowed { s.serverInfo.recordingAllowed = v }
            }

        case .suggestConfig(let c):
            ui { $0.serverInfo.suggestsPushToTalk = c.pushToTalk }

        case .permissionQuery(let q):
            guard let id = q.channelId else { return }
            let perms = Permissions(rawValue: q.permissions ?? 0)
            channels[id]?.permissions = perms
            ui { s in
                if q.flush == true {
                    for key in s.channels.keys { s.channels[key]?.permissions = nil }
                }
                s.channels[id]?.permissions = perms
            }

        case .permissionDenied(let p):
            let text = p.userMessage
            ui { $0.appendNotice(.permissionDenied(text)) }

        case .textMessage(let t):
            handleTextMessage(t)

        case .ping(let p):
            if let ts = p.timestamp {
                let rtt = Double(nowMicros() &- ts) / 1000.0
                tcpPingSamples.append(rtt)
                if tcpPingSamples.count > 20 { tcpPingSamples.removeFirst() }
            }
            publishStats()

        case .udpTunnel(let t):
            handleVoicePacket(t.packet, viaTunnel: true)

        case .userList(let l):
            ui { $0.registeredUsers = l.users }

        case .userStats(let st):
            guard let s = st.session else { return }
            ui { $0.users[s]?.stats = st }

        case .unhandled:
            break
        }
    }

    private func handleCryptSetup(_ c: CryptSetupMessage) {
        if let key = c.key, let cn = c.clientNonce, let sn = c.serverNonce {
            if crypt.setKey(key, clientNonce: cn, serverNonce: sn) {
                openVoice()
            }
        } else if let sn = c.serverNonce {
            _ = crypt.setDecryptIV([UInt8](sn))
        } else {
            // Server asks for our nonce.
            send(CryptSetupMessage(clientNonce: Data(crypt.encryptIV)))
        }
    }

    private func applyChannelState(_ c: ChannelStateMessage) {
        guard let id = c.channelId else { return }
        var channel = channels[id] ?? Channel(id: id, parentID: c.parent, name: c.name ?? "")
        if let p = c.parent { channel.parentID = (id == Channel.rootID) ? nil : p }
        if let n = c.name { channel.name = n }
        if let d = c.description { channel.description = d; channel.descriptionHash = nil }
        if let h = c.descriptionHash { channel.descriptionHash = h }
        if let p = c.position { channel.position = p }
        if let t = c.temporary { channel.isTemporary = t }
        if let m = c.maxUsers { channel.maxUsers = m }
        if !c.links.isEmpty { channel.links = Set(c.links) }
        for l in c.linksAdd { channel.links.insert(l) }
        for l in c.linksRemove { channel.links.remove(l) }
        if let r = c.isEnterRestricted { channel.isEnterRestricted = r }
        if let e = c.canEnter { channel.canEnter = e }
        channels[id] = channel
        let snapshot = channel
        ui { s in
            var merged = snapshot
            merged.permissions = s.channels[id]?.permissions ?? snapshot.permissions
            s.channels[id] = merged
        }
    }

    private func applyUserState(_ u: UserStateMessage) {
        guard let sessionID = u.session else { return }
        let isNew = users[sessionID] == nil
        var user = users[sessionID] ?? User(session: sessionID, name: u.name ?? "")
        let previousChannel = user.channelID
        if let n = u.name { user.name = n }
        if let id = u.userId { user.userID = id }
        if let ch = u.channelId { user.channelID = ch }
        if let v = u.mute { user.isMuted = v }
        if let v = u.deaf { user.isDeafened = v }
        if let v = u.suppress { user.isSuppressed = v }
        if let v = u.selfMute { user.isSelfMuted = v }
        if let v = u.selfDeaf { user.isSelfDeafened = v }
        if let v = u.prioritySpeaker { user.isPrioritySpeaker = v }
        if let v = u.recording { user.isRecording = v }
        if let v = u.comment { user.comment = v; user.commentHash = nil }
        if let v = u.commentHash { user.commentHash = v }
        if let v = u.hash { user.hash = v }
        if let v = u.texture { user.texture = v; user.textureHash = nil }
        if let v = u.textureHash { user.textureHash = v }
        for c in u.listeningChannelAdd { user.listeningChannels.insert(c) }
        for c in u.listeningChannelRemove { user.listeningChannels.remove(c) }
        users[sessionID] = user

        let synced = isSynced
        let me = mySession
        let actorName = u.actor.flatMap { users[$0]?.name }
        let movedToChannelName = (u.channelId != nil && !isNew && previousChannel != user.channelID) ? (channels[user.channelID]?.name ?? "a channel") : nil
        let snapshot = user

        ui { s in
            var merged = snapshot
            if let existing = s.users[sessionID] {
                merged.isTalking = existing.isTalking
                merged.talkingContext = existing.talkingContext
                merged.isLocallyMuted = existing.isLocallyMuted
                merged.localVolume = existing.localVolume
                merged.lastTalkedAt = existing.lastTalkedAt
                merged.stats = existing.stats
            }
            s.users[sessionID] = merged
            guard synced else { return }
            if isNew {
                s.appendNotice(.userJoined(name: merged.name))
            } else if let target = movedToChannelName {
                let myChannel = s.me?.channelID
                let involvesMe = sessionID == me || previousChannel == myChannel || merged.channelID == myChannel
                if involvesMe {
                    let actor = (u.actor == sessionID) ? nil : actorName
                    s.appendNotice(.userMoved(name: merged.name, toChannel: target, byActor: actor))
                }
            }
        }

        // Fetch comments/avatars we only have hashes for.
        if u.commentHash != nil && u.comment == nil {
            send(RequestBlobMessage(sessionComment: [sessionID]))
        }
        if u.textureHash != nil && u.texture == nil {
            send(RequestBlobMessage(sessionTexture: [sessionID]))
        }
    }

    private func requestMissingBlobs() {
        let wanted = channels.values.filter { $0.descriptionHash != nil && $0.description == nil }.map { $0.id }
        if !wanted.isEmpty { send(RequestBlobMessage(channelDescription: wanted)) }
    }

    private func handleTextMessage(_ t: TextMessageMessage) {
        let senderName = t.actor.flatMap { users[$0]?.name } ?? "Server"
        let scope: MessageScope
        if let me = mySession, t.sessions.contains(me) {
            scope = .user(t.actor ?? 0)
        } else if let ch = t.channelIds.first {
            scope = .channel(ch)
        } else if let tree = t.treeIds.first {
            scope = .tree(tree)
        } else {
            scope = .system
        }
        let message = ChatMessage(senderSession: t.actor, senderName: senderName, html: t.message, scope: scope)
        ui { s in
            s.appendMessage(message)
            s.appendNotice(.textMessage(message))
        }
    }

    // MARK: - Voice channel

    private func openVoice() {
        guard let endpoint else { return }
        voice?.cancel()
        let v = VoiceConnection(endpoint: endpoint, queue: queue)
        v.onDatagram = { [weak self] data in self?.handleDatagram(data) }
        v.onFailure = { [weak self] _ in
            self?.udpAvailable = false
        }
        voice = v
        v.start()
        queue.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.sendUDPPing() }
    }

    private func handleDatagram(_ data: Data) {
        guard let plain = crypt.decrypt(data) else { return }
        handleVoicePacket(plain, viaTunnel: false)
    }

    private func handleVoicePacket(_ data: Data, viaTunnel: Bool) {
        guard let packet = VoiceCodec.decode(data, format: wireFormat) else { return }
        switch packet {
        case .ping(let p):
            if !viaTunnel {
                lastUDPReply = Date()
                let rtt = Double(nowMicros() &- p.timestamp) / 1000.0
                if rtt >= 0 && rtt < 60_000 {
                    udpPingSamples.append(rtt)
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
                ui { s in
                    s.users[sender]?.isTalking = false
                    s.users[sender]?.lastTalkedAt = Date()
                }
            }
            return
        }
        talkers[sender] = Date()
        if !wasTalking {
            ui { s in
                s.users[sender]?.isTalking = true
                s.users[sender]?.talkingContext = context
            }
        }
    }

    private func sweepTalkers() {
        let cutoff = Date().addingTimeInterval(-0.4)
        let stale = talkers.filter { $0.value < cutoff }.map { $0.key }
        guard !stale.isEmpty else { return }
        for s in stale { talkers[s] = nil }
        ui { s in
            for id in stale {
                s.users[id]?.isTalking = false
                s.users[id]?.lastTalkedAt = Date()
            }
        }
    }

    /// Sends one encoded Opus packet. Safe to call from the audio thread.
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

    // MARK: - Timers & stats

    private func startTimers() {
        pingTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 5.0)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        pingTimer = t

        talkTimer?.cancel()
        let tt = DispatchSource.makeTimerSource(queue: queue)
        tt.schedule(deadline: .now() + 0.25, repeating: 0.25)
        tt.setEventHandler { [weak self] in self?.sweepTalkers() }
        tt.resume()
        talkTimer = tt
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

        // UDP health: no reply in 10 s means the path is blocked; fall back to the tunnel.
        if udpAvailable, let last = lastUDPReply, Date().timeIntervalSince(last) > 10 {
            udpAvailable = false
            ui { s in
                s.stats.isUsingUDP = false
                s.appendNotice(.info("UDP is blocked on this network. Voice is tunnelled over TCP."))
            }
        }

        // Crypt resync: nothing decrypted for a while although we are receiving on TCP.
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

    private func average(_ xs: [Double]) -> Double {
        xs.isEmpty ? 0 : xs.reduce(0, +) / Double(xs.count)
    }

    private func variance(_ xs: [Double]) -> Double {
        guard xs.count > 1 else { return 0 }
        let m = average(xs)
        return xs.reduce(0) { $0 + ($1 - m) * ($1 - m) } / Double(xs.count - 1)
    }

    private func nowMicros() -> UInt64 {
        DispatchTime.now().uptimeNanoseconds / 1000
    }

    // MARK: - User actions

    public func join(channel channelID: UInt32) {
        queue.async {
            guard let me = self.mySession else { return }
            var u = UserStateMessage()
            u.session = me
            u.channelId = channelID
            self.send(u)
        }
    }

    public func setSelfMute(_ muted: Bool) {
        queue.async {
            guard let me = self.mySession else { return }
            var u = UserStateMessage()
            u.session = me
            u.selfMute = muted
            if !muted { u.selfDeaf = false }
            self.send(u)
        }
    }

    public func setSelfDeaf(_ deaf: Bool) {
        queue.async {
            guard let me = self.mySession else { return }
            var u = UserStateMessage()
            u.session = me
            u.selfDeaf = deaf
            if deaf { u.selfMute = true }
            self.send(u)
        }
    }

    public func setComment(_ comment: String) {
        queue.async {
            guard let me = self.mySession else { return }
            var u = UserStateMessage()
            u.session = me
            u.comment = comment
            self.send(u)
        }
    }

    public func setRecording(_ on: Bool) {
        queue.async {
            guard let me = self.mySession else { return }
            var u = UserStateMessage()
            u.session = me
            u.recording = on
            self.send(u)
        }
    }

    public func setPrioritySpeaker(session: UInt32, on: Bool) {
        queue.async {
            var u = UserStateMessage()
            u.session = session
            u.prioritySpeaker = on
            self.send(u)
        }
    }

    public func setListening(channel channelID: UInt32, listening: Bool) {
        queue.async {
            guard let me = self.mySession else { return }
            var u = UserStateMessage()
            u.session = me
            if listening { u.listeningChannelAdd = [channelID] } else { u.listeningChannelRemove = [channelID] }
            self.send(u)
        }
    }

    public func registerSelf() {
        queue.async {
            guard let me = self.mySession else { return }
            var u = UserStateMessage()
            u.session = me
            u.userId = 0
            self.send(u)
        }
    }

    public func moveUser(session: UInt32, to channelID: UInt32) {
        queue.async {
            var u = UserStateMessage()
            u.session = session
            u.channelId = channelID
            self.send(u)
        }
    }

    public func serverMute(session: UInt32, mute: Bool) {
        queue.async {
            var u = UserStateMessage()
            u.session = session
            u.mute = mute
            self.send(u)
        }
    }

    public func serverDeafen(session: UInt32, deaf: Bool) {
        queue.async {
            var u = UserStateMessage()
            u.session = session
            u.deaf = deaf
            if deaf { u.mute = true }
            self.send(u)
        }
    }

    public func kick(session: UInt32, reason: String, ban: Bool) {
        queue.async {
            self.send(UserRemoveMessage(session: session, reason: reason, ban: ban))
        }
    }

    public func sendText(html: String, to scope: MessageScope) {
        queue.async {
            var t: TextMessageMessage
            switch scope {
            case .channel(let id): t = TextMessageMessage(message: html, channelIds: [id])
            case .tree(let id): t = TextMessageMessage(message: html, treeIds: [id])
            case .user(let id): t = TextMessageMessage(message: html, sessions: [id])
            case .system: return
            }
            t.actor = nil
            self.send(t)
            let myName = self.mySession.flatMap { self.users[$0]?.name } ?? "Me"
            let me = self.mySession
            let message = ChatMessage(senderSession: me, senderName: myName, html: html, scope: scope, isOwn: true)
            self.ui { $0.appendMessage(message) }
        }
    }

    public func createChannel(name: String, parent: UInt32, temporary: Bool, description: String? = nil) {
        queue.async {
            var c = ChannelStateMessage()
            c.parent = parent
            c.name = name
            c.temporary = temporary
            c.description = description
            self.send(c)
        }
    }

    public func removeChannel(_ id: UInt32) {
        queue.async { self.send(ChannelRemoveMessage(channelId: id)) }
    }

    public func renameChannel(_ id: UInt32, name: String) {
        queue.async {
            var c = ChannelStateMessage()
            c.channelId = id
            c.name = name
            self.send(c)
        }
    }

    public func linkChannels(_ id: UInt32, add: [UInt32] = [], remove: [UInt32] = []) {
        queue.async {
            var c = ChannelStateMessage()
            c.channelId = id
            c.linksAdd = add
            c.linksRemove = remove
            self.send(c)
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

    /// Renames a registered account (needs the Register permission on the root channel).
    public func renameRegisteredUser(id: UInt32, name: String) {
        queue.async {
            var list = UserListMessage()
            list.users = [RegisteredUser(userId: id, name: name)]
            self.send(list)
        }
    }

    /// Deletes a registered account. Sending an entry without a name removes it.
    public func removeRegisteredUser(id: UInt32) {
        queue.async {
            var list = UserListMessage()
            list.users = [RegisteredUser(userId: id)]
            self.send(list)
            self.ui { s in s.registeredUsers.removeAll { $0.userId == id } }
        }
    }

    /// Registers a whisper/shout target the audio engine can then transmit to with `target`.
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

    // MARK: - Main-thread bridge

    private func ui(_ body: @escaping @MainActor (ServerSession) -> Void) {
        let session = self.session
        DispatchQueue.main.async {
            MainActor.assumeIsolated { body(session) }
        }
    }
}
#endif
