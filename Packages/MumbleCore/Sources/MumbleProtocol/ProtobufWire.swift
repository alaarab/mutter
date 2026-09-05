import Foundation

public enum WireType: UInt8 {
    case varint = 0
    case fixed64 = 1
    case lengthDelimited = 2
    case startGroup = 3
    case endGroup = 4
    case fixed32 = 5
}

public struct ProtobufWriter {
    public private(set) var data = Data()

    public init() {}

    private mutating func key(_ field: Int, _ type: WireType) {
        writeRawVarint(UInt64(field << 3) | UInt64(type.rawValue))
    }

    public mutating func writeRawVarint(_ value: UInt64) {
        var remaining = value
        while remaining >= 0x80 {
            data.append(UInt8(remaining & 0x7F) | 0x80)
            remaining >>= 7
        }
        data.append(UInt8(remaining))
    }

    public mutating func uint32(_ field: Int, _ value: UInt32?) {
        guard let value else { return }
        key(field, .varint)
        writeRawVarint(UInt64(value))
    }

    public mutating func uint64(_ field: Int, _ value: UInt64?) {
        guard let value else { return }
        key(field, .varint)
        writeRawVarint(value)
    }

    public mutating func int32(_ field: Int, _ value: Int32?) {
        guard let value else { return }
        key(field, .varint)
        writeRawVarint(UInt64(bitPattern: Int64(value)))
    }

    public mutating func bool(_ field: Int, _ value: Bool?) {
        guard let value else { return }
        key(field, .varint)
        writeRawVarint(value ? 1 : 0)
    }

    public mutating func float(_ field: Int, _ value: Float?) {
        guard let value else { return }
        key(field, .fixed32)
        var bits = value.bitPattern.littleEndian
        withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
    }

    public mutating func string(_ field: Int, _ value: String?) {
        guard let value else { return }
        bytes(field, Data(value.utf8))
    }

    public mutating func bytes(_ field: Int, _ value: Data?) {
        guard let value else { return }
        key(field, .lengthDelimited)
        writeRawVarint(UInt64(value.count))
        data.append(value)
    }

    public mutating func message(_ field: Int, _ body: Data?) {
        bytes(field, body)
    }

    public mutating func repeatedUInt32(_ field: Int, _ values: [UInt32]) {
        for value in values { uint32(field, value) }
    }

    public mutating func repeatedInt32(_ field: Int, _ values: [Int32]) {
        for value in values { int32(field, value) }
    }

    public mutating func repeatedString(_ field: Int, _ values: [String]) {
        for value in values { string(field, value) }
    }

    public mutating func repeatedFloat(_ field: Int, _ values: [Float]) {
        for value in values { float(field, value) }
    }
}

public struct ProtobufField {
    public let number: Int
    public let wireType: WireType
    public let varint: UInt64
    public let payload: Data

    public var uint32Value: UInt32 { UInt32(truncatingIfNeeded: varint) }
    public var uint64Value: UInt64 { varint }
    public var int32Value: Int32 { Int32(truncatingIfNeeded: Int64(bitPattern: varint)) }
    public var boolValue: Bool { varint != 0 }
    public var stringValue: String { String(decoding: payload, as: UTF8.self) }
    public var floatValue: Float {
        guard wireType == .fixed32, payload.count == 4 else { return 0 }
        var bits: UInt32 = 0
        withUnsafeMutableBytes(of: &bits) { $0.copyBytes(from: payload) }
        return Float(bitPattern: UInt32(littleEndian: bits))
    }
}

public enum ProtobufError: Error {
    case truncated
    case badWireType
}

public struct ProtobufReader {
    private let data: Data
    private var cursor: Int

    public init(_ data: Data) {
        self.data = data
        self.cursor = 0
    }

    public var isAtEnd: Bool { cursor >= data.count }

    private func byte(at index: Int) -> UInt8? {
        let position = data.startIndex + index
        return position < data.endIndex ? data[position] : nil
    }

    public mutating func readRawVarint() throws -> UInt64 {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        while true {
            guard let byte = byte(at: cursor) else { throw ProtobufError.truncated }
            cursor += 1
            result |= UInt64(byte & 0x7F) << shift
            if byte & 0x80 == 0 { return result }
            shift += 7
            if shift > 63 { throw ProtobufError.truncated }
        }
    }

    private mutating func readFixed(_ count: Int) throws -> Data {
        guard cursor + count <= data.count else { throw ProtobufError.truncated }
        let start = data.startIndex + cursor
        let slice = data[start..<(start + count)]
        cursor += count
        return Data(slice)
    }

    public mutating func next() throws -> ProtobufField? {
        if isAtEnd { return nil }
        let key = try readRawVarint()
        let number = Int(key >> 3)
        guard let wireType = WireType(rawValue: UInt8(key & 0x07)) else { throw ProtobufError.badWireType }
        switch wireType {
        case .varint:
            let value = try readRawVarint()
            return ProtobufField(number: number, wireType: wireType, varint: value, payload: Data())
        case .fixed64:
            let slice = try readFixed(8)
            var value: UInt64 = 0
            withUnsafeMutableBytes(of: &value) { $0.copyBytes(from: slice) }
            return ProtobufField(number: number, wireType: wireType, varint: UInt64(littleEndian: value), payload: slice)
        case .fixed32:
            let slice = try readFixed(4)
            var value: UInt32 = 0
            withUnsafeMutableBytes(of: &value) { $0.copyBytes(from: slice) }
            return ProtobufField(number: number, wireType: wireType, varint: UInt64(UInt32(littleEndian: value)), payload: slice)
        case .lengthDelimited:
            let length = Int(try readRawVarint())
            guard length >= 0 else { throw ProtobufError.truncated }
            let slice = try readFixed(length)
            return ProtobufField(number: number, wireType: wireType, varint: 0, payload: slice)
        case .startGroup, .endGroup:
            throw ProtobufError.badWireType
        }
    }

    public mutating func forEachField(_ handler: (ProtobufField) throws -> Void) throws {
        while let field = try next() {
            try handler(field)
        }
    }
}
