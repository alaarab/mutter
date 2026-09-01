import Foundation

/// A message that can be sent on the control channel.
public protocol ControlMessage {
    static var messageType: MessageType { get }
    func encodePayload() -> Data
}

/// A message that can be received on the control channel.
public protocol DecodableControlMessage: ControlMessage {
    init(payload: Data) throws
}

// MARK: - Version (0)

public struct VersionMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.version
    public var versionV1: UInt32?
    public var release: String?
    public var os: String?
    public var osVersion: String?
    public var versionV2: UInt64?

    public init(version: ProtocolVersion, release: String, os: String, osVersion: String) {
        self.versionV1 = version.v1
        self.versionV2 = version.v2
        self.release = release
        self.os = os
        self.osVersion = osVersion
    }

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: versionV1 = f.uint32Value
            case 2: release = f.stringValue
            case 3: os = f.stringValue
            case 4: osVersion = f.stringValue
            case 5: versionV2 = f.uint64Value
            default: break
            }
        }
    }

    /// Effective version, preferring the 64-bit encoding when present.
    public var protocolVersion: ProtocolVersion {
        if let v2 = versionV2, v2 != 0 { return ProtocolVersion(v2: v2) }
        if let v1 = versionV1 { return ProtocolVersion(v1: v1) }
        return .unknown
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, versionV1)
        w.string(2, release)
        w.string(3, os)
        w.string(4, osVersion)
        w.uint64(5, versionV2)
        return w.data
    }
}

// MARK: - UDPTunnel (1)

/// Raw voice packet carried over TCP. The payload is a plain (unencrypted) UDP voice packet.
public struct UDPTunnelMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.udpTunnel
    public var packet: Data

    public init(packet: Data) { self.packet = packet }
    public init(payload: Data) throws { self.packet = payload }
    public func encodePayload() -> Data { packet }
}

// MARK: - Authenticate (2)

public struct AuthenticateMessage: ControlMessage, Sendable {
    public static let messageType = MessageType.authenticate
    public var username: String?
    public var password: String?
    public var tokens: [String] = []
    public var celtVersions: [Int32] = []
    public var opus: Bool? = true
    public var clientType: Int32? = 0

    public init(username: String, password: String?, tokens: [String] = []) {
        self.username = username
        self.password = password
        self.tokens = tokens
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.string(1, username)
        w.string(2, password)
        w.repeatedString(3, tokens)
        w.repeatedInt32(4, celtVersions)
        w.bool(5, opus)
        w.int32(6, clientType)
        return w.data
    }
}

// MARK: - Ping (3)

public struct PingMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.ping
    public var timestamp: UInt64?
    public var good: UInt32?
    public var late: UInt32?
    public var lost: UInt32?
    public var resync: UInt32?
    public var udpPackets: UInt32?
    public var tcpPackets: UInt32?
    public var udpPingAvg: Float?
    public var udpPingVar: Float?
    public var tcpPingAvg: Float?
    public var tcpPingVar: Float?

    public init(timestamp: UInt64) { self.timestamp = timestamp }

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: timestamp = f.uint64Value
            case 2: good = f.uint32Value
            case 3: late = f.uint32Value
            case 4: lost = f.uint32Value
            case 5: resync = f.uint32Value
            case 6: udpPackets = f.uint32Value
            case 7: tcpPackets = f.uint32Value
            case 8: udpPingAvg = f.floatValue
            case 9: udpPingVar = f.floatValue
            case 10: tcpPingAvg = f.floatValue
            case 11: tcpPingVar = f.floatValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint64(1, timestamp)
        w.uint32(2, good)
        w.uint32(3, late)
        w.uint32(4, lost)
        w.uint32(5, resync)
        w.uint32(6, udpPackets)
        w.uint32(7, tcpPackets)
        w.float(8, udpPingAvg)
        w.float(9, udpPingVar)
        w.float(10, tcpPingAvg)
        w.float(11, tcpPingVar)
        return w.data
    }
}

// MARK: - Reject (4)

public enum RejectType: UInt32, Sendable {
    case none = 0
    case wrongVersion = 1
    case invalidUsername = 2
    case wrongUserPassword = 3
    case wrongServerPassword = 4
    case usernameInUse = 5
    case serverFull = 6
    case noCertificate = 7
    case authenticatorFail = 8
    case noNewConnections = 9

    public var userMessage: String {
        switch self {
        case .none: return "The server rejected the connection."
        case .wrongVersion: return "This server needs a different client version."
        case .invalidUsername: return "That username is not allowed here."
        case .wrongUserPassword: return "Wrong password for this registered username."
        case .wrongServerPassword: return "Wrong server password."
        case .usernameInUse: return "That username is already in use."
        case .serverFull: return "The server is full."
        case .noCertificate: return "This server requires a certificate."
        case .authenticatorFail: return "The server's authenticator rejected you."
        case .noNewConnections: return "The server is not accepting new connections."
        }
    }
}

public struct RejectMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.reject
    public var type: RejectType = .none
    public var reason: String?

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: type = RejectType(rawValue: f.uint32Value) ?? .none
            case 2: reason = f.stringValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, type.rawValue)
        w.string(2, reason)
        return w.data
    }
}

// MARK: - ServerSync (5)

public struct ServerSyncMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.serverSync
    public var session: UInt32?
    public var maxBandwidth: UInt32?
    public var welcomeText: String?
    public var permissions: UInt64?

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: session = f.uint32Value
            case 2: maxBandwidth = f.uint32Value
            case 3: welcomeText = f.stringValue
            case 4: permissions = f.uint64Value
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, session)
        w.uint32(2, maxBandwidth)
        w.string(3, welcomeText)
        w.uint64(4, permissions)
        return w.data
    }
}

// MARK: - ChannelRemove (6)

public struct ChannelRemoveMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.channelRemove
    public var channelId: UInt32 = 0

    public init(channelId: UInt32) { self.channelId = channelId }

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            if f.number == 1 { channelId = f.uint32Value }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, channelId)
        return w.data
    }
}

// MARK: - ChannelState (7)

public struct ChannelStateMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.channelState
    public var channelId: UInt32?
    public var parent: UInt32?
    public var name: String?
    public var links: [UInt32] = []
    public var description: String?
    public var linksAdd: [UInt32] = []
    public var linksRemove: [UInt32] = []
    public var temporary: Bool?
    public var position: Int32?
    public var descriptionHash: Data?
    public var maxUsers: UInt32?
    public var isEnterRestricted: Bool?
    public var canEnter: Bool?

    public init() {}

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: channelId = f.uint32Value
            case 2: parent = f.uint32Value
            case 3: name = f.stringValue
            case 4: links.append(contentsOf: Self.packedOrSingle(f))
            case 5: description = f.stringValue
            case 6: linksAdd.append(contentsOf: Self.packedOrSingle(f))
            case 7: linksRemove.append(contentsOf: Self.packedOrSingle(f))
            case 8: temporary = f.boolValue
            case 9: position = f.int32Value
            case 10: descriptionHash = f.payload
            case 11: maxUsers = f.uint32Value
            case 12: isEnterRestricted = f.boolValue
            case 13: canEnter = f.boolValue
            default: break
            }
        }
    }

    /// Repeated varint fields may arrive packed (length-delimited) even for proto2 syntax.
    static func packedOrSingle(_ f: ProtobufField) -> [UInt32] {
        if f.wireType == .varint { return [f.uint32Value] }
        var out: [UInt32] = []
        var r = ProtobufReader(f.payload)
        while !r.isAtEnd, let v = try? r.readRawVarint() {
            out.append(UInt32(truncatingIfNeeded: v))
        }
        return out
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, channelId)
        w.uint32(2, parent)
        w.string(3, name)
        w.repeatedUInt32(4, links)
        w.string(5, description)
        w.repeatedUInt32(6, linksAdd)
        w.repeatedUInt32(7, linksRemove)
        w.bool(8, temporary)
        w.int32(9, position)
        w.bytes(10, descriptionHash)
        w.uint32(11, maxUsers)
        w.bool(12, isEnterRestricted)
        w.bool(13, canEnter)
        return w.data
    }
}

// MARK: - UserRemove (8)

public struct UserRemoveMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.userRemove
    public var session: UInt32 = 0
    public var actor: UInt32?
    public var reason: String?
    public var ban: Bool?

    public init(session: UInt32, reason: String?, ban: Bool) {
        self.session = session
        self.reason = reason
        self.ban = ban
    }

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: session = f.uint32Value
            case 2: actor = f.uint32Value
            case 3: reason = f.stringValue
            case 4: ban = f.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, session)
        w.uint32(2, actor)
        w.string(3, reason)
        w.bool(4, ban)
        return w.data
    }
}

// MARK: - UserState (9)

public struct UserStateMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.userState
    public var session: UInt32?
    public var actor: UInt32?
    public var name: String?
    public var userId: UInt32?
    public var channelId: UInt32?
    public var mute: Bool?
    public var deaf: Bool?
    public var suppress: Bool?
    public var selfMute: Bool?
    public var selfDeaf: Bool?
    public var texture: Data?
    public var pluginContext: Data?
    public var pluginIdentity: String?
    public var comment: String?
    public var hash: String?
    public var commentHash: Data?
    public var textureHash: Data?
    public var prioritySpeaker: Bool?
    public var recording: Bool?
    public var temporaryAccessTokens: [String] = []
    public var listeningChannelAdd: [UInt32] = []
    public var listeningChannelRemove: [UInt32] = []

    public init() {}

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: session = f.uint32Value
            case 2: actor = f.uint32Value
            case 3: name = f.stringValue
            case 4: userId = f.uint32Value
            case 5: channelId = f.uint32Value
            case 6: mute = f.boolValue
            case 7: deaf = f.boolValue
            case 8: suppress = f.boolValue
            case 9: selfMute = f.boolValue
            case 10: selfDeaf = f.boolValue
            case 11: texture = f.payload
            case 12: pluginContext = f.payload
            case 13: pluginIdentity = f.stringValue
            case 14: comment = f.stringValue
            case 15: hash = f.stringValue
            case 16: commentHash = f.payload
            case 17: textureHash = f.payload
            case 18: prioritySpeaker = f.boolValue
            case 19: recording = f.boolValue
            case 20: temporaryAccessTokens.append(f.stringValue)
            case 21: listeningChannelAdd.append(contentsOf: ChannelStateMessage.packedOrSingle(f))
            case 22: listeningChannelRemove.append(contentsOf: ChannelStateMessage.packedOrSingle(f))
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, session)
        w.uint32(2, actor)
        w.string(3, name)
        w.uint32(4, userId)
        w.uint32(5, channelId)
        w.bool(6, mute)
        w.bool(7, deaf)
        w.bool(8, suppress)
        w.bool(9, selfMute)
        w.bool(10, selfDeaf)
        w.bytes(11, texture)
        w.bytes(12, pluginContext)
        w.string(13, pluginIdentity)
        w.string(14, comment)
        w.string(15, hash)
        w.bytes(16, commentHash)
        w.bytes(17, textureHash)
        w.bool(18, prioritySpeaker)
        w.bool(19, recording)
        w.repeatedString(20, temporaryAccessTokens)
        w.repeatedUInt32(21, listeningChannelAdd)
        w.repeatedUInt32(22, listeningChannelRemove)
        return w.data
    }
}

// MARK: - TextMessage (11)

public struct TextMessageMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.textMessage
    public var actor: UInt32?
    public var sessions: [UInt32] = []
    public var channelIds: [UInt32] = []
    public var treeIds: [UInt32] = []
    public var message: String = ""

    public init(message: String, sessions: [UInt32] = [], channelIds: [UInt32] = [], treeIds: [UInt32] = []) {
        self.message = message
        self.sessions = sessions
        self.channelIds = channelIds
        self.treeIds = treeIds
    }

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: actor = f.uint32Value
            case 2: sessions.append(contentsOf: ChannelStateMessage.packedOrSingle(f))
            case 3: channelIds.append(contentsOf: ChannelStateMessage.packedOrSingle(f))
            case 4: treeIds.append(contentsOf: ChannelStateMessage.packedOrSingle(f))
            case 5: message = f.stringValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, actor)
        w.repeatedUInt32(2, sessions)
        w.repeatedUInt32(3, channelIds)
        w.repeatedUInt32(4, treeIds)
        w.string(5, message)
        return w.data
    }
}

// MARK: - PermissionDenied (12)

public enum DenyType: UInt32, Sendable {
    case text = 0
    case permission = 1
    case superUser = 2
    case channelName = 3
    case textTooLong = 4
    case h9k = 5
    case temporaryChannel = 6
    case missingCertificate = 7
    case userName = 8
    case channelFull = 9
    case nestingLimit = 10
    case channelCountLimit = 11
    case channelListenerLimit = 12
    case userListenerLimit = 13
}

public struct PermissionDeniedMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.permissionDenied
    public var permission: UInt32?
    public var channelId: UInt32?
    public var session: UInt32?
    public var reason: String?
    public var type: DenyType?
    public var name: String?

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: permission = f.uint32Value
            case 2: channelId = f.uint32Value
            case 3: session = f.uint32Value
            case 4: reason = f.stringValue
            case 5: type = DenyType(rawValue: f.uint32Value)
            case 6: name = f.stringValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, permission)
        w.uint32(2, channelId)
        w.uint32(3, session)
        w.string(4, reason)
        w.uint32(5, type?.rawValue)
        w.string(6, name)
        return w.data
    }

    /// Human-readable explanation.
    public var userMessage: String {
        switch type {
        case .text: return reason ?? "Permission denied."
        case .permission: return "You don't have permission to do that here."
        case .superUser: return "Only the SuperUser can do that."
        case .channelName: return "That channel name is not allowed."
        case .textTooLong: return "That message is too long."
        case .temporaryChannel: return "You can't do that in a temporary channel."
        case .missingCertificate: return "You need a certificate for that."
        case .userName: return "That username is not allowed."
        case .channelFull: return "That channel is full."
        case .nestingLimit: return "Channels are nested too deeply."
        case .channelCountLimit: return "The server has too many channels."
        case .channelListenerLimit, .userListenerLimit: return "Listener limit reached."
        case .h9k: return "Permission denied."
        case nil: return reason ?? "Permission denied."
        }
    }
}

// MARK: - CryptSetup (15)

public struct CryptSetupMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.cryptSetup
    public var key: Data?
    public var clientNonce: Data?
    public var serverNonce: Data?

    public init(key: Data? = nil, clientNonce: Data? = nil, serverNonce: Data? = nil) {
        self.key = key
        self.clientNonce = clientNonce
        self.serverNonce = serverNonce
    }

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: key = f.payload
            case 2: clientNonce = f.payload
            case 3: serverNonce = f.payload
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.bytes(1, key)
        w.bytes(2, clientNonce)
        w.bytes(3, serverNonce)
        return w.data
    }
}

// MARK: - UserList (18)

public struct RegisteredUser: Hashable, Sendable {
    public var userId: UInt32
    public var name: String?
    public var lastSeen: String?
    public var lastChannel: UInt32?
}

public struct UserListMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.userList
    public var users: [RegisteredUser] = []

    public init() {}

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            guard f.number == 1 else { return }
            var inner = ProtobufReader(f.payload)
            var u = RegisteredUser(userId: 0)
            try inner.forEachField { g in
                switch g.number {
                case 1: u.userId = g.uint32Value
                case 2: u.name = g.stringValue
                case 3: u.lastSeen = g.stringValue
                case 4: u.lastChannel = g.uint32Value
                default: break
                }
            }
            users.append(u)
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        for u in users {
            var inner = ProtobufWriter()
            inner.uint32(1, u.userId)
            inner.string(2, u.name)
            inner.string(3, u.lastSeen)
            inner.uint32(4, u.lastChannel)
            w.message(1, inner.data)
        }
        return w.data
    }
}

// MARK: - VoiceTarget (19)

public struct VoiceTargetEntry: Hashable, Sendable {
    public var sessions: [UInt32] = []
    public var channelId: UInt32?
    public var group: String?
    public var links: Bool?
    public var children: Bool?

    public init(sessions: [UInt32] = [], channelId: UInt32? = nil, group: String? = nil, links: Bool? = nil, children: Bool? = nil) {
        self.sessions = sessions
        self.channelId = channelId
        self.group = group
        self.links = links
        self.children = children
    }
}

public struct VoiceTargetMessage: ControlMessage, Sendable {
    public static let messageType = MessageType.voiceTarget
    public var id: UInt32
    public var targets: [VoiceTargetEntry]

    public init(id: UInt32, targets: [VoiceTargetEntry]) {
        self.id = id
        self.targets = targets
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, id)
        for t in targets {
            var inner = ProtobufWriter()
            inner.repeatedUInt32(1, t.sessions)
            inner.uint32(2, t.channelId)
            inner.string(3, t.group)
            inner.bool(4, t.links)
            inner.bool(5, t.children)
            w.message(2, inner.data)
        }
        return w.data
    }
}

// MARK: - PermissionQuery (20)

public struct PermissionQueryMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.permissionQuery
    public var channelId: UInt32?
    public var permissions: UInt32?
    public var flush: Bool?

    public init(channelId: UInt32) { self.channelId = channelId }

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: channelId = f.uint32Value
            case 2: permissions = f.uint32Value
            case 3: flush = f.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, channelId)
        w.uint32(2, permissions)
        w.bool(3, flush)
        return w.data
    }
}

// MARK: - CodecVersion (21)

public struct CodecVersionMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.codecVersion
    public var alpha: Int32 = 0
    public var beta: Int32 = 0
    public var preferAlpha: Bool = true
    public var opus: Bool?

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: alpha = f.int32Value
            case 2: beta = f.int32Value
            case 3: preferAlpha = f.boolValue
            case 4: opus = f.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.int32(1, alpha)
        w.int32(2, beta)
        w.bool(3, preferAlpha)
        w.bool(4, opus)
        return w.data
    }
}

// MARK: - UserStats (22)

public struct PacketStats: Hashable, Sendable {
    public var good: UInt32 = 0
    public var late: UInt32 = 0
    public var lost: UInt32 = 0
    public var resync: UInt32 = 0

    public init() {}

    init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: good = f.uint32Value
            case 2: late = f.uint32Value
            case 3: lost = f.uint32Value
            case 4: resync = f.uint32Value
            default: break
            }
        }
    }
}

public struct UserStatsMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.userStats
    public var session: UInt32?
    public var statsOnly: Bool?
    public var certificates: [Data] = []
    public var fromClient: PacketStats?
    public var fromServer: PacketStats?
    public var udpPackets: UInt32?
    public var tcpPackets: UInt32?
    public var udpPingAvg: Float?
    public var udpPingVar: Float?
    public var tcpPingAvg: Float?
    public var tcpPingVar: Float?
    public var version: VersionMessage?
    public var celtVersions: [Int32] = []
    public var address: Data?
    public var bandwidth: UInt32?
    public var onlineSeconds: UInt32?
    public var idleSeconds: UInt32?
    public var strongCertificate: Bool?
    public var opus: Bool?

    public init(session: UInt32, statsOnly: Bool = false) {
        self.session = session
        self.statsOnly = statsOnly
    }

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: session = f.uint32Value
            case 2: statsOnly = f.boolValue
            case 3: certificates.append(f.payload)
            case 4: fromClient = try PacketStats(payload: f.payload)
            case 5: fromServer = try PacketStats(payload: f.payload)
            case 6: udpPackets = f.uint32Value
            case 7: tcpPackets = f.uint32Value
            case 8: udpPingAvg = f.floatValue
            case 9: udpPingVar = f.floatValue
            case 10: tcpPingAvg = f.floatValue
            case 11: tcpPingVar = f.floatValue
            case 12: version = try VersionMessage(payload: f.payload)
            case 13: celtVersions.append(f.int32Value)
            case 14: address = f.payload
            case 15: bandwidth = f.uint32Value
            case 16: onlineSeconds = f.uint32Value
            case 17: idleSeconds = f.uint32Value
            case 18: strongCertificate = f.boolValue
            case 19: opus = f.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, session)
        w.bool(2, statsOnly)
        return w.data
    }

    /// Formats the 16-byte address field (IPv4-mapped or IPv6) for display.
    public var addressString: String? {
        guard let address, address.count == 16 else { return nil }
        let b = [UInt8](address)
        let v4Prefix: [UInt8] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF]
        if Array(b[0..<12]) == v4Prefix {
            return "\(b[12]).\(b[13]).\(b[14]).\(b[15])"
        }
        var parts: [String] = []
        for i in stride(from: 0, to: 16, by: 2) {
            parts.append(String(format: "%x", UInt16(b[i]) << 8 | UInt16(b[i + 1])))
        }
        return parts.joined(separator: ":")
    }
}

// MARK: - RequestBlob (23)

public struct RequestBlobMessage: ControlMessage, Sendable {
    public static let messageType = MessageType.requestBlob
    public var sessionTexture: [UInt32] = []
    public var sessionComment: [UInt32] = []
    public var channelDescription: [UInt32] = []

    public init(sessionTexture: [UInt32] = [], sessionComment: [UInt32] = [], channelDescription: [UInt32] = []) {
        self.sessionTexture = sessionTexture
        self.sessionComment = sessionComment
        self.channelDescription = channelDescription
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.repeatedUInt32(1, sessionTexture)
        w.repeatedUInt32(2, sessionComment)
        w.repeatedUInt32(3, channelDescription)
        return w.data
    }
}

// MARK: - ServerConfig (24)

public struct ServerConfigMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.serverConfig
    public var maxBandwidth: UInt32?
    public var welcomeText: String?
    public var allowHtml: Bool?
    public var messageLength: UInt32?
    public var imageMessageLength: UInt32?
    public var maxUsers: UInt32?
    public var recordingAllowed: Bool?

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: maxBandwidth = f.uint32Value
            case 2: welcomeText = f.stringValue
            case 3: allowHtml = f.boolValue
            case 4: messageLength = f.uint32Value
            case 5: imageMessageLength = f.uint32Value
            case 6: maxUsers = f.uint32Value
            case 7: recordingAllowed = f.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, maxBandwidth)
        w.string(2, welcomeText)
        w.bool(3, allowHtml)
        w.uint32(4, messageLength)
        w.uint32(5, imageMessageLength)
        w.uint32(6, maxUsers)
        w.bool(7, recordingAllowed)
        return w.data
    }
}

// MARK: - SuggestConfig (25)

public struct SuggestConfigMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.suggestConfig
    public var versionV1: UInt32?
    public var positional: Bool?
    public var pushToTalk: Bool?
    public var versionV2: UInt64?

    public init(payload: Data) throws {
        var r = ProtobufReader(payload)
        try r.forEachField { f in
            switch f.number {
            case 1: versionV1 = f.uint32Value
            case 2: positional = f.boolValue
            case 3: pushToTalk = f.boolValue
            case 4: versionV2 = f.uint64Value
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var w = ProtobufWriter()
        w.uint32(1, versionV1)
        w.bool(2, positional)
        w.bool(3, pushToTalk)
        w.uint64(4, versionV2)
        return w.data
    }
}

// MARK: - Incoming dispatch

/// A decoded control-channel message. Types the client does not model are surfaced as `.unhandled`.
public enum IncomingMessage: Sendable {
    case version(VersionMessage)
    case udpTunnel(UDPTunnelMessage)
    case ping(PingMessage)
    case reject(RejectMessage)
    case serverSync(ServerSyncMessage)
    case channelRemove(ChannelRemoveMessage)
    case channelState(ChannelStateMessage)
    case userRemove(UserRemoveMessage)
    case userState(UserStateMessage)
    case textMessage(TextMessageMessage)
    case permissionDenied(PermissionDeniedMessage)
    case cryptSetup(CryptSetupMessage)
    case userList(UserListMessage)
    case permissionQuery(PermissionQueryMessage)
    case codecVersion(CodecVersionMessage)
    case userStats(UserStatsMessage)
    case serverConfig(ServerConfigMessage)
    case suggestConfig(SuggestConfigMessage)
    case unhandled(type: UInt16, payload: Data)

    public static func decode(type rawType: UInt16, payload: Data) throws -> IncomingMessage {
        guard let type = MessageType(rawValue: rawType) else {
            return .unhandled(type: rawType, payload: payload)
        }
        switch type {
        case .version: return .version(try VersionMessage(payload: payload))
        case .udpTunnel: return .udpTunnel(UDPTunnelMessage(packet: payload))
        case .ping: return .ping(try PingMessage(payload: payload))
        case .reject: return .reject(try RejectMessage(payload: payload))
        case .serverSync: return .serverSync(try ServerSyncMessage(payload: payload))
        case .channelRemove: return .channelRemove(try ChannelRemoveMessage(payload: payload))
        case .channelState: return .channelState(try ChannelStateMessage(payload: payload))
        case .userRemove: return .userRemove(try UserRemoveMessage(payload: payload))
        case .userState: return .userState(try UserStateMessage(payload: payload))
        case .textMessage: return .textMessage(try TextMessageMessage(payload: payload))
        case .permissionDenied: return .permissionDenied(try PermissionDeniedMessage(payload: payload))
        case .cryptSetup: return .cryptSetup(try CryptSetupMessage(payload: payload))
        case .userList: return .userList(try UserListMessage(payload: payload))
        case .permissionQuery: return .permissionQuery(try PermissionQueryMessage(payload: payload))
        case .codecVersion: return .codecVersion(try CodecVersionMessage(payload: payload))
        case .userStats: return .userStats(try UserStatsMessage(payload: payload))
        case .serverConfig: return .serverConfig(try ServerConfigMessage(payload: payload))
        case .suggestConfig: return .suggestConfig(try SuggestConfigMessage(payload: payload))
        default: return .unhandled(type: rawType, payload: payload)
        }
    }
}
