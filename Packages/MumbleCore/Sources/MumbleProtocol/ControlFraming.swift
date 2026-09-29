import Foundation

public enum ControlFraming {
    public static let headerSize = 6
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

public struct ControlFrameParser {
    private var buffer = Data()
    private var readOffset = 0

    public init() {}

    public mutating func append(_ data: Data) {
        discardConsumedBytes()
        buffer.append(data)
    }

    public mutating func nextFrame() throws -> ControlFrame? {
        guard pendingBytes >= ControlFraming.headerSize else { return nil }
        let start = buffer.startIndex + readOffset
        let type = UInt16(buffer[start]) << 8 | UInt16(buffer[start + 1])
        let length = Int(UInt32(buffer[start + 2]) << 24 | UInt32(buffer[start + 3]) << 16 | UInt32(buffer[start + 4]) << 8 | UInt32(buffer[start + 5]))
        if length > ControlFraming.maxPayload { throw ControlFramingError.payloadTooLarge(length) }
        let total = ControlFraming.headerSize + length
        guard pendingBytes >= total else { return nil }
        let payload = buffer.subdata(in: (start + ControlFraming.headerSize)..<(start + total))
        readOffset += total
        if readOffset == buffer.count {
            buffer.removeAll(keepingCapacity: true)
            readOffset = 0
        }
        return ControlFrame(type: type, payload: payload)
    }

    public var pendingBytes: Int { buffer.count - readOffset }

    private mutating func discardConsumedBytes() {
        guard readOffset > 0 else { return }
        buffer.removeSubrange(buffer.startIndex..<(buffer.startIndex + readOffset))
        readOffset = 0
    }
}
