import Foundation

public protocol BlockCipher {
    func encryptBlock(_ input: [UInt8]) -> [UInt8]
    func decryptBlock(_ input: [UInt8]) -> [UInt8]
}

public final class CryptState {
    public static let blockSize = 16
    private static let headerBytes = 4
    private static let reorderWindow = 30

    private var cipher: BlockCipher?
    private(set) public var encryptIV = CryptState.zeroBlock
    private(set) public var decryptIV = CryptState.zeroBlock
    private var decryptHistory = [UInt8](repeating: 0, count: 256)

    public private(set) var good: UInt32 = 0
    public private(set) var late: UInt32 = 0
    public private(set) var lost: UInt32 = 0
    public private(set) var resync: UInt32 = 0
    public private(set) var lastGood: Date = .distantPast
    public private(set) var lastRequest: Date = .distantPast

    public var isValid: Bool { cipher != nil }

    private let makeCipher: ([UInt8]) -> BlockCipher

    public init(cipherFactory: @escaping ([UInt8]) -> BlockCipher = { AES128(key: $0) }) {
        self.makeCipher = cipherFactory
    }

    private static var zeroBlock: [UInt8] { [UInt8](repeating: 0, count: blockSize) }

    public func setKey(_ key: [UInt8], encryptIV: [UInt8], decryptIV: [UInt8]) -> Bool {
        let blockSize = Self.blockSize
        guard key.count == blockSize, encryptIV.count == blockSize, decryptIV.count == blockSize else { return false }
        self.encryptIV = encryptIV
        self.decryptIV = decryptIV
        cipher = makeCipher(key)
        decryptHistory = [UInt8](repeating: 0, count: 256)
        good = 0
        late = 0
        lost = 0
        resync = 0
        return true
    }

    public func setKey(_ key: Data, clientNonce: Data, serverNonce: Data) -> Bool {
        setKey([UInt8](key), encryptIV: [UInt8](clientNonce), decryptIV: [UInt8](serverNonce))
    }

    public func setDecryptIV(_ iv: [UInt8]) -> Bool {
        guard iv.count == Self.blockSize else { return false }
        decryptIV = iv
        resync += 1
        return true
    }

    public func setEncryptIV(_ iv: [UInt8]) -> Bool {
        guard iv.count == Self.blockSize else { return false }
        encryptIV = iv
        return true
    }

    public func markResyncRequested() {
        lastRequest = Date()
    }

    public func encrypt(_ plain: Data) -> Data? {
        guard cipher != nil else { return nil }
        Self.increment(&encryptIV, from: 0)
        let (ciphertext, tag) = ocbEncrypt([UInt8](plain), nonce: encryptIV)
        var packet = [encryptIV[0], tag[0], tag[1], tag[2]]
        packet.append(contentsOf: ciphertext)
        return Data(packet)
    }

    public func decrypt(_ crypted: Data) -> Data? {
        guard cipher != nil, crypted.count >= Self.headerBytes else { return nil }
        let source = [UInt8](crypted)
        let saved = decryptIV
        guard let adjustment = advanceDecryptIV(to: source[0]) else {
            decryptIV = saved
            return nil
        }
        let (plain, tag, ok) = ocbDecrypt(Array(source[Self.headerBytes...]), nonce: decryptIV)
        let tagMatches = tag[0] == source[1] && tag[1] == source[2] && tag[2] == source[3]
        guard ok, tagMatches else {
            decryptIV = saved
            return nil
        }
        decryptHistory[Int(decryptIV[0])] = decryptIV[1]
        if adjustment.restore { decryptIV = saved }
        good &+= 1
        late = Self.adjusted(late, by: adjustment.late)
        lost = Self.adjusted(lost, by: adjustment.lost)
        lastGood = Date()
        return Data(plain)
    }

    private func advanceDecryptIV(to ivByte: UInt8) -> (restore: Bool, lost: Int, late: Int)? {
        let current = decryptIV[0]
        if current &+ 1 == ivByte {
            if ivByte > current {
                decryptIV[0] = ivByte
            } else if ivByte < current {
                decryptIV[0] = ivByte
                Self.increment(&decryptIV, from: 1)
            } else {
                return nil
            }
            return (restore: false, lost: 0, late: 0)
        }
        var diff = Int(ivByte) - Int(current)
        if diff > 128 {
            diff -= 256
        } else if diff < -128 {
            diff += 256
        }
        let isLate = diff > -Self.reorderWindow && diff < 0
        var restore = false
        var lost = 0
        var late = 0
        if ivByte < current && isLate {
            late = 1
            lost = -1
            decryptIV[0] = ivByte
            restore = true
        } else if ivByte > current && isLate {
            late = 1
            lost = -1
            decryptIV[0] = ivByte
            Self.decrement(&decryptIV, from: 1)
            restore = true
        } else if ivByte > current && diff > 0 {
            lost = Int(ivByte) - Int(current) - 1
            decryptIV[0] = ivByte
        } else if ivByte < current && diff > 0 {
            lost = 256 - Int(current) + Int(ivByte) - 1
            decryptIV[0] = ivByte
            Self.increment(&decryptIV, from: 1)
        } else {
            return nil
        }
        if decryptHistory[Int(decryptIV[0])] == decryptIV[1] { return nil }
        return (restore: restore, lost: lost, late: late)
    }

    private static func adjusted(_ counter: UInt32, by delta: Int) -> UInt32 {
        if delta > 0 { return counter &+ UInt32(delta) }
        if Int(counter) > -delta { return counter - UInt32(-delta) }
        return counter
    }

    private static func increment(_ iv: inout [UInt8], from start: Int) {
        for index in start..<blockSize {
            iv[index] &+= 1
            if iv[index] != 0 { break }
        }
    }

    private static func decrement(_ iv: inout [UInt8], from start: Int) {
        for index in start..<blockSize {
            let before = iv[index]
            iv[index] &-= 1
            if before != 0 { break }
        }
    }

    static func double(_ block: inout [UInt8]) {
        let carry = block[0] >> 7
        for index in 0..<(blockSize - 1) {
            block[index] = (block[index] << 1) | (block[index + 1] >> 7)
        }
        block[blockSize - 1] = (block[blockSize - 1] << 1) ^ (carry &* 0x87)
    }

    static func triple(_ block: inout [UInt8]) {
        var doubled = block
        double(&doubled)
        for index in 0..<blockSize { block[index] ^= doubled[index] }
    }

    @inline(__always)
    private static func xor(_ left: [UInt8], _ right: [UInt8]) -> [UInt8] {
        var out = zeroBlock
        for index in 0..<blockSize { out[index] = left[index] ^ right[index] }
        return out
    }

    private static func lengthBlock(_ byteCount: Int) -> [UInt8] {
        var block = zeroBlock
        let bits = UInt32(byteCount * 8)
        block[12] = UInt8((bits >> 24) & 0xFF)
        block[13] = UInt8((bits >> 16) & 0xFF)
        block[14] = UInt8((bits >> 8) & 0xFF)
        block[15] = UInt8(bits & 0xFF)
        return block
    }

    private static func isZeroExceptLastByte(_ block: [UInt8]) -> Bool {
        var sum: UInt8 = 0
        for index in 0..<(blockSize - 1) { sum |= block[index] }
        return sum == 0
    }

    private static func prefixMatches(_ left: [UInt8], _ right: [UInt8]) -> Bool {
        for index in 0..<(blockSize - 1) where left[index] != right[index] { return false }
        return true
    }

    public func ocbEncrypt(_ plain: [UInt8], nonce: [UInt8]) -> ([UInt8], [UInt8]) {
        guard let cipher else { return ([], Self.zeroBlock) }
        let blockSize = Self.blockSize
        var delta = cipher.encryptBlock(nonce)
        var checksum = Self.zeroBlock
        var out = [UInt8](repeating: 0, count: plain.count)
        var remaining = plain.count
        var offset = 0

        while remaining > blockSize {
            let block = Array(plain[offset..<(offset + blockSize)])
            let flipBit = remaining - blockSize <= blockSize && Self.isZeroExceptLastByte(block)
            Self.double(&delta)
            var masked = Self.xor(delta, block)
            if flipBit { masked[0] ^= 1 }
            let encrypted = Self.xor(delta, cipher.encryptBlock(masked))
            out.replaceSubrange(offset..<(offset + blockSize), with: encrypted)
            checksum = Self.xor(checksum, block)
            if flipBit { checksum[0] ^= 1 }
            remaining -= blockSize
            offset += blockSize
        }

        Self.double(&delta)
        let pad = cipher.encryptBlock(Self.xor(Self.lengthBlock(remaining), delta))
        var tail = Self.zeroBlock
        for index in 0..<remaining { tail[index] = plain[offset + index] }
        for index in remaining..<blockSize { tail[index] = pad[index] }
        checksum = Self.xor(checksum, tail)
        let encryptedTail = Self.xor(pad, tail)
        for index in 0..<remaining { out[offset + index] = encryptedTail[index] }

        Self.triple(&delta)
        let tag = cipher.encryptBlock(Self.xor(delta, checksum))
        return (out, tag)
    }

    public func ocbDecrypt(_ encrypted: [UInt8], nonce: [UInt8]) -> ([UInt8], [UInt8], Bool) {
        guard let cipher else { return ([], Self.zeroBlock, false) }
        let blockSize = Self.blockSize
        var delta = cipher.encryptBlock(nonce)
        var checksum = Self.zeroBlock
        var out = [UInt8](repeating: 0, count: encrypted.count)
        var remaining = encrypted.count
        var offset = 0

        while remaining > blockSize {
            let block = Array(encrypted[offset..<(offset + blockSize)])
            Self.double(&delta)
            let plain = Self.xor(delta, cipher.decryptBlock(Self.xor(delta, block)))
            out.replaceSubrange(offset..<(offset + blockSize), with: plain)
            checksum = Self.xor(checksum, plain)
            remaining -= blockSize
            offset += blockSize
        }

        Self.double(&delta)
        let pad = cipher.encryptBlock(Self.xor(Self.lengthBlock(remaining), delta))
        var tail = Self.zeroBlock
        for index in 0..<remaining { tail[index] = encrypted[offset + index] }
        tail = Self.xor(tail, pad)
        checksum = Self.xor(checksum, tail)
        for index in 0..<remaining { out[offset + index] = tail[index] }
        let success = !Self.prefixMatches(tail, delta)

        Self.triple(&delta)
        let tag = cipher.encryptBlock(Self.xor(delta, checksum))
        return (out, tag, success)
    }
}
