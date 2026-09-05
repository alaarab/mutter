import Foundation

public enum MessageType: UInt16, CaseIterable, Sendable {
    case version = 0
    case udpTunnel = 1
    case authenticate = 2
    case ping = 3
    case reject = 4
    case serverSync = 5
    case channelRemove = 6
    case channelState = 7
    case userRemove = 8
    case userState = 9
    case banList = 10
    case textMessage = 11
    case permissionDenied = 12
    case acl = 13
    case queryUsers = 14
    case cryptSetup = 15
    case contextActionModify = 16
    case contextAction = 17
    case userList = 18
    case voiceTarget = 19
    case permissionQuery = 20
    case codecVersion = 21
    case userStats = 22
    case requestBlob = 23
    case serverConfig = 24
    case suggestConfig = 25
    case pluginDataTransmission = 26
}

public struct Permissions: OptionSet, Hashable, Sendable {
    public let rawValue: UInt32
    public init(rawValue: UInt32) { self.rawValue = rawValue }

    public static let none = Permissions([])
    public static let write = Permissions(rawValue: 0x1)
    public static let traverse = Permissions(rawValue: 0x2)
    public static let enter = Permissions(rawValue: 0x4)
    public static let speak = Permissions(rawValue: 0x8)
    public static let muteDeafen = Permissions(rawValue: 0x10)
    public static let move = Permissions(rawValue: 0x20)
    public static let makeChannel = Permissions(rawValue: 0x40)
    public static let linkChannel = Permissions(rawValue: 0x80)
    public static let whisper = Permissions(rawValue: 0x100)
    public static let textMessage = Permissions(rawValue: 0x200)
    public static let makeTempChannel = Permissions(rawValue: 0x400)
    public static let listen = Permissions(rawValue: 0x800)
    public static let kick = Permissions(rawValue: 0x10000)
    public static let ban = Permissions(rawValue: 0x20000)
    public static let register = Permissions(rawValue: 0x40000)
    public static let selfRegister = Permissions(rawValue: 0x80000)
    public static let resetUserContent = Permissions(rawValue: 0x100000)
    public static let cached = Permissions(rawValue: 0x8000000)
    public static let all = Permissions(rawValue: 0xf07ff)
}
