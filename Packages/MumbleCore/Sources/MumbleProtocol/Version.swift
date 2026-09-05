import Foundation

public struct ProtocolVersion: Comparable, Hashable, CustomStringConvertible, Sendable {
    public var major: UInt16
    public var minor: UInt16
    public var patch: UInt16

    public init(_ major: UInt16, _ minor: UInt16, _ patch: UInt16) {
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    public static let client = ProtocolVersion(1, 5, 735)

    public static let protobufUDPIntroduced = ProtocolVersion(1, 5, 0)

    public static let unknown = ProtocolVersion(0, 0, 0)

    public var v1: UInt32 {
        UInt32(major) << 16 | UInt32(min(minor, 255)) << 8 | UInt32(min(patch, 255))
    }

    public var v2: UInt64 {
        UInt64(major) << 48 | UInt64(minor) << 32 | UInt64(patch) << 16
    }

    public init(v1: UInt32) {
        major = UInt16(v1 >> 16)
        minor = UInt16((v1 >> 8) & 0xFF)
        patch = UInt16(v1 & 0xFF)
    }

    public init(v2: UInt64) {
        major = UInt16((v2 >> 48) & 0xFFFF)
        minor = UInt16((v2 >> 32) & 0xFFFF)
        patch = UInt16((v2 >> 16) & 0xFFFF)
    }

    public var usesProtobufUDP: Bool { self >= .protobufUDPIntroduced }

    public var description: String { "\(major).\(minor).\(patch)" }

    public static func < (lhs: ProtocolVersion, rhs: ProtocolVersion) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        return lhs.patch < rhs.patch
    }
}
