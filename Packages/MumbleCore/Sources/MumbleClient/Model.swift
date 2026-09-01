import Foundation
import MumbleProtocol

public struct ServerEndpoint: Hashable, Codable, Sendable {
    public var host: String
    public var port: UInt16

    public init(host: String, port: UInt16 = 64738) {
        self.host = host
        self.port = port
    }

    public var displayString: String {
        port == 64738 ? host : "\(host):\(port)"
    }
}

public struct Channel: Identifiable, Hashable, Sendable {
    public var id: UInt32
    public var parentID: UInt32?
    public var name: String
    public var description: String?
    public var descriptionHash: Data?
    public var position: Int32 = 0
    public var isTemporary = false
    public var maxUsers: UInt32 = 0
    public var links: Set<UInt32> = []
    public var isEnterRestricted = false
    public var canEnter = true
    public var permissions: Permissions?

    public init(id: UInt32, parentID: UInt32?, name: String) {
        self.id = id
        self.parentID = parentID
        self.name = name
    }

    public static let rootID: UInt32 = 0
}

public struct User: Identifiable, Hashable, Sendable {
    public var id: UInt32 { session }
    public var session: UInt32
    public var name: String
    public var userID: UInt32?
    public var channelID: UInt32 = Channel.rootID
    public var isMuted = false
    public var isDeafened = false
    public var isSuppressed = false
    public var isSelfMuted = false
    public var isSelfDeafened = false
    public var isPrioritySpeaker = false
    public var isRecording = false
    public var comment: String?
    public var commentHash: Data?
    public var hash: String?
    public var texture: Data?
    public var textureHash: Data?
    public var listeningChannels: Set<UInt32> = []

    // Local-only state
    public var isTalking = false
    public var talkingContext: AudioContext = .normal
    public var isLocallyMuted = false
    public var localVolume: Float = 1.0
    public var lastTalkedAt: Date?
    public var stats: UserStatsMessage?

    public init(session: UInt32, name: String) {
        self.session = session
        self.name = name
    }

    public var isRegistered: Bool { userID != nil }

    /// True when the user can't be heard (any mute or suppression).
    public var isSilenced: Bool { isMuted || isSelfMuted || isSuppressed }
}

public enum MessageScope: Hashable, Sendable {
    case channel(UInt32)
    case tree(UInt32)
    case user(UInt32)
    case system
}

public struct ChatMessage: Identifiable, Hashable, Sendable {
    public var id = UUID()
    public var date = Date()
    public var senderSession: UInt32?
    public var senderName: String
    public var html: String
    public var scope: MessageScope
    public var isOwn = false

    public init(senderSession: UInt32?, senderName: String, html: String, scope: MessageScope, isOwn: Bool = false) {
        self.senderSession = senderSession
        self.senderName = senderName
        self.html = html
        self.scope = scope
        self.isOwn = isOwn
    }

    public var isSystem: Bool { scope == .system }
}

public struct ServerInfo: Hashable, Sendable {
    public var version: ProtocolVersion = .unknown
    public var release: String?
    public var os: String?
    public var osVersion: String?
    public var welcomeText: String?
    public var maxBandwidth: UInt32?
    public var maxUsers: UInt32?
    public var allowHTML = true
    public var messageLength: UInt32?
    public var imageMessageLength: UInt32?
    public var recordingAllowed = true
    public var suggestsPushToTalk: Bool?
    public var permissions: Permissions = .none

    public init() {}
}

public struct ConnectionStats: Hashable, Sendable {
    public var tcpPingAverageMs: Double = 0
    public var udpPingAverageMs: Double = 0
    public var udpGood: UInt32 = 0
    public var udpLate: UInt32 = 0
    public var udpLost: UInt32 = 0
    public var udpResync: UInt32 = 0
    public var udpPacketsSent: UInt32 = 0
    public var tcpPacketsSent: UInt32 = 0
    public var isUsingUDP = false
    public var bytesOut: UInt64 = 0
    public var bytesIn: UInt64 = 0

    public init() {}
}

public enum ConnectionState: Hashable, Sendable {
    case disconnected
    case resolving
    case connecting
    case authenticating
    case synchronizing
    case connected
    case reconnecting(attempt: Int)

    public var isActive: Bool {
        switch self {
        case .disconnected: return false
        default: return true
        }
    }
}

public struct ServerCertificateInfo: Hashable, Sendable {
    public var subjectSummary: String
    public var sha256Fingerprint: Data
    public var sha1Fingerprint: Data
    public var notValidAfter: Date?
    public var derChain: [Data]

    public var fingerprintDisplay: String {
        sha256Fingerprint.map { String(format: "%02X", $0) }.joined(separator: ":")
    }
}

public enum ConnectionError: Error, LocalizedError, Sendable {
    case rejected(RejectType, reason: String?)
    case certificateChanged(expected: Data, actual: ServerCertificateInfo)
    case certificateRejected
    case network(String)
    case closedByServer
    case timeout
    case invalidResponse(String)

    public var errorDescription: String? {
        switch self {
        case .rejected(let type, let reason):
            if let reason, !reason.isEmpty { return reason }
            return type.userMessage
        case .certificateChanged: return "The server's certificate has changed since you last connected."
        case .certificateRejected: return "You declined the server's certificate."
        case .network(let s): return s
        case .closedByServer: return "The server closed the connection."
        case .timeout: return "The server stopped responding."
        case .invalidResponse(let s): return "Unexpected data from server: \(s)"
        }
    }
}

public enum SessionNotice: Hashable, Sendable {
    case userJoined(name: String)
    case userLeft(name: String, reason: String?, wasKicked: Bool, wasBanned: Bool)
    case userMoved(name: String, toChannel: String, byActor: String?)
    case permissionDenied(String)
    case textMessage(ChatMessage)
    case disconnected(reason: String?)
    case connected
    case info(String)

    public var text: String {
        switch self {
        case .userJoined(let n): return "\(n) connected"
        case .userLeft(let n, let reason, let kicked, let banned):
            var s = banned ? "\(n) was banned" : (kicked ? "\(n) was kicked" : "\(n) disconnected")
            if let reason, !reason.isEmpty { s += " (\(reason))" }
            return s
        case .userMoved(let n, let ch, let actor):
            if let actor { return "\(actor) moved \(n) to \(ch)" }
            return "\(n) moved to \(ch)"
        case .permissionDenied(let s): return s
        case .textMessage(let m): return "\(m.senderName): \(m.html)"
        case .disconnected(let r): return r.map { "Disconnected: \($0)" } ?? "Disconnected"
        case .connected: return "Connected"
        case .info(let s): return s
        }
    }
}
