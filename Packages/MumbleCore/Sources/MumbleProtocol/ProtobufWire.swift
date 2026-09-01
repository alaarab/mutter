import Foundation

/// Minimal protocol-buffers wire codec. Mumble's messages only use varint, 32-bit,
/// 64-bit and length-delimited fields, so this covers everything without a code generator.
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
        var v = value
        while v >= 0x80 {
            data.append(UInt8(v & 0x7F) | 0x80)
            v >>= 7
        }
        data.append(UInt8(v))
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
        // Negative int32 is sign-extended to 10 bytes in protobuf.
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
        for v in values { uint32(field, v) }
    }

    public mutating func repeatedInt32(_ field: Int, _ values: [Int32]) {
        for v in values { int32(field, v) }
    }

    public mutating func repeatedString(_ field: Int, _ values: [String]) {
        for v in values { string(field, v) }
    }

    public mutating func repeatedFloat(_ field: Int, _ values: [Float]) {
        for v in values { float(field, v) }
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

    private func byte(at i: Int) -> UInt8? {
        let idx = data.startIndex + i
        return idx < data.endIndex ? data[idx] : nil
    }

    public mutating func readRawVarint() throws -> UInt64 {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        while true {
            guard let b = byte(at: cursor) else { throw ProtobufError.truncated }
            cursor += 1
            result |= UInt64(b & 0x7F) << shift
            if b & 0x80 == 0 { return result }
            shift += 7
            if shift > 63 { throw ProtobufError.truncated }
        }
    }

    public mutating func next() throws -> ProtobufField? {
        if isAtEnd { return nil }
        let key = try readRawVarint()
        let number = Int(key >> 3)
        guard let wt = WireType(rawValue: UInt8(key & 0x07)) else { throw ProtobufError.badWireType }
        switch wt {
        case .varint:
            let v = try readRawVarint()
            return ProtobufField(number: number, wireType: wt, varint: v, payload: Data())
        case .fixed64:
            guard cursor + 8 <= data.count else { throw ProtobufError.truncated }
            let start = data.startIndex + cursor
            let slice = data[start..<(start + 8)]
            cursor += 8
            var v: UInt64 = 0
            withUnsafeMutableBytes(of: &v) { $0.copyBytes(from: slice) }
            return ProtobufField(number: number, wireType: wt, varint: UInt64(littleEndian: v), payload: Data(slice))
        case .fixed32:
            guard cursor + 4 <= data.count else { throw ProtobufError.truncated }
            let start = data.startIndex + cursor
            let slice = data[start..<(start + 4)]
            cursor += 4
            var v: UInt32 = 0
            withUnsafeMutableBytes(of: &v) { $0.copyBytes(from: slice) }
            return ProtobufField(number: number, wireType: wt, varint: UInt64(UInt32(littleEndian: v)), payload: Data(slice))
        case .lengthDelimited:
            let len = Int(try readRawVarint())
            guard len >= 0, cursor + len <= data.count else { throw ProtobufError.truncated }
            let start = data.startIndex + cursor
            let slice = Data(data[start..<(start + len)])
            cursor += len
            return ProtobufField(number: number, wireType: wt, varint: 0, payload: slice)
        case .startGroup, .endGroup:
            throw ProtobufError.badWireType
        }
    }

    /// Iterates every field, handing each to `handler`. Unknown fields are simply skipped by the caller.
    public mutating func forEachField(_ handler: (ProtobufField) throws -> Void) throws {
        while let f = try next() {
            try handler(f)
        }
    }
}
