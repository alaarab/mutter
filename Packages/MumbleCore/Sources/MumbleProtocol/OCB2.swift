import Foundation

/// A 128-bit block cipher. OCB2 only ever needs single-block ECB operations.
public protocol BlockCipher {
    func encryptBlock(_ input: [UInt8]) -> [UInt8]
    func decryptBlock(_ input: [UInt8]) -> [UInt8]
}

/// Port of Mumble's `CryptStateOCB2` (OCB2-AES128, public-domain algorithm design).
/// Packet layout on the wire: `[iv byte][tag0][tag1][tag2][ciphertext...]`.
///
/// Not thread-safe; callers serialize access on their own queue.
public final class CryptState {
    public static let blockSize = 16
    private static let shiftBits = 7

    private var cipher: BlockCipher?
    private var rawKey = [UInt8](repeating: 0, count: 16)
    private(set) public var encryptIV = [UInt8](repeating: 0, count: 16)
    private(set) public var decryptIV = [UInt8](repeating: 0, count: 16)
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

    // MARK: Key management

    public func setKey(_ key: [UInt8], encryptIV: [UInt8], decryptIV: [UInt8]) -> Bool {
        guard key.count == 16, encryptIV.count == 16, decryptIV.count == 16 else { return false }
        rawKey = key
        self.encryptIV = encryptIV
        self.decryptIV = decryptIV
        cipher = makeCipher(key)
        decryptHistory = [UInt8](repeating: 0, count: 256)
        good = 0; late = 0; lost = 0; resync = 0
        return true
    }

    /// Client side: key from CryptSetup, our nonce (client_nonce) encrypts, the server's nonce decrypts.
    public func setKey(_ key: Data, clientNonce: Data, serverNonce: Data) -> Bool {
        setKey([UInt8](key), encryptIV: [UInt8](clientNonce), decryptIV: [UInt8](serverNonce))
    }

    public func setDecryptIV(_ iv: [UInt8]) -> Bool {
        guard iv.count == 16 else { return false }
        decryptIV = iv
        resync += 1
        return true
    }

    public func setEncryptIV(_ iv: [UInt8]) -> Bool {
        guard iv.count == 16 else { return false }
        encryptIV = iv
        return true
    }

    public func markResyncRequested() { lastRequest = Date() }

    // MARK: Packet crypto

    public func encrypt(_ plain: Data) -> Data? {
        guard cipher != nil else { return nil }
        for i in 0..<16 {
            encryptIV[i] &+= 1
            if encryptIV[i] != 0 { break }
        }
        let (ct, tag) = ocbEncrypt([UInt8](plain), nonce: encryptIV)
        var out = [UInt8](repeating: 0, count: 4 + ct.count)
        out[0] = encryptIV[0]
        out[1] = tag[0]
        out[2] = tag[1]
        out[3] = tag[2]
        if !ct.isEmpty { out.replaceSubrange(4..., with: ct) }
        return Data(out)
    }

    public func decrypt(_ crypted: Data) -> Data? {
        guard cipher != nil, crypted.count >= 4 else { return nil }
        let src = [UInt8](crypted)
        let ivByte = src[0]
        let saved = decryptIV
        var restore = false
        var lostDelta = 0
        var lateDelta = 0

        if (decryptIV[0] &+ 1) == ivByte {
            // In order as expected.
            if ivByte > decryptIV[0] {
                decryptIV[0] = ivByte
            } else if ivByte < decryptIV[0] {
                decryptIV[0] = ivByte
                for i in 1..<16 {
                    decryptIV[i] &+= 1
                    if decryptIV[i] != 0 { break }
                }
            } else {
                return nil
            }
        } else {
            // Out of order or repeat.
            var diff = Int(ivByte) - Int(decryptIV[0])
            if diff > 128 { diff -= 256 } else if diff < -128 { diff += 256 }

            if ivByte < decryptIV[0] && diff > -30 && diff < 0 {
                // Late packet, no wraparound.
                lateDelta = 1
                lostDelta = -1
                decryptIV[0] = ivByte
                restore = true
            } else if ivByte > decryptIV[0] && diff > -30 && diff < 0 {
                // Last was 0x02, here comes 0xff from the previous round.
                lateDelta = 1
                lostDelta = -1
                decryptIV[0] = ivByte
                for i in 1..<16 {
                    let before = decryptIV[i]
                    decryptIV[i] &-= 1
                    if before != 0 { break }
                }
                restore = true
            } else if ivByte > decryptIV[0] && diff > 0 {
                // Lost a few packets, but beyond that we're good.
                lostDelta = Int(ivByte) - Int(decryptIV[0]) - 1
                decryptIV[0] = ivByte
            } else if ivByte < decryptIV[0] && diff > 0 {
                // Lost a few packets and wrapped around.
                lostDelta = 256 - Int(decryptIV[0]) + Int(ivByte) - 1
                decryptIV[0] = ivByte
                for i in 1..<16 {
                    decryptIV[i] &+= 1
                    if decryptIV[i] != 0 { break }
                }
            } else {
                return nil
            }

            if decryptHistory[Int(decryptIV[0])] == decryptIV[1] {
                decryptIV = saved
                return nil
            }
        }

        let (plain, tag, ok) = ocbDecrypt(Array(src[4...]), nonce: decryptIV)
        if !ok || tag[0] != src[1] || tag[1] != src[2] || tag[2] != src[3] {
            decryptIV = saved
            return nil
        }
        decryptHistory[Int(decryptIV[0])] = decryptIV[1]
        if restore { decryptIV = saved }

        good &+= 1
        if lateDelta > 0 { late &+= UInt32(lateDelta) } else if Int(late) > -lateDelta { late -= UInt32(-lateDelta) }
        if lostDelta > 0 { lost &+= UInt32(lostDelta) } else if Int(lost) > -lostDelta { lost -= UInt32(-lostDelta) }
        lastGood = Date()
        return Data(plain)
    }

    // MARK: OCB2 core

    /// Doubles the block in GF(2^128) (shift left by one, reduce with 0x87).
    static func s2(_ block: inout [UInt8]) {
        let carry = block[0] >> 7
        for i in 0..<15 {
            block[i] = (block[i] << 1) | (block[i + 1] >> 7)
        }
        block[15] = (block[15] << 1) ^ (carry &* 0x87)
    }

    /// Triples the block: block ^= s2(block).
    static func s3(_ block: inout [UInt8]) {
        var doubled = block
        s2(&doubled)
        for i in 0..<16 { block[i] ^= doubled[i] }
    }

    @inline(__always)
    private static func xor(_ a: [UInt8], _ b: [UInt8]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: 16)
        for i in 0..<16 { out[i] = a[i] ^ b[i] }
        return out
    }

    /// Returns (ciphertext, tag). Mirrors `ocb_encrypt` including the XEX* counter-cryptanalysis bit flip.
    public func ocbEncrypt(_ plain: [UInt8], nonce: [UInt8]) -> ([UInt8], [UInt8]) {
        guard let cipher else { return ([], [UInt8](repeating: 0, count: 16)) }
        var delta = cipher.encryptBlock(nonce)
        var checksum = [UInt8](repeating: 0, count: 16)
        var out = [UInt8](repeating: 0, count: plain.count)
        var len = plain.count
        var off = 0

        while len > 16 {
            let block = Array(plain[off..<(off + 16)])
            // Counter-cryptanalysis (https://eprint.iacr.org/2019/311 section 9): if the second-to-last
            // block is all zero apart from its last byte, flip a bit so the packet can't be exploited.
            var flipABit = false
            if len - 16 <= 16 {
                var sum: UInt8 = 0
                for i in 0..<15 { sum |= block[i] }
                if sum == 0 { flipABit = true }
            }
            CryptState.s2(&delta)
            var tmp = CryptState.xor(delta, block)
            if flipABit { tmp[0] ^= 1 }
            tmp = cipher.encryptBlock(tmp)
            let enc = CryptState.xor(delta, tmp)
            out.replaceSubrange(off..<(off + 16), with: enc)
            checksum = CryptState.xor(checksum, block)
            if flipABit { checksum[0] ^= 1 }
            len -= 16
            off += 16
        }

        CryptState.s2(&delta)
        var tmp = [UInt8](repeating: 0, count: 16)
        let bits = UInt32(len * 8)
        tmp[12] = UInt8((bits >> 24) & 0xFF)
        tmp[13] = UInt8((bits >> 16) & 0xFF)
        tmp[14] = UInt8((bits >> 8) & 0xFF)
        tmp[15] = UInt8(bits & 0xFF)
        tmp = CryptState.xor(tmp, delta)
        let pad = cipher.encryptBlock(tmp)
        var tail = [UInt8](repeating: 0, count: 16)
        for i in 0..<len { tail[i] = plain[off + i] }
        for i in len..<16 { tail[i] = pad[i] }
        checksum = CryptState.xor(checksum, tail)
        tail = CryptState.xor(pad, tail)
        for i in 0..<len { out[off + i] = tail[i] }

        CryptState.s3(&delta)
        let tag = cipher.encryptBlock(CryptState.xor(delta, checksum))
        return (out, tag)
    }

    /// Returns (plaintext, tag, success). `success` is false when the packet looks like an XEX* attack.
    public func ocbDecrypt(_ encrypted: [UInt8], nonce: [UInt8]) -> ([UInt8], [UInt8], Bool) {
        guard let cipher else { return ([], [UInt8](repeating: 0, count: 16), false) }
        var delta = cipher.encryptBlock(nonce)
        var checksum = [UInt8](repeating: 0, count: 16)
        var out = [UInt8](repeating: 0, count: encrypted.count)
        var len = encrypted.count
        var off = 0
        var success = true

        while len > 16 {
            let block = Array(encrypted[off..<(off + 16)])
            CryptState.s2(&delta)
            var tmp = CryptState.xor(delta, block)
            tmp = cipher.decryptBlock(tmp)
            let plain = CryptState.xor(delta, tmp)
            out.replaceSubrange(off..<(off + 16), with: plain)
            checksum = CryptState.xor(checksum, plain)
            len -= 16
            off += 16
        }

        CryptState.s2(&delta)
        var tmp = [UInt8](repeating: 0, count: 16)
        let bits = UInt32(len * 8)
        tmp[12] = UInt8((bits >> 24) & 0xFF)
        tmp[13] = UInt8((bits >> 16) & 0xFF)
        tmp[14] = UInt8((bits >> 8) & 0xFF)
        tmp[15] = UInt8(bits & 0xFF)
        tmp = CryptState.xor(tmp, delta)
        let pad = cipher.encryptBlock(tmp)
        var tail = [UInt8](repeating: 0, count: 16)
        for i in 0..<len { tail[i] = encrypted[off + i] }
        tail = CryptState.xor(tail, pad)
        checksum = CryptState.xor(checksum, tail)
        for i in 0..<len { out[off + i] = tail[i] }

        // Attack detection: the decrypted last block would equal delta ^ len(128).
        var matches = true
        for i in 0..<15 where tail[i] != delta[i] { matches = false; break }
        if matches { success = false }

        CryptState.s3(&delta)
        let tag = cipher.encryptBlock(CryptState.xor(delta, checksum))
        return (out, tag, success)
    }
}
