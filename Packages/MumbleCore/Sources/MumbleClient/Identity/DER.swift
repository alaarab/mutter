import Foundation

/// Tiny DER encoder, enough to build an X.509 v3 certificate.
enum DER {
    static func length(_ n: Int) -> Data {
        if n < 0x80 { return Data([UInt8(n)]) }
        var bytes: [UInt8] = []
        var v = n
        while v > 0 {
            bytes.insert(UInt8(v & 0xFF), at: 0)
            v >>= 8
        }
        return Data([0x80 | UInt8(bytes.count)] + bytes)
    }

    static func tlv(_ tag: UInt8, _ content: Data) -> Data {
        var d = Data([tag])
        d.append(length(content.count))
        d.append(content)
        return d
    }

    static func sequence(_ items: [Data]) -> Data {
        tlv(0x30, items.reduce(Data(), +))
    }

    static func set(_ items: [Data]) -> Data {
        tlv(0x31, items.reduce(Data(), +))
    }

    static func integer(_ value: Int) -> Data {
        var bytes: [UInt8] = []
        var v = value
        repeat {
            bytes.insert(UInt8(v & 0xFF), at: 0)
            v >>= 8
        } while v > 0
        if bytes[0] & 0x80 != 0 { bytes.insert(0, at: 0) }
        return tlv(0x02, Data(bytes))
    }

    /// Unsigned big-endian integer from raw bytes (adds a leading zero when the top bit is set).
    static func integer(unsigned bytes: Data) -> Data {
        var b = [UInt8](bytes)
        while b.count > 1 && b[0] == 0 { b.removeFirst() }
        if b.isEmpty { b = [0] }
        if b[0] & 0x80 != 0 { b.insert(0, at: 0) }
        return tlv(0x02, Data(b))
    }

    static func boolean(_ v: Bool) -> Data { tlv(0x01, Data([v ? 0xFF : 0x00])) }

    static let null = Data([0x05, 0x00])

    static func oid(_ dotted: String) -> Data {
        let parts = dotted.split(separator: ".").compactMap { Int($0) }
        guard parts.count >= 2 else { return tlv(0x06, Data()) }
        var body: [UInt8] = [UInt8(parts[0] * 40 + parts[1])]
        for p in parts.dropFirst(2) {
            var v = p
            var chunk: [UInt8] = [UInt8(v & 0x7F)]
            v >>= 7
            while v > 0 {
                chunk.insert(UInt8(v & 0x7F) | 0x80, at: 0)
                v >>= 7
            }
            body.append(contentsOf: chunk)
        }
        return tlv(0x06, Data(body))
    }

    static func utf8String(_ s: String) -> Data { tlv(0x0C, Data(s.utf8)) }
    static func printableString(_ s: String) -> Data { tlv(0x13, Data(s.utf8)) }
    static func ia5String(_ s: String) -> Data { tlv(0x16, Data(s.utf8)) }
    static func octetString(_ d: Data) -> Data { tlv(0x04, d) }

    static func bitString(_ d: Data, unusedBits: UInt8 = 0) -> Data {
        tlv(0x03, Data([unusedBits]) + d)
    }

    /// Context-specific, constructed, explicit tag [n].
    static func explicit(_ n: UInt8, _ content: Data) -> Data {
        tlv(0xA0 | n, content)
    }

    static func time(_ date: Date) -> Data {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let year = cal.component(.year, from: date)
        let f = DateFormatter()
        f.calendar = cal
        f.timeZone = cal.timeZone
        f.locale = Locale(identifier: "en_US_POSIX")
        if year < 2050 {
            f.dateFormat = "yyMMddHHmmss'Z'"
            return tlv(0x17, Data(f.string(from: date).utf8))
        } else {
            f.dateFormat = "yyyyMMddHHmmss'Z'"
            return tlv(0x18, Data(f.string(from: date).utf8))
        }
    }

    static func attribute(oid: String, value: Data) -> Data {
        set([sequence([DER.oid(oid), value])])
    }
}

/// Minimal DER walker used to pull a few fields out of certificates we receive.
struct DERReader {
    private let data: Data
    private var pos: Int

    init(_ data: Data) {
        self.data = data
        self.pos = data.startIndex
    }

    struct Element {
        let tag: UInt8
        let content: Data
    }

    mutating func next() -> Element? {
        guard pos < data.endIndex else { return nil }
        let tag = data[pos]
        pos += 1
        guard pos < data.endIndex else { return nil }
        var len = Int(data[pos])
        pos += 1
        if len & 0x80 != 0 {
            let n = len & 0x7F
            guard n > 0, n <= 4, pos + n <= data.endIndex else { return nil }
            len = 0
            for _ in 0..<n {
                len = (len << 8) | Int(data[pos])
                pos += 1
            }
        }
        guard pos + len <= data.endIndex else { return nil }
        let content = data[pos..<(pos + len)]
        pos += len
        return Element(tag: tag, content: Data(content))
    }

    /// Extracts `notAfter` from a DER certificate, or nil if the structure is unexpected.
    static func certificateNotAfter(_ der: Data) -> Date? {
        var top = DERReader(der)
        guard let cert = top.next(), cert.tag == 0x30 else { return nil }
        var certBody = DERReader(cert.content)
        guard let tbs = certBody.next(), tbs.tag == 0x30 else { return nil }
        var tbsBody = DERReader(tbs.content)
        guard var el = tbsBody.next() else { return nil }
        if el.tag == 0xA0 { // version present
            guard let next = tbsBody.next() else { return nil }
            el = next
        }
        // el is serialNumber; then signature algorithm, issuer, validity
        guard tbsBody.next() != nil, tbsBody.next() != nil,
              let validity = tbsBody.next(), validity.tag == 0x30 else { return nil }
        var v = DERReader(validity.content)
        guard v.next() != nil, let notAfter = v.next() else { return nil }
        return parseTime(notAfter)
    }

    private static func parseTime(_ el: Element) -> Date? {
        let s = String(decoding: el.content, as: UTF8.self)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        switch el.tag {
        case 0x17: f.dateFormat = "yyMMddHHmmss'Z'"
        case 0x18: f.dateFormat = "yyyyMMddHHmmss'Z'"
        default: return nil
        }
        return f.date(from: s)
    }
}
