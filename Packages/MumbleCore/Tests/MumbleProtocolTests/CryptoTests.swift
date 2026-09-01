import XCTest
@testable import MumbleProtocol

final class CryptoTests: XCTestCase {

    private let key: [UInt8] = Array(0..<16)
    private let nonce: [UInt8] = Array(0..<16)

    private func hex(_ s: String) -> [UInt8] {
        var out: [UInt8] = []
        var idx = s.startIndex
        while idx < s.endIndex {
            let next = s.index(idx, offsetBy: 2)
            out.append(UInt8(s[idx..<next], radix: 16)!)
            idx = next
        }
        return out
    }

    // FIPS-197 appendix C.1 known answer
    func testSoftAESKnownAnswer() {
        let aes = SoftAES128(key: hex("000102030405060708090a0b0c0d0e0f"))
        let ct = aes.encryptBlock(hex("00112233445566778899aabbccddeeff"))
        XCTAssertEqual(ct, hex("69c4e0d86a7b0430d8cdb78070b4c55a"))
        XCTAssertEqual(aes.decryptBlock(ct), hex("00112233445566778899aabbccddeeff"))
    }

    func testPlatformAESMatchesSoftAES() {
        let a = AES128(key: key)
        let b = SoftAES128(key: key)
        for _ in 0..<20 {
            let block = (0..<16).map { _ in UInt8.random(in: 0...255) }
            XCTAssertEqual(a.encryptBlock(block), b.encryptBlock(block))
            XCTAssertEqual(a.decryptBlock(block), b.decryptBlock(block))
        }
    }

    // Vectors from mumble/src/tests/TestCrypt/TestCrypt.cpp (the OCB2 paper vectors).
    func testOCBVectors() {
        let cs = CryptState()
        XCTAssertTrue(cs.setKey(key, encryptIV: nonce, decryptIV: nonce))

        let (_, blankTag) = cs.ocbEncrypt([], nonce: nonce)
        XCTAssertEqual(blankTag, hex("BF3108130773AD5EC70EC69E7875A7B0"))

        let plain: [UInt8] = Array(0..<40)
        let (ct, tag) = cs.ocbEncrypt(plain, nonce: nonce)
        XCTAssertEqual(ct, hex("F75D6BC8B4DC8D66B836A2B08B32A6369F1CD3C5228D79FD6C267F5F6AA7B231C7DFB9D59951AE9C"))
        XCTAssertEqual(tag, hex("9DB0CDF880F73E3E10D4EB3217766688"))

        let (dec, dtag, ok) = cs.ocbDecrypt(ct, nonce: nonce)
        XCTAssertTrue(ok)
        XCTAssertEqual(dec, plain)
        XCTAssertEqual(dtag, tag)
    }

    func testOCBRoundTripsAllTailSizes() {
        let cs = CryptState()
        _ = cs.setKey(key, encryptIV: nonce, decryptIV: nonce)
        for n in [1, 5, 15, 16, 17, 31, 32, 33, 100, 500] {
            let plain = (0..<n).map { _ in UInt8.random(in: 1...255) }
            let (ct, tag) = cs.ocbEncrypt(plain, nonce: nonce)
            let (dec, dtag, ok) = cs.ocbDecrypt(ct, nonce: nonce)
            XCTAssertTrue(ok, "size \(n)")
            XCTAssertEqual(dec, plain, "size \(n)")
            XCTAssertEqual(dtag, tag, "size \(n)")
        }
    }

    /// Encrypting with one state and decrypting with a peer state whose IVs are swapped.
    private func makePair() -> (CryptState, CryptState) {
        let a = CryptState()
        let b = CryptState()
        // Fixed IVs with iv[1] != 0 so the replay-history check can't collide with the zeroed table.
        let encIV: [UInt8] = [0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xA9, 0xBA, 0xCB, 0xDC, 0xED, 0xFE, 0x0F]
        let decIV: [UInt8] = [0xF0, 0xE1, 0xD2, 0xC3, 0xB4, 0xA5, 0x96, 0x87, 0x78, 0x69, 0x5A, 0x4B, 0x3C, 0x2D, 0x1E, 0x0F]
        _ = a.setKey(key, encryptIV: encIV, decryptIV: decIV)
        _ = b.setKey(key, encryptIV: decIV, decryptIV: encIV)
        return (a, b)
    }

    func testPacketRoundTrip() {
        let (a, b) = makePair()
        let msg = Data("It was a funky funky town!".utf8)
        for _ in 0..<600 { // crosses the 256 wrap of iv[0] more than twice
            let ct = a.encrypt(msg)!
            XCTAssertEqual(ct.count, msg.count + 4)
            XCTAssertEqual(b.decrypt(ct), msg)
        }
        XCTAssertEqual(b.good, 600)
        XCTAssertEqual(b.lost, 0)
    }

    func testTamperedPacketIsRejected() {
        let (a, b) = makePair()
        var ct = a.encrypt(Data("hello world, hello".utf8))!
        ct[6] ^= 0x01
        XCTAssertNil(b.decrypt(ct))
    }

    func testReplayIsRejected() {
        let (a, b) = makePair()
        let ct = a.encrypt(Data([1, 2, 3]))!
        XCTAssertNotNil(b.decrypt(ct))
        XCTAssertNil(b.decrypt(ct))
    }

    func testLossAndReorderRecovery() {
        let (a, b) = makePair()
        var packets: [Data] = []
        for i in 0..<20 { packets.append(a.encrypt(Data([UInt8(i)]))!) }
        // Deliver 0, 1, skip 2 and 3, deliver 4, then late 2 and 3, then 5...
        XCTAssertEqual(b.decrypt(packets[0]), Data([0]))
        XCTAssertEqual(b.decrypt(packets[1]), Data([1]))
        XCTAssertEqual(b.decrypt(packets[4]), Data([4]))
        XCTAssertEqual(b.lost, 2)
        XCTAssertEqual(b.decrypt(packets[2]), Data([2]))
        XCTAssertEqual(b.decrypt(packets[3]), Data([3]))
        XCTAssertEqual(b.late, 2)
        XCTAssertEqual(b.lost, 0)
        for i in 5..<20 { XCTAssertEqual(b.decrypt(packets[i]), Data([UInt8(i)])) }
    }

    func testLateAcrossWrap() {
        let (a, b) = makePair()
        var packets: [Data] = []
        for i in 0..<300 { packets.append(a.encrypt(Data([UInt8(i & 0xFF)]))!) }
        for i in 0..<254 { _ = b.decrypt(packets[i]) }
        // skip 254 and 255, deliver 256 (iv byte wraps to 0x01 relative), then late ones
        XCTAssertNotNil(b.decrypt(packets[256]))
        XCTAssertNotNil(b.decrypt(packets[254]))
        XCTAssertNotNil(b.decrypt(packets[255]))
        XCTAssertNotNil(b.decrypt(packets[257]))
    }

    func testDecryptWithoutKeyFails() {
        let cs = CryptState()
        XCTAssertNil(cs.decrypt(Data([1, 2, 3, 4, 5])))
        XCTAssertNil(cs.encrypt(Data([1])))
    }
}
