import XCTest
@testable import MumbleProtocol

final class VoicePacketTests: XCTestCase {
    func testLegacyOutgoingLayout() {
        var packet = AudioPacket()
        packet.target = VoiceTargetID(3)
        packet.frameNumber = 10
        packet.opusData = Data([0xAA, 0xBB, 0xCC])
        packet.isTerminator = true
        let encoded = [UInt8](VoiceCodec.encodeAudio(packet, format: .legacy))
        XCTAssertEqual(encoded, [0x83, 0x0A, 0xA0, 0x03, 0xAA, 0xBB, 0xCC])
    }

    func testLegacyIncomingDecode() {
        var encoded = Data([0x80])
        MumbleVarint.encode(7, into: &encoded)
        MumbleVarint.encode(300, into: &encoded)
        MumbleVarint.encode(2, into: &encoded)
        encoded.append(contentsOf: [0x01, 0x02])
        for value: Float in [1.0, 2.0, 3.0] {
            var bits = value.bitPattern.littleEndian
            withUnsafeBytes(of: &bits) { encoded.append(contentsOf: $0) }
        }
        guard case .audio(let packet)? = VoiceCodec.decode(encoded, format: .legacy) else { return XCTFail("not audio") }
        XCTAssertEqual(packet.senderSession, 7)
        XCTAssertEqual(packet.frameNumber, 300)
        XCTAssertEqual(packet.opusData, Data([1, 2]))
        XCTAssertFalse(packet.isTerminator)
        XCTAssertEqual(packet.positional, [1, 2, 3])
        XCTAssertEqual(packet.context, .normal)
    }

    func testLegacyPing() {
        let encoded = VoiceCodec.encodePing(UDPPing(timestamp: 123456), format: .legacy)
        XCTAssertEqual(encoded.first, 0x20)
        guard case .ping(let ping)? = VoiceCodec.decode(encoded, format: .legacy) else { return XCTFail("not ping") }
        XCTAssertEqual(ping.timestamp, 123456)
    }

    func testLegacyRejectsNonOpus() {
        XCTAssertNil(VoiceCodec.decode(Data([0x00, 0x01, 0x02]), format: .legacy))
        XCTAssertNil(VoiceCodec.decode(Data(), format: .legacy))
    }

    func testProtobufAudioRoundTrip() {
        var packet = AudioPacket()
        packet.target = VoiceTargetID(2)
        packet.senderSession = 77
        packet.frameNumber = 99
        packet.opusData = Data([9, 8, 7])
        packet.isTerminator = true
        packet.positional = [0.5, -1, 2]
        let encoded = VoiceCodec.encodeAudio(packet, format: .protobuf)
        XCTAssertEqual(encoded.first, 0)
        guard case .audio(let decoded)? = VoiceCodec.decode(encoded, format: .protobuf) else { return XCTFail("not audio") }
        XCTAssertEqual(decoded.target, VoiceTargetID(2))
        XCTAssertEqual(decoded.senderSession, 77)
        XCTAssertEqual(decoded.frameNumber, 99)
        XCTAssertEqual(decoded.opusData, Data([9, 8, 7]))
        XCTAssertTrue(decoded.isTerminator)
        XCTAssertEqual(decoded.positional, [0.5, -1, 2])
    }

    func testProtobufContextDecode() {
        var writer = ProtobufWriter()
        writer.uint32(2, 2)
        writer.uint32(3, 5)
        writer.bytes(5, Data([1]))
        let encoded = Data([0]) + writer.data
        guard case .audio(let decoded)? = VoiceCodec.decode(encoded, format: .protobuf) else { return XCTFail("not audio") }
        XCTAssertEqual(decoded.context, .whisper)
        XCTAssertEqual(decoded.senderSession, 5)
    }

    func testProtobufPingRoundTrip() {
        var ping = UDPPing(timestamp: 42)
        ping.requestExtendedInformation = true
        let encoded = VoiceCodec.encodePing(ping, format: .protobuf)
        XCTAssertEqual(encoded.first, 1)
        var writer = ProtobufWriter()
        writer.uint64(1, 42)
        writer.uint64(3, ProtocolVersion(1, 5, 0).v2)
        writer.uint32(4, 3)
        writer.uint32(5, 100)
        guard case .ping(let reply)? = VoiceCodec.decode(Data([1]) + writer.data, format: .protobuf) else { return XCTFail("not ping") }
        XCTAssertEqual(reply.timestamp, 42)
        XCTAssertEqual(reply.userCount, 3)
        XCTAssertEqual(reply.maxUserCount, 100)
        XCTAssertEqual(ProtocolVersion(v2: reply.serverVersionV2!), ProtocolVersion(1, 5, 0))
    }

    func testWireFormatFromVersion() {
        XCTAssertEqual(VoiceWireFormat(serverVersion: ProtocolVersion(1, 4, 287)), .legacy)
        XCTAssertEqual(VoiceWireFormat(serverVersion: ProtocolVersion(1, 5, 0)), .protobuf)
        XCTAssertEqual(VoiceWireFormat(serverVersion: ProtocolVersion(1, 6, 1)), .protobuf)
    }

    func testServerProbe() {
        let request = ServerProbe.request(identifier: 0x0102030405060708)
        XCTAssertEqual([UInt8](request), [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8])
        var response = Data([0x00, 0x01, 0x04, 0x05])
        response.append(contentsOf: [1, 2, 3, 4, 5, 6, 7, 8])
        response.append(contentsOf: [0, 0, 0, 12])
        response.append(contentsOf: [0, 0, 0, 100])
        response.append(contentsOf: [0, 1, 0x17, 0x70])
        let parsed = ServerProbe.parse(response)!
        XCTAssertEqual(parsed.version, ProtocolVersion(1, 4, 5))
        XCTAssertEqual(parsed.identifier, 0x0102030405060708)
        XCTAssertEqual(parsed.users, 12)
        XCTAssertEqual(parsed.maxUsers, 100)
        XCTAssertEqual(parsed.bandwidth, 72560)
    }
}
