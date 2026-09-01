#if canImport(Observation)
import Foundation
import Observation
import MumbleProtocol

/// Observable snapshot of everything the UI needs to render a connected server.
/// Mutated only on the main actor by `MumbleClient`.
@MainActor
@Observable
public final class ServerSession {
    public internal(set) var state: ConnectionState = .disconnected
    public internal(set) var lastError: ConnectionError?
    public internal(set) var endpoint: ServerEndpoint?
    public internal(set) var serverInfo = ServerInfo()
    public internal(set) var channels: [UInt32: Channel] = [:]
    public internal(set) var users: [UInt32: User] = [:]
    public internal(set) var mySession: UInt32?
    public internal(set) var messages: [ChatMessage] = []
    public internal(set) var notices: [SessionNotice] = []
    public internal(set) var stats = ConnectionStats()
    public internal(set) var registeredUsers: [RegisteredUser] = []
    public internal(set) var isTransmitting = false
    public internal(set) var unreadCount = 0
    /// The certificate the server presented on this connection, once the TLS handshake completed.
    public internal(set) var serverCertificate: ServerCertificateInfo?
    /// Number of messages that arrived while the chat view was not visible; the app resets it.
    public var isChatVisible = false {
        didSet { if isChatVisible { unreadCount = 0 } }
    }

    public init() {}

    // MARK: Derived state

    public var me: User? {
        guard let s = mySession else { return nil }
        return users[s]
    }

    public var myChannel: Channel? {
        guard let me else { return nil }
        return channels[me.channelID]
    }

    public var isConnected: Bool { state == .connected }

    public var rootChannel: Channel? { channels[Channel.rootID] }

    public func children(of channelID: UInt32) -> [Channel] {
        channels.values
            .filter { $0.parentID == channelID && $0.id != channelID }
            .sorted { a, b in
                if a.position != b.position { return a.position < b.position }
                return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
    }

    public func users(in channelID: UInt32) -> [User] {
        users.values
            .filter { $0.channelID == channelID }
            .sorted { a, b in
                if a.isPrioritySpeaker != b.isPrioritySpeaker { return a.isPrioritySpeaker }
                return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
            }
    }

    /// Total users in a channel and all of its descendants.
    public func userCount(inTree channelID: UInt32) -> Int {
        var count = users.values.filter { $0.channelID == channelID }.count
        for c in children(of: channelID) { count += userCount(inTree: c.id) }
        return count
    }

    public func path(to channelID: UInt32) -> [Channel] {
        var out: [Channel] = []
        var current = channels[channelID]
        while let c = current {
            out.insert(c, at: 0)
            guard let p = c.parentID, p != c.id else { break }
            current = channels[p]
        }
        return out
    }

    public var talkingUsers: [User] {
        users.values.filter { $0.isTalking }.sorted { $0.name < $1.name }
    }

    public func messages(for scope: MessageScope?) -> [ChatMessage] {
        guard let scope else { return messages }
        return messages.filter { $0.scope == scope || $0.scope == .system }
    }

    // MARK: Internal mutation helpers

    func reset() {
        channels = [:]
        users = [:]
        mySession = nil
        serverInfo = ServerInfo()
        stats = ConnectionStats()
        registeredUsers = []
        isTransmitting = false
    }

    func appendNotice(_ notice: SessionNotice) {
        notices.append(notice)
        if notices.count > 200 { notices.removeFirst(notices.count - 200) }
    }

    func appendMessage(_ message: ChatMessage) {
        messages.append(message)
        if messages.count > 2000 { messages.removeFirst(messages.count - 2000) }
        if !message.isOwn && !isChatVisible { unreadCount += 1 }
    }
}
#endif
