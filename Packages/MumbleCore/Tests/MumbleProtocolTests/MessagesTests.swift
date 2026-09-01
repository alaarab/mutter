import XCTest
@testable import MumbleProtocol

final class MessagesTests: XCTestCase {

    func testVersionRoundTrip() throws {
        let v = VersionMessage(version: ProtocolVersion(1, 5, 735), release: "Mutter 0.1", os: "iOS", osVersion: "17.0")
        let decoded = try VersionMessage(payload: v.encodePayload())
        XCTAssertEqual(decoded.protocolVersion, ProtocolVersion(1, 5, 735))
        XCTAssertEqual(decoded.release, "Mutter 0.1")
        XCTAssertEqual(decoded.os, "iOS")
        XCTAssertEqual(decoded.versionV1, 0x010500 | 255)
    }

    func testVersionV1OnlyFallsBack() throws {
        var v = VersionMessage(version: ProtocolVersion(1, 4, 287), release: "", os: "", osVersion: "")
        v.versionV2 = nil
        let decoded = try VersionMessage(payload: v.encodePayload())
        XCTAssertEqual(decoded.protocolVersion, ProtocolVersion(1, 4, 255))
        XCTAssertFalse(decoded.protocolVersion.usesProtobufUDP)
    }

    func testAuthenticateEncoding() {
        var a = AuthenticateMessage(username: "alice", password: "pw", tokens: ["t1", "t2"])
        a.celtVersions = []
        let d = a.encodePayload()
        var r = ProtobufReader(d)
        var fields: [Int: String] = [:]
        var tokens: [String] = []
        var opus: Bool?
        try! r.forEachField { f in
            switch f.number {
            case 1, 2: fields[f.number] = f.stringValue
            case 3: tokens.append(f.stringValue)
            case 5: opus = f.boolValue
            default: break
            }
        }
        XCTAssertEqual(fields[1], "alice")
        XCTAssertEqual(fields[2], "pw")
        XCTAssertEqual(tokens, ["t1", "t2"])
        XCTAssertEqual(opus, true)
    }

    func testChannelStateRoundTrip() throws {
        var c = ChannelStateMessage()
        c.channelId = 5
        c.parent = 0
        c.name = "Lobby"
        c.links = [1, 2]
        c.position = -3
        c.temporary = true
        c.maxUsers = 10
        let decoded = try ChannelStateMessage(payload: c.encodePayload())
        XCTAssertEqual(decoded.channelId, 5)
        XCTAssertEqual(decoded.parent, 0)
        XCTAssertEqual(decoded.name, "Lobby")
        XCTAssertEqual(decoded.links, [1, 2])
        XCTAssertEqual(decoded.position, -3)
        XCTAssertEqual(decoded.temporary, true)
        XCTAssertEqual(decoded.maxUsers, 10)
    }

    func testPackedRepeatedIsAccepted() throws {
        // links (field 4) packed: tag 0x22, len 2, values 1 and 2
        let payload = Data([0x22, 0x02, 0x01, 0x02])
        let decoded = try ChannelStateMessage(payload: payload)
        XCTAssertEqual(decoded.links, [1, 2])
    }

    func testUserStateRoundTrip() throws {
        var u = UserStateMessage()
        u.session = 42
        u.name = "bob"
        u.channelId = 3
        u.selfMute = true
        u.selfDeaf = false
        u.prioritySpeaker = true
        u.hash = "abc"
        let decoded = try UserStateMessage(payload: u.encodePayload())
        XCTAssertEqual(decoded.session, 42)
        XCTAssertEqual(decoded.name, "bob")
        XCTAssertEqual(decoded.channelId, 3)
        XCTAssertEqual(decoded.selfMute, true)
        XCTAssertEqual(decoded.selfDeaf, false)
        XCTAssertEqual(decoded.prioritySpeaker, true)
        XCTAssertEqual(decoded.hash, "abc")
        XCTAssertNil(decoded.mute)
    }

    func testTextMessageRoundTrip() throws {
        let t = TextMessageMessage(message: "<b>hi</b>", sessions: [1], channelIds: [2, 3], treeIds: [0])
        let decoded = try TextMessageMessage(payload: t.encodePayload())
        XCTAssertEqual(decoded.message, "<b>hi</b>")
        XCTAssertEqual(decoded.sessions, [1])
        XCTAssertEqual(decoded.channelIds, [2, 3])
        XCTAssertEqual(decoded.treeIds, [0])
    }

    func testRejectDecoding() throws {
        var w = ProtobufWriter()
        w.uint32(1, 6)
        w.string(2, "full")
        let r = try RejectMessage(payload: w.data)
        XCTAssertEqual(r.type, .serverFull)
        XCTAssertEqual(r.reason, "full")
    }

    func testDispatch() throws {
        var w = ProtobufWriter()
        w.uint32(1, 9)
        w.string(3, "welcome")
        let m = try IncomingMessage.decode(type: MessageType.serverSync.rawValue, payload: w.data)
        if case .serverSync(let s) = m {
            XCTAssertEqual(s.session, 9)
            XCTAssertEqual(s.welcomeText, "welcome")
        } else {
            XCTFail("wrong case")
        }
        if case .unhandled(let type, _) = try IncomingMessage.decode(type: 13, payload: Data()) {
            XCTAssertEqual(type, 13)
        } else {
            XCTFail("ACL should be unhandled")
        }
    }

    func testUserStatsAddress() throws {
        var w = ProtobufWriter()
        w.bytes(14, Data([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF, 10, 0, 0, 1]))
        let s = try UserStatsMessage(payload: w.data)
        XCTAssertEqual(s.addressString, "10.0.0.1")
    }
}
