import Foundation

/// Mumble's own variable-length integer used inside legacy UDP voice packets.
/// This is NOT the protobuf varint. Prefix table (from the protocol docs):
///
///   0xxxxxxx                       7-bit positive
///   10xxxxxx + 1 byte              14-bit positive
///   110xxxxx + 2 bytes             21-bit positive
///   1110xxxx + 3 bytes             28-bit positive
///   111100__ + 4 bytes             32-bit positive
///   111101__ + 8 bytes             64-bit positive
///   111110__ + varint              negative recursive varint
///   111111xx                       byte-inverted negative two bit number (-1 ... -4)
public enum MumbleVarint {

    public static func encode(_ value: Int64, into data: inout Data) {
        var v = value
        if v < 0 {
            if v >= -4 {
                data.append(UInt8(0xFC | (Int(~v) & 0x03)))
                return
            }
            data.append(0xF8)
            v = ~v
            encode(v, into: &data)
            return
        }
        let u = UInt64(v)
        if u < 0x80 {
            data.append(UInt8(u))
        } else if u < 0x4000 {
            data.append(UInt8((u >> 8) | 0x80))
            data.append(UInt8(u & 0xFF))
        } else if u < 0x200000 {
            data.append(UInt8((u >> 16) | 0xC0))
            data.append(UInt8((u >> 8) & 0xFF))
            data.append(UInt8(u & 0xFF))
        } else if u < 0x10000000 {
            data.append(UInt8((u >> 24) | 0xE0))
            data.append(UInt8((u >> 16) & 0xFF))
            data.append(UInt8((u >> 8) & 0xFF))
            data.append(UInt8(u & 0xFF))
        } else if u < 0x100000000 {
            data.append(0xF0)
            data.append(UInt8((u >> 24) & 0xFF))
            data.append(UInt8((u >> 16) & 0xFF))
            data.append(UInt8((u >> 8) & 0xFF))
            data.append(UInt8(u & 0xFF))
        } else {
            data.append(0xF4)
            for shift in stride(from: 56, through: 0, by: -8) {
                data.append(UInt8((u >> UInt64(shift)) & 0xFF))
            }
        }
    }

    public static func encoded(_ value: Int64) -> Data {
        var d = Data()
        encode(value, into: &d)
        return d
    }

    /// Decodes a varint starting at `offset`. Advances `offset` past it. Returns nil on truncation.
    public static func decode(_ data: Data, offset: inout Int) -> Int64? {
        guard offset < data.count else { return nil }
        let bytes = data
        let base = bytes.startIndex
        func byte(_ i: Int) -> UInt8? {
            let idx = base + i
            return idx < bytes.endIndex ? bytes[idx] : nil
        }
        guard let v = byte(offset) else { return nil }
        if v & 0x80 == 0 {
            offset += 1
            return Int64(v & 0x7F)
        }
        if v & 0xC0 == 0x80 {
            guard let b1 = byte(offset + 1) else { return nil }
            offset += 2
            return Int64(UInt64(v & 0x3F) << 8 | UInt64(b1))
        }
        switch v & 0xF0 {
        case 0xC0:
            guard let b1 = byte(offset + 1), let b2 = byte(offset + 2) else { return nil }
            offset += 3
            return Int64(UInt64(v & 0x1F) << 16 | UInt64(b1) << 8 | UInt64(b2))
        case 0xD0:
            guard let b1 = byte(offset + 1), let b2 = byte(offset + 2) else { return nil }
            offset += 3
            return Int64(UInt64(v & 0x1F) << 16 | UInt64(b1) << 8 | UInt64(b2))
        case 0xE0:
            guard let b1 = byte(offset + 1), let b2 = byte(offset + 2), let b3 = byte(offset + 3) else { return nil }
            offset += 4
            return Int64(UInt64(v & 0x0F) << 24 | UInt64(b1) << 16 | UInt64(b2) << 8 | UInt64(b3))
        case 0xF0:
            switch v & 0xFC {
            case 0xF0:
                guard let b1 = byte(offset + 1), let b2 = byte(offset + 2),
                      let b3 = byte(offset + 3), let b4 = byte(offset + 4) else { return nil }
                offset += 5
                return Int64(UInt64(b1) << 24 | UInt64(b2) << 16 | UInt64(b3) << 8 | UInt64(b4))
            case 0xF4:
                var result: UInt64 = 0
                for i in 1...8 {
                    guard let b = byte(offset + i) else { return nil }
                    result = (result << 8) | UInt64(b)
                }
                offset += 9
                return Int64(bitPattern: result)
            case 0xF8:
                offset += 1
                guard let inner = decode(data, offset: &offset) else { return nil }
                return ~inner
            case 0xFC:
                offset += 1
                return ~Int64(v & 0x03)
            default:
                return nil
            }
        default:
            return nil
        }
    }
}
