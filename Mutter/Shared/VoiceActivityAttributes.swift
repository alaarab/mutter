import ActivityKit
import Foundation

struct VoiceActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var channelName: String
        var speakers: [String]
        var isMuted: Bool
        var isDeafened: Bool
        var isTransmitting: Bool
        var onlineCount: Int
        var isPushToTalk: Bool
        var isWhispering: Bool
    }

    var serverName: String
}
