import Foundation

public protocol ControlMessage {
    static var messageType: MessageType { get }
    func encodePayload() -> Data
}

public protocol DecodableControlMessage: ControlMessage {
    init(payload: Data) throws
}

public struct VersionMessage: DecodableControlMessage, Hashable, Sendable {
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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: versionV1 = field.uint32Value
            case 2: release = field.stringValue
            case 3: os = field.stringValue
            case 4: osVersion = field.stringValue
            case 5: versionV2 = field.uint64Value
            default: break
            }
        }
    }

    public var protocolVersion: ProtocolVersion {
        if let v2 = versionV2, v2 != 0 { return ProtocolVersion(v2: v2) }
        if let v1 = versionV1 { return ProtocolVersion(v1: v1) }
        return .unknown
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, versionV1)
        writer.string(2, release)
        writer.string(3, os)
        writer.string(4, osVersion)
        writer.uint64(5, versionV2)
        return writer.data
    }
}

public struct UDPTunnelMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.udpTunnel
    public var packet: Data

    public init(packet: Data) { self.packet = packet }
    public init(payload: Data) throws { self.packet = payload }
    public func encodePayload() -> Data { packet }
}

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
        var writer = ProtobufWriter()
        writer.string(1, username)
        writer.string(2, password)
        writer.repeatedString(3, tokens)
        writer.repeatedInt32(4, celtVersions)
        writer.bool(5, opus)
        writer.int32(6, clientType)
        return writer.data
    }
}

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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: timestamp = field.uint64Value
            case 2: good = field.uint32Value
            case 3: late = field.uint32Value
            case 4: lost = field.uint32Value
            case 5: resync = field.uint32Value
            case 6: udpPackets = field.uint32Value
            case 7: tcpPackets = field.uint32Value
            case 8: udpPingAvg = field.floatValue
            case 9: udpPingVar = field.floatValue
            case 10: tcpPingAvg = field.floatValue
            case 11: tcpPingVar = field.floatValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint64(1, timestamp)
        writer.uint32(2, good)
        writer.uint32(3, late)
        writer.uint32(4, lost)
        writer.uint32(5, resync)
        writer.uint32(6, udpPackets)
        writer.uint32(7, tcpPackets)
        writer.float(8, udpPingAvg)
        writer.float(9, udpPingVar)
        writer.float(10, tcpPingAvg)
        writer.float(11, tcpPingVar)
        return writer.data
    }
}

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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: type = RejectType(rawValue: field.uint32Value) ?? .none
            case 2: reason = field.stringValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, type.rawValue)
        writer.string(2, reason)
        return writer.data
    }
}

public struct ServerSyncMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.serverSync
    public var session: UInt32?
    public var maxBandwidth: UInt32?
    public var welcomeText: String?
    public var permissions: UInt64?

    public init(payload: Data) throws {
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: session = field.uint32Value
            case 2: maxBandwidth = field.uint32Value
            case 3: welcomeText = field.stringValue
            case 4: permissions = field.uint64Value
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, session)
        writer.uint32(2, maxBandwidth)
        writer.string(3, welcomeText)
        writer.uint64(4, permissions)
        return writer.data
    }
}

public struct ChannelRemoveMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.channelRemove
    public var channelId: UInt32 = 0

    public init(channelId: UInt32) { self.channelId = channelId }

    public init(payload: Data) throws {
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            if field.number == 1 { channelId = field.uint32Value }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, channelId)
        return writer.data
    }
}

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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: channelId = field.uint32Value
            case 2: parent = field.uint32Value
            case 3: name = field.stringValue
            case 4: links.append(contentsOf: Self.packedOrSingle(field))
            case 5: description = field.stringValue
            case 6: linksAdd.append(contentsOf: Self.packedOrSingle(field))
            case 7: linksRemove.append(contentsOf: Self.packedOrSingle(field))
            case 8: temporary = field.boolValue
            case 9: position = field.int32Value
            case 10: descriptionHash = field.payload
            case 11: maxUsers = field.uint32Value
            case 12: isEnterRestricted = field.boolValue
            case 13: canEnter = field.boolValue
            default: break
            }
        }
    }

    static func packedOrSingle(_ field: ProtobufField) -> [UInt32] {
        if field.wireType == .varint { return [field.uint32Value] }
        var out: [UInt32] = []
        var reader = ProtobufReader(field.payload)
        while !reader.isAtEnd, let value = try? reader.readRawVarint() {
            out.append(UInt32(truncatingIfNeeded: value))
        }
        return out
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, channelId)
        writer.uint32(2, parent)
        writer.string(3, name)
        writer.repeatedUInt32(4, links)
        writer.string(5, description)
        writer.repeatedUInt32(6, linksAdd)
        writer.repeatedUInt32(7, linksRemove)
        writer.bool(8, temporary)
        writer.int32(9, position)
        writer.bytes(10, descriptionHash)
        writer.uint32(11, maxUsers)
        writer.bool(12, isEnterRestricted)
        writer.bool(13, canEnter)
        return writer.data
    }
}

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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: session = field.uint32Value
            case 2: actor = field.uint32Value
            case 3: reason = field.stringValue
            case 4: ban = field.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, session)
        writer.uint32(2, actor)
        writer.string(3, reason)
        writer.bool(4, ban)
        return writer.data
    }
}

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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: session = field.uint32Value
            case 2: actor = field.uint32Value
            case 3: name = field.stringValue
            case 4: userId = field.uint32Value
            case 5: channelId = field.uint32Value
            case 6: mute = field.boolValue
            case 7: deaf = field.boolValue
            case 8: suppress = field.boolValue
            case 9: selfMute = field.boolValue
            case 10: selfDeaf = field.boolValue
            case 11: texture = field.payload
            case 12: pluginContext = field.payload
            case 13: pluginIdentity = field.stringValue
            case 14: comment = field.stringValue
            case 15: hash = field.stringValue
            case 16: commentHash = field.payload
            case 17: textureHash = field.payload
            case 18: prioritySpeaker = field.boolValue
            case 19: recording = field.boolValue
            case 20: temporaryAccessTokens.append(field.stringValue)
            case 21: listeningChannelAdd.append(contentsOf: ChannelStateMessage.packedOrSingle(field))
            case 22: listeningChannelRemove.append(contentsOf: ChannelStateMessage.packedOrSingle(field))
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, session)
        writer.uint32(2, actor)
        writer.string(3, name)
        writer.uint32(4, userId)
        writer.uint32(5, channelId)
        writer.bool(6, mute)
        writer.bool(7, deaf)
        writer.bool(8, suppress)
        writer.bool(9, selfMute)
        writer.bool(10, selfDeaf)
        writer.bytes(11, texture)
        writer.bytes(12, pluginContext)
        writer.string(13, pluginIdentity)
        writer.string(14, comment)
        writer.string(15, hash)
        writer.bytes(16, commentHash)
        writer.bytes(17, textureHash)
        writer.bool(18, prioritySpeaker)
        writer.bool(19, recording)
        writer.repeatedString(20, temporaryAccessTokens)
        writer.repeatedUInt32(21, listeningChannelAdd)
        writer.repeatedUInt32(22, listeningChannelRemove)
        return writer.data
    }
}

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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: actor = field.uint32Value
            case 2: sessions.append(contentsOf: ChannelStateMessage.packedOrSingle(field))
            case 3: channelIds.append(contentsOf: ChannelStateMessage.packedOrSingle(field))
            case 4: treeIds.append(contentsOf: ChannelStateMessage.packedOrSingle(field))
            case 5: message = field.stringValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, actor)
        writer.repeatedUInt32(2, sessions)
        writer.repeatedUInt32(3, channelIds)
        writer.repeatedUInt32(4, treeIds)
        writer.string(5, message)
        return writer.data
    }
}

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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: permission = field.uint32Value
            case 2: channelId = field.uint32Value
            case 3: session = field.uint32Value
            case 4: reason = field.stringValue
            case 5: type = DenyType(rawValue: field.uint32Value)
            case 6: name = field.stringValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, permission)
        writer.uint32(2, channelId)
        writer.uint32(3, session)
        writer.string(4, reason)
        writer.uint32(5, type?.rawValue)
        writer.string(6, name)
        return writer.data
    }

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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: key = field.payload
            case 2: clientNonce = field.payload
            case 3: serverNonce = field.payload
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.bytes(1, key)
        writer.bytes(2, clientNonce)
        writer.bytes(3, serverNonce)
        return writer.data
    }
}

public struct RegisteredUser: Hashable, Sendable {
    public var userId: UInt32
    public var name: String?
    public var lastSeen: String?
    public var lastChannel: UInt32?

    public init(userId: UInt32, name: String? = nil, lastSeen: String? = nil, lastChannel: UInt32? = nil) {
        self.userId = userId
        self.name = name
        self.lastSeen = lastSeen
        self.lastChannel = lastChannel
    }
}

public struct UserListMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.userList
    public var users: [RegisteredUser] = []

    public init() {}

    public init(payload: Data) throws {
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            guard field.number == 1 else { return }
            var inner = ProtobufReader(field.payload)
            var user = RegisteredUser(userId: 0)
            try inner.forEachField { userField in
                switch userField.number {
                case 1: user.userId = userField.uint32Value
                case 2: user.name = userField.stringValue
                case 3: user.lastSeen = userField.stringValue
                case 4: user.lastChannel = userField.uint32Value
                default: break
                }
            }
            users.append(user)
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        for user in users {
            var inner = ProtobufWriter()
            inner.uint32(1, user.userId)
            inner.string(2, user.name)
            inner.string(3, user.lastSeen)
            inner.uint32(4, user.lastChannel)
            writer.message(1, inner.data)
        }
        return writer.data
    }
}

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
        var writer = ProtobufWriter()
        writer.uint32(1, id)
        for target in targets {
            var inner = ProtobufWriter()
            inner.repeatedUInt32(1, target.sessions)
            inner.uint32(2, target.channelId)
            inner.string(3, target.group)
            inner.bool(4, target.links)
            inner.bool(5, target.children)
            writer.message(2, inner.data)
        }
        return writer.data
    }
}

public struct PermissionQueryMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.permissionQuery
    public var channelId: UInt32?
    public var permissions: UInt32?
    public var flush: Bool?

    public init(channelId: UInt32) { self.channelId = channelId }

    public init(payload: Data) throws {
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: channelId = field.uint32Value
            case 2: permissions = field.uint32Value
            case 3: flush = field.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, channelId)
        writer.uint32(2, permissions)
        writer.bool(3, flush)
        return writer.data
    }
}

public struct CodecVersionMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.codecVersion
    public var alpha: Int32 = 0
    public var beta: Int32 = 0
    public var preferAlpha: Bool = true
    public var opus: Bool?

    public init(payload: Data) throws {
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: alpha = field.int32Value
            case 2: beta = field.int32Value
            case 3: preferAlpha = field.boolValue
            case 4: opus = field.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.int32(1, alpha)
        writer.int32(2, beta)
        writer.bool(3, preferAlpha)
        writer.bool(4, opus)
        return writer.data
    }
}

public struct PacketStats: Hashable, Sendable {
    public var good: UInt32 = 0
    public var late: UInt32 = 0
    public var lost: UInt32 = 0
    public var resync: UInt32 = 0

    public init() {}

    init(payload: Data) throws {
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: good = field.uint32Value
            case 2: late = field.uint32Value
            case 3: lost = field.uint32Value
            case 4: resync = field.uint32Value
            default: break
            }
        }
    }
}

public struct UserStatsMessage: DecodableControlMessage, Hashable, Sendable {
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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: session = field.uint32Value
            case 2: statsOnly = field.boolValue
            case 3: certificates.append(field.payload)
            case 4: fromClient = try PacketStats(payload: field.payload)
            case 5: fromServer = try PacketStats(payload: field.payload)
            case 6: udpPackets = field.uint32Value
            case 7: tcpPackets = field.uint32Value
            case 8: udpPingAvg = field.floatValue
            case 9: udpPingVar = field.floatValue
            case 10: tcpPingAvg = field.floatValue
            case 11: tcpPingVar = field.floatValue
            case 12: version = try VersionMessage(payload: field.payload)
            case 13: celtVersions.append(field.int32Value)
            case 14: address = field.payload
            case 15: bandwidth = field.uint32Value
            case 16: onlineSeconds = field.uint32Value
            case 17: idleSeconds = field.uint32Value
            case 18: strongCertificate = field.boolValue
            case 19: opus = field.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, session)
        writer.bool(2, statsOnly)
        return writer.data
    }

    public var addressString: String? {
        guard let address, address.count == 16 else { return nil }
        let bytes = [UInt8](address)
        let v4Prefix: [UInt8] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF]
        if Array(bytes[0..<12]) == v4Prefix {
            return "\(bytes[12]).\(bytes[13]).\(bytes[14]).\(bytes[15])"
        }
        var parts: [String] = []
        for i in stride(from: 0, to: 16, by: 2) {
            parts.append(String(format: "%x", UInt16(bytes[i]) << 8 | UInt16(bytes[i + 1])))
        }
        return parts.joined(separator: ":")
    }
}

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
        var writer = ProtobufWriter()
        writer.repeatedUInt32(1, sessionTexture)
        writer.repeatedUInt32(2, sessionComment)
        writer.repeatedUInt32(3, channelDescription)
        return writer.data
    }
}

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
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: maxBandwidth = field.uint32Value
            case 2: welcomeText = field.stringValue
            case 3: allowHtml = field.boolValue
            case 4: messageLength = field.uint32Value
            case 5: imageMessageLength = field.uint32Value
            case 6: maxUsers = field.uint32Value
            case 7: recordingAllowed = field.boolValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, maxBandwidth)
        writer.string(2, welcomeText)
        writer.bool(3, allowHtml)
        writer.uint32(4, messageLength)
        writer.uint32(5, imageMessageLength)
        writer.uint32(6, maxUsers)
        writer.bool(7, recordingAllowed)
        return writer.data
    }
}

public struct SuggestConfigMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.suggestConfig
    public var versionV1: UInt32?
    public var positional: Bool?
    public var pushToTalk: Bool?
    public var versionV2: UInt64?

    public init(payload: Data) throws {
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: versionV1 = field.uint32Value
            case 2: positional = field.boolValue
            case 3: pushToTalk = field.boolValue
            case 4: versionV2 = field.uint64Value
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        writer.uint32(1, versionV1)
        writer.bool(2, positional)
        writer.bool(3, pushToTalk)
        writer.uint64(4, versionV2)
        return writer.data
    }
}

public struct PluginDataTransmissionMessage: DecodableControlMessage, Sendable {
    public static let messageType = MessageType.pluginDataTransmission
    public static let maxDataLength = 1000
    public var senderSession: UInt32?
    public var receiverSessions: [UInt32] = []
    public var data: Data = Data()
    public var dataId: String = ""

    public init(receiverSessions: [UInt32], dataId: String, data: Data) {
        self.receiverSessions = receiverSessions
        self.dataId = dataId
        self.data = data
    }

    public init(payload: Data) throws {
        var reader = ProtobufReader(payload)
        try reader.forEachField { field in
            switch field.number {
            case 1: senderSession = field.uint32Value
            case 2: receiverSessions.append(contentsOf: ChannelStateMessage.packedOrSingle(field))
            case 3: data = field.payload
            case 4: dataId = field.stringValue
            default: break
            }
        }
    }

    public func encodePayload() -> Data {
        var writer = ProtobufWriter()
        for receiver in receiverSessions { writer.uint32(2, receiver) }
        writer.bytes(3, data)
        writer.string(4, dataId)
        return writer.data
    }
}

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
    case pluginDataTransmission(PluginDataTransmissionMessage)
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
        case .pluginDataTransmission: return .pluginDataTransmission(try PluginDataTransmissionMessage(payload: payload))
        default: return .unhandled(type: rawType, payload: payload)
        }
    }
}
