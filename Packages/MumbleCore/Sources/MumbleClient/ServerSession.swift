#if canImport(Observation)
import Foundation
import Observation
import MumbleProtocol

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
    public internal(set) var totalNoticesPosted = 0
    public internal(set) var totalMessagesPosted = 0
    public internal(set) var stats = ConnectionStats()
    public internal(set) var registeredUsers: [RegisteredUser] = []
    public internal(set) var isTransmitting = false
    public internal(set) var unreadCount = 0
    public internal(set) var serverCertificate: ServerCertificateInfo?
    public var isChatVisible = false {
        didSet { if isChatVisible { unreadCount = 0 } }
    }

    public init() {}

    public var me: User? {
        guard let sessionID = mySession else { return nil }
        return users[sessionID]
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
            .sorted { left, right in
                if left.position != right.position { return left.position < right.position }
                return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
            }
    }

    public func users(in channelID: UInt32) -> [User] {
        users.values
            .filter { $0.channelID == channelID }
            .sorted { left, right in
                if left.isPrioritySpeaker != right.isPrioritySpeaker { return left.isPrioritySpeaker }
                return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
            }
    }

    public func userCount(inTree channelID: UInt32) -> Int {
        var childrenByParent: [UInt32: [UInt32]] = [:]
        for channel in channels.values {
            guard let parentID = channel.parentID, parentID != channel.id else { continue }
            childrenByParent[parentID, default: []].append(channel.id)
        }
        var usersByChannel: [UInt32: Int] = [:]
        for user in users.values { usersByChannel[user.channelID, default: 0] += 1 }
        var count = 0
        var visited: Set<UInt32> = []
        var pending = [channelID]
        while let current = pending.popLast() {
            guard visited.insert(current).inserted else { continue }
            count += usersByChannel[current] ?? 0
            pending.append(contentsOf: childrenByParent[current] ?? [])
        }
        return count
    }

    public func path(to channelID: UInt32) -> [Channel] {
        Channel.ancestry(of: channelID, in: channels)
    }

    public var talkingUsers: [User] {
        users.values.filter { $0.isTalking }.sorted { $0.name < $1.name }
    }

    public func messages(for scope: MessageScope?) -> [ChatMessage] {
        guard let scope else { return messages }
        return messages.filter { $0.scope == scope || $0.scope == .system }
    }

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
        totalNoticesPosted += 1
        if notices.count > 200 { notices.removeFirst(notices.count - 200) }
    }

    func appendMessage(_ message: ChatMessage) {
        messages.append(message)
        totalMessagesPosted += 1
        if messages.count > 2000 { messages.removeFirst(messages.count - 2000) }
        if !message.isOwn && !isChatVisible { unreadCount += 1 }
    }
}
#endif
