import XCTest
@testable import MumbleProtocol

final class VoicePacketTests: XCTestCase {

    func testLegacyOutgoingLayout() {
        var p = AudioPacket()
        p.target = VoiceTargetID(3)
        p.frameNumber = 10
        p.opusData = Data([0xAA, 0xBB, 0xCC])
        p.isTerminator = true
        let d = [UInt8](VoiceCodec.encodeAudio(p, format: .legacy))
        // header: opus (4<<5) | target 3 = 0x83; seq 10; len 3 | 0x2000 -> varint 0x2003 => 0xA0 0x03
        XCTAssertEqual(d, [0x83, 0x0A, 0xA0, 0x03, 0xAA, 0xBB, 0xCC])
    }

    func testLegacyIncomingDecode() {
        // header opus/normal, session 7, seq 300, len 2, opus bytes, positional 3 floats
        var d = Data([0x80])
        MumbleVarint.encode(7, into: &d)
        MumbleVarint.encode(300, into: &d)
        MumbleVarint.encode(2, into: &d)
        d.append(contentsOf: [0x01, 0x02])
        for f: Float in [1.0, 2.0, 3.0] {
            var bits = f.bitPattern.littleEndian
            withUnsafeBytes(of: &bits) { d.append(contentsOf: $0) }
        }
        guard case .audio(let p)? = VoiceCodec.decode(d, format: .legacy) else { return XCTFail("not audio") }
        XCTAssertEqual(p.senderSession, 7)
        XCTAssertEqual(p.frameNumber, 300)
        XCTAssertEqual(p.opusData, Data([1, 2]))
        XCTAssertFalse(p.isTerminator)
        XCTAssertEqual(p.positional, [1, 2, 3])
        XCTAssertEqual(p.context, .normal)
    }

    func testLegacyPing() {
        let d = VoiceCodec.encodePing(UDPPing(timestamp: 123456), format: .legacy)
        XCTAssertEqual(d.first, 0x20)
        guard case .ping(let ping)? = VoiceCodec.decode(d, format: .legacy) else { return XCTFail("not ping") }
        XCTAssertEqual(ping.timestamp, 123456)
    }

    func testLegacyRejectsNonOpus() {
        XCTAssertNil(VoiceCodec.decode(Data([0x00, 0x01, 0x02]), format: .legacy)) // CELT alpha
        XCTAssertNil(VoiceCodec.decode(Data(), format: .legacy))
    }

    func testProtobufAudioRoundTrip() {
        var p = AudioPacket()
        p.target = VoiceTargetID(2)
        p.senderSession = 77
        p.frameNumber = 99
        p.opusData = Data([9, 8, 7])
        p.isTerminator = true
        p.positional = [0.5, -1, 2]
        let d = VoiceCodec.encodeAudio(p, format: .protobuf)
        XCTAssertEqual(d.first, 0)
        guard case .audio(let q)? = VoiceCodec.decode(d, format: .protobuf) else { return XCTFail("not audio") }
        XCTAssertEqual(q.target, VoiceTargetID(2))
        XCTAssertEqual(q.senderSession, 77)
        XCTAssertEqual(q.frameNumber, 99)
        XCTAssertEqual(q.opusData, Data([9, 8, 7]))
        XCTAssertTrue(q.isTerminator)
        XCTAssertEqual(q.positional, [0.5, -1, 2])
    }

    func testProtobufContextDecode() {
        var w = ProtobufWriter()
        w.uint32(2, 2) // context whisper
        w.uint32(3, 5)
        w.bytes(5, Data([1]))
        let d = Data([0]) + w.data
        guard case .audio(let q)? = VoiceCodec.decode(d, format: .protobuf) else { return XCTFail("not audio") }
        XCTAssertEqual(q.context, .whisper)
        XCTAssertEqual(q.senderSession, 5)
    }

    func testProtobufPingRoundTrip() {
        var ping = UDPPing(timestamp: 42)
        ping.requestExtendedInformation = true
        let d = VoiceCodec.encodePing(ping, format: .protobuf)
        XCTAssertEqual(d.first, 1)
        var w = ProtobufWriter()
        w.uint64(1, 42)
        w.uint64(3, ProtocolVersion(1, 5, 0).v2)
        w.uint32(4, 3)
        w.uint32(5, 100)
        guard case .ping(let r)? = VoiceCodec.decode(Data([1]) + w.data, format: .protobuf) else { return XCTFail("not ping") }
        XCTAssertEqual(r.timestamp, 42)
        XCTAssertEqual(r.userCount, 3)
        XCTAssertEqual(r.maxUserCount, 100)
        XCTAssertEqual(ProtocolVersion(v2: r.serverVersionV2!), ProtocolVersion(1, 5, 0))
    }

    func testWireFormatFromVersion() {
        XCTAssertEqual(VoiceWireFormat(serverVersion: ProtocolVersion(1, 4, 287)), .legacy)
        XCTAssertEqual(VoiceWireFormat(serverVersion: ProtocolVersion(1, 5, 0)), .protobuf)
        XCTAssertEqual(VoiceWireFormat(serverVersion: ProtocolVersion(1, 6, 1)), .protobuf)
    }

    func testServerProbe() {
        let req = ServerProbe.request(identifier: 0x0102030405060708)
        XCTAssertEqual([UInt8](req), [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8])
        var resp = Data([0x00, 0x01, 0x04, 0x05])
        resp.append(contentsOf: [1, 2, 3, 4, 5, 6, 7, 8])
        resp.append(contentsOf: [0, 0, 0, 12])
        resp.append(contentsOf: [0, 0, 0, 100])
        resp.append(contentsOf: [0, 1, 0x17, 0x70])
        let parsed = ServerProbe.parse(resp)!
        XCTAssertEqual(parsed.version, ProtocolVersion(1, 4, 5))
        XCTAssertEqual(parsed.identifier, 0x0102030405060708)
        XCTAssertEqual(parsed.users, 12)
        XCTAssertEqual(parsed.maxUsers, 100)
        XCTAssertEqual(parsed.bandwidth, 72560)
    }
}
