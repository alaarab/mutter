import Foundation

public enum MumbleVarint {
    public static func encode(_ value: Int64, into data: inout Data) {
        if value < 0 {
            if value >= -4 {
                data.append(UInt8(0xFC | (Int(~value) & 0x03)))
                return
            }
            data.append(0xF8)
            encode(~value, into: &data)
            return
        }
        let magnitude = UInt64(value)
        if magnitude < 0x80 {
            data.append(UInt8(magnitude))
        } else if magnitude < 0x4000 {
            data.append(UInt8((magnitude >> 8) | 0x80))
            appendBigEndian(magnitude, byteCount: 1, into: &data)
        } else if magnitude < 0x200000 {
            data.append(UInt8((magnitude >> 16) | 0xC0))
            appendBigEndian(magnitude, byteCount: 2, into: &data)
        } else if magnitude < 0x10000000 {
            data.append(UInt8((magnitude >> 24) | 0xE0))
            appendBigEndian(magnitude, byteCount: 3, into: &data)
        } else if magnitude < 0x100000000 {
            data.append(0xF0)
            appendBigEndian(magnitude, byteCount: 4, into: &data)
        } else {
            data.append(0xF4)
            appendBigEndian(magnitude, byteCount: 8, into: &data)
        }
    }

    public static func encoded(_ value: Int64) -> Data {
        var data = Data()
        encode(value, into: &data)
        return data
    }

    public static func decode(_ data: Data, offset: inout Int) -> Int64? {
        guard offset < data.count else { return nil }
        let base = data.startIndex
        func byte(_ index: Int) -> UInt8? {
            let position = base + index
            return position < data.endIndex ? data[position] : nil
        }
        guard let first = byte(offset) else { return nil }
        if first & 0x80 == 0 {
            offset += 1
            return Int64(first & 0x7F)
        }
        if first & 0xC0 == 0x80 {
            return readBigEndian(byte, offset: &offset, byteCount: 1, highBits: UInt64(first & 0x3F))
        }
        switch first & 0xF0 {
        case 0xC0, 0xD0:
            return readBigEndian(byte, offset: &offset, byteCount: 2, highBits: UInt64(first & 0x1F))
        case 0xE0:
            return readBigEndian(byte, offset: &offset, byteCount: 3, highBits: UInt64(first & 0x0F))
        case 0xF0:
            switch first & 0xFC {
            case 0xF0:
                return readBigEndian(byte, offset: &offset, byteCount: 4, highBits: 0)
            case 0xF4:
                return readBigEndian(byte, offset: &offset, byteCount: 8, highBits: 0)
            case 0xF8:
                offset += 1
                guard let inner = decode(data, offset: &offset) else { return nil }
                return ~inner
            case 0xFC:
                offset += 1
                return ~Int64(first & 0x03)
            default:
                return nil
            }
        default:
            return nil
        }
    }

    private static func appendBigEndian(_ value: UInt64, byteCount: Int, into data: inout Data) {
        for shift in stride(from: (byteCount - 1) * 8, through: 0, by: -8) {
            data.append(UInt8((value >> UInt64(shift)) & 0xFF))
        }
    }

    private static func readBigEndian(_ byte: (Int) -> UInt8?, offset: inout Int, byteCount: Int, highBits: UInt64) -> Int64? {
        var value = highBits
        for index in 1...byteCount {
            guard let next = byte(offset + index) else { return nil }
            value = (value << 8) | UInt64(next)
        }
        offset += byteCount + 1
        return Int64(bitPattern: value)
    }
}
