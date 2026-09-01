import Foundation

/// TCP control channel framing: 2-byte big-endian type, 4-byte big-endian payload length, payload.
public enum ControlFraming {
    public static let headerSize = 6
    /// Servers reject anything larger; keeps a hostile peer from making us allocate unbounded memory.
    public static let maxPayload = 8 * 1024 * 1024

    public static func frame(type: UInt16, payload: Data) -> Data {
        var out = Data(capacity: headerSize + payload.count)
        out.append(UInt8(type >> 8))
        out.append(UInt8(type & 0xFF))
        let len = UInt32(payload.count)
        out.append(UInt8((len >> 24) & 0xFF))
        out.append(UInt8((len >> 16) & 0xFF))
        out.append(UInt8((len >> 8) & 0xFF))
        out.append(UInt8(len & 0xFF))
        out.append(payload)
        return out
    }

    public static func frame<M: ControlMessage>(_ message: M) -> Data {
        frame(type: M.messageType.rawValue, payload: message.encodePayload())
    }
}

public struct ControlFrame: Equatable, Sendable {
    public var type: UInt16
    public var payload: Data

    public init(type: UInt16, payload: Data) {
        self.type = type
        self.payload = payload
    }
}

public enum ControlFramingError: Error {
    case payloadTooLarge(Int)
}

/// Accumulates bytes from the socket and yields complete frames.
public struct ControlFrameParser {
    private var buffer = Data()

    public init() {}

    public mutating func append(_ data: Data) {
        buffer.append(data)
    }

    public mutating func nextFrame() throws -> ControlFrame? {
        guard buffer.count >= ControlFraming.headerSize else { return nil }
        let b = buffer
        let s = b.startIndex
        let type = UInt16(b[s]) << 8 | UInt16(b[s + 1])
        let len = Int(UInt32(b[s + 2]) << 24 | UInt32(b[s + 3]) << 16 | UInt32(b[s + 4]) << 8 | UInt32(b[s + 5]))
        if len > ControlFraming.maxPayload { throw ControlFramingError.payloadTooLarge(len) }
        let total = ControlFraming.headerSize + len
        guard b.count >= total else { return nil }
        let payload = Data(b[(s + ControlFraming.headerSize)..<(s + total)])
        buffer = Data(b[(s + total)...])
        return ControlFrame(type: type, payload: payload)
    }

    public var pendingBytes: Int { buffer.count }
}
