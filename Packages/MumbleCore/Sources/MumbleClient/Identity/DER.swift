import Foundation

enum DER {
    static let null = Data([0x05, 0x00])

    static func length(_ count: Int) -> Data {
        if count < 0x80 { return Data([UInt8(count)]) }
        var bytes: [UInt8] = []
        var remaining = count
        while remaining > 0 {
            bytes.insert(UInt8(remaining & 0xFF), at: 0)
            remaining >>= 8
        }
        return Data([0x80 | UInt8(bytes.count)] + bytes)
    }

    static func tlv(_ tag: UInt8, _ content: Data) -> Data {
        var encoded = Data([tag])
        encoded.append(length(content.count))
        encoded.append(content)
        return encoded
    }

    static func sequence(_ items: [Data]) -> Data {
        tlv(0x30, items.reduce(Data(), +))
    }

    static func set(_ items: [Data]) -> Data {
        tlv(0x31, items.reduce(Data(), +))
    }

    static func integer(_ value: Int) -> Data {
        var bytes: [UInt8] = []
        var remaining = value
        repeat {
            bytes.insert(UInt8(remaining & 0xFF), at: 0)
            remaining >>= 8
        } while remaining > 0
        if bytes[0] & 0x80 != 0 { bytes.insert(0, at: 0) }
        return tlv(0x02, Data(bytes))
    }

    static func integer(unsigned raw: Data) -> Data {
        var bytes = [UInt8](raw)
        while bytes.count > 1 && bytes[0] == 0 { bytes.removeFirst() }
        if bytes.isEmpty { bytes = [0] }
        if bytes[0] & 0x80 != 0 { bytes.insert(0, at: 0) }
        return tlv(0x02, Data(bytes))
    }

    static func boolean(_ value: Bool) -> Data {
        tlv(0x01, Data([value ? 0xFF : 0x00]))
    }

    static func oid(_ dotted: String) -> Data {
        let parts = dotted.split(separator: ".").compactMap { Int($0) }
        guard parts.count >= 2 else { return tlv(0x06, Data()) }
        var body: [UInt8] = [UInt8(parts[0] * 40 + parts[1])]
        for part in parts.dropFirst(2) {
            var remaining = part
            var chunk: [UInt8] = [UInt8(remaining & 0x7F)]
            remaining >>= 7
            while remaining > 0 {
                chunk.insert(UInt8(remaining & 0x7F) | 0x80, at: 0)
                remaining >>= 7
            }
            body.append(contentsOf: chunk)
        }
        return tlv(0x06, Data(body))
    }

    static func utf8String(_ text: String) -> Data {
        tlv(0x0C, Data(text.utf8))
    }

    static func printableString(_ text: String) -> Data {
        tlv(0x13, Data(text.utf8))
    }

    static func ia5String(_ text: String) -> Data {
        tlv(0x16, Data(text.utf8))
    }

    static func octetString(_ bytes: Data) -> Data {
        tlv(0x04, bytes)
    }

    static func bitString(_ bytes: Data, unusedBits: UInt8 = 0) -> Data {
        tlv(0x03, Data([unusedBits]) + bytes)
    }

    static func explicit(_ tagNumber: UInt8, _ content: Data) -> Data {
        tlv(0xA0 | tagNumber, content)
    }

    static func time(_ date: Date) -> Data {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let year = calendar.component(.year, from: date)
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        if year < 2050 {
            formatter.dateFormat = "yyMMddHHmmss'Z'"
            return tlv(0x17, Data(formatter.string(from: date).utf8))
        }
        formatter.dateFormat = "yyyyMMddHHmmss'Z'"
        return tlv(0x18, Data(formatter.string(from: date).utf8))
    }

    static func attribute(oid: String, value: Data) -> Data {
        set([sequence([DER.oid(oid), value])])
    }
}

struct DERReader {
    struct Element {
        let tag: UInt8
        let content: Data
    }

    private let data: Data
    private var position: Int

    init(_ data: Data) {
        self.data = data
        self.position = data.startIndex
    }

    mutating func next() -> Element? {
        guard position < data.endIndex else { return nil }
        let tag = data[position]
        position += 1
        guard position < data.endIndex else { return nil }
        var length = Int(data[position])
        position += 1
        if length & 0x80 != 0 {
            let lengthBytes = length & 0x7F
            guard lengthBytes > 0, lengthBytes <= 4, position + lengthBytes <= data.endIndex else { return nil }
            length = 0
            for _ in 0..<lengthBytes {
                length = (length << 8) | Int(data[position])
                position += 1
            }
        }
        guard position + length <= data.endIndex else { return nil }
        let content = data[position..<(position + length)]
        position += length
        return Element(tag: tag, content: Data(content))
    }

    static func certificateNotAfter(_ der: Data) -> Date? {
        var outer = DERReader(der)
        guard let certificate = outer.next(), certificate.tag == 0x30 else { return nil }
        var certificateBody = DERReader(certificate.content)
        guard let tbs = certificateBody.next(), tbs.tag == 0x30 else { return nil }
        var tbsBody = DERReader(tbs.content)
        guard var element = tbsBody.next() else { return nil }
        if element.tag == 0xA0 {
            guard let serial = tbsBody.next() else { return nil }
            element = serial
        }
        guard tbsBody.next() != nil, tbsBody.next() != nil,
              let validity = tbsBody.next(), validity.tag == 0x30 else { return nil }
        var validityBody = DERReader(validity.content)
        guard validityBody.next() != nil, let notAfter = validityBody.next() else { return nil }
        return parseTime(notAfter)
    }

    private static func parseTime(_ element: Element) -> Date? {
        let text = String(decoding: element.content, as: UTF8.self)
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        switch element.tag {
        case 0x17: formatter.dateFormat = "yyMMddHHmmss'Z'"
        case 0x18: formatter.dateFormat = "yyyyMMddHHmmss'Z'"
        default: return nil
        }
        return formatter.date(from: text)
    }
}
