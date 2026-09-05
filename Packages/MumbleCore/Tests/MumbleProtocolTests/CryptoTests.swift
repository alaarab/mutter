import XCTest
@testable import MumbleProtocol

final class CryptoTests: XCTestCase {
    private let key: [UInt8] = Array(0..<16)
    private let nonce: [UInt8] = Array(0..<16)

    private func hex(_ text: String) -> [UInt8] {
        var bytes: [UInt8] = []
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            bytes.append(UInt8(text[index..<next], radix: 16)!)
            index = next
        }
        return bytes
    }

    private func makePair() -> (sender: CryptState, receiver: CryptState) {
        let sender = CryptState()
        let receiver = CryptState()
        let senderIV: [UInt8] = [0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xA9, 0xBA, 0xCB, 0xDC, 0xED, 0xFE, 0x0F]
        let receiverIV: [UInt8] = [0xF0, 0xE1, 0xD2, 0xC3, 0xB4, 0xA5, 0x96, 0x87, 0x78, 0x69, 0x5A, 0x4B, 0x3C, 0x2D, 0x1E, 0x0F]
        _ = sender.setKey(key, encryptIV: senderIV, decryptIV: receiverIV)
        _ = receiver.setKey(key, encryptIV: receiverIV, decryptIV: senderIV)
        return (sender, receiver)
    }

    func testSoftAESKnownAnswer() {
        let aes = SoftAES128(key: hex("000102030405060708090a0b0c0d0e0f"))
        let ciphertext = aes.encryptBlock(hex("00112233445566778899aabbccddeeff"))
        XCTAssertEqual(ciphertext, hex("69c4e0d86a7b0430d8cdb78070b4c55a"))
        XCTAssertEqual(aes.decryptBlock(ciphertext), hex("00112233445566778899aabbccddeeff"))
    }

    func testPlatformAESMatchesSoftAES() {
        let platform = AES128(key: key)
        let software = SoftAES128(key: key)
        for _ in 0..<20 {
            let block = (0..<16).map { _ in UInt8.random(in: 0...255) }
            XCTAssertEqual(platform.encryptBlock(block), software.encryptBlock(block))
            XCTAssertEqual(platform.decryptBlock(block), software.decryptBlock(block))
        }
    }

    func testOCBVectors() {
        let state = CryptState()
        XCTAssertTrue(state.setKey(key, encryptIV: nonce, decryptIV: nonce))

        let (_, emptyTag) = state.ocbEncrypt([], nonce: nonce)
        XCTAssertEqual(emptyTag, hex("BF3108130773AD5EC70EC69E7875A7B0"))

        let plain: [UInt8] = Array(0..<40)
        let (ciphertext, tag) = state.ocbEncrypt(plain, nonce: nonce)
        XCTAssertEqual(ciphertext, hex("F75D6BC8B4DC8D66B836A2B08B32A6369F1CD3C5228D79FD6C267F5F6AA7B231C7DFB9D59951AE9C"))
        XCTAssertEqual(tag, hex("9DB0CDF880F73E3E10D4EB3217766688"))

        let (decrypted, decryptedTag, ok) = state.ocbDecrypt(ciphertext, nonce: nonce)
        XCTAssertTrue(ok)
        XCTAssertEqual(decrypted, plain)
        XCTAssertEqual(decryptedTag, tag)
    }

    func testOCBRoundTripsAllTailSizes() {
        let state = CryptState()
        _ = state.setKey(key, encryptIV: nonce, decryptIV: nonce)
        for size in [1, 5, 15, 16, 17, 31, 32, 33, 100, 500] {
            let plain = (0..<size).map { _ in UInt8.random(in: 1...255) }
            let (ciphertext, tag) = state.ocbEncrypt(plain, nonce: nonce)
            let (decrypted, decryptedTag, ok) = state.ocbDecrypt(ciphertext, nonce: nonce)
            XCTAssertTrue(ok, "size \(size)")
            XCTAssertEqual(decrypted, plain, "size \(size)")
            XCTAssertEqual(decryptedTag, tag, "size \(size)")
        }
    }

    func testPacketRoundTrip() {
        let (sender, receiver) = makePair()
        let message = Data("It was a funky funky town!".utf8)
        for _ in 0..<600 {
            let packet = sender.encrypt(message)!
            XCTAssertEqual(packet.count, message.count + 4)
            XCTAssertEqual(receiver.decrypt(packet), message)
        }
        XCTAssertEqual(receiver.good, 600)
        XCTAssertEqual(receiver.lost, 0)
    }

    func testTamperedPacketIsRejected() {
        let (sender, receiver) = makePair()
        var packet = sender.encrypt(Data("hello world, hello".utf8))!
        packet[6] ^= 0x01
        XCTAssertNil(receiver.decrypt(packet))
    }

    func testReplayIsRejected() {
        let (sender, receiver) = makePair()
        let packet = sender.encrypt(Data([1, 2, 3]))!
        XCTAssertNotNil(receiver.decrypt(packet))
        XCTAssertNil(receiver.decrypt(packet))
    }

    func testLossAndReorderRecovery() {
        let (sender, receiver) = makePair()
        let packets = (0..<20).map { sender.encrypt(Data([UInt8($0)]))! }
        XCTAssertEqual(receiver.decrypt(packets[0]), Data([0]))
        XCTAssertEqual(receiver.decrypt(packets[1]), Data([1]))
        XCTAssertEqual(receiver.decrypt(packets[4]), Data([4]))
        XCTAssertEqual(receiver.lost, 2)
        XCTAssertEqual(receiver.decrypt(packets[2]), Data([2]))
        XCTAssertEqual(receiver.decrypt(packets[3]), Data([3]))
        XCTAssertEqual(receiver.late, 2)
        XCTAssertEqual(receiver.lost, 0)
        for index in 5..<20 {
            XCTAssertEqual(receiver.decrypt(packets[index]), Data([UInt8(index)]))
        }
    }

    func testLateAcrossWrap() {
        let (sender, receiver) = makePair()
        let packets = (0..<300).map { sender.encrypt(Data([UInt8($0 & 0xFF)]))! }
        for index in 0..<254 {
            _ = receiver.decrypt(packets[index])
        }
        XCTAssertNotNil(receiver.decrypt(packets[256]))
        XCTAssertNotNil(receiver.decrypt(packets[254]))
        XCTAssertNotNil(receiver.decrypt(packets[255]))
        XCTAssertNotNil(receiver.decrypt(packets[257]))
    }

    func testDecryptWithoutKeyFails() {
        let state = CryptState()
        XCTAssertNil(state.decrypt(Data([1, 2, 3, 4, 5])))
        XCTAssertNil(state.encrypt(Data([1])))
    }
}
