import XCTest
@testable import MumbleProtocol

final class MessagesTests: XCTestCase {
    func testVersionRoundTrip() throws {
        let version = VersionMessage(version: ProtocolVersion(1, 5, 735), release: "Mutter 0.1", os: "iOS", osVersion: "17.0")
        let decoded = try VersionMessage(payload: version.encodePayload())
        XCTAssertEqual(decoded.protocolVersion, ProtocolVersion(1, 5, 735))
        XCTAssertEqual(decoded.release, "Mutter 0.1")
        XCTAssertEqual(decoded.os, "iOS")
        XCTAssertEqual(decoded.versionV1, 0x010500 | 255)
    }

    func testVersionV1OnlyFallsBack() throws {
        var version = VersionMessage(version: ProtocolVersion(1, 4, 287), release: "", os: "", osVersion: "")
        version.versionV2 = nil
        let decoded = try VersionMessage(payload: version.encodePayload())
        XCTAssertEqual(decoded.protocolVersion, ProtocolVersion(1, 4, 255))
        XCTAssertFalse(decoded.protocolVersion.usesProtobufUDP)
    }

    func testAuthenticateEncoding() {
        var auth = AuthenticateMessage(username: "alice", password: "pw", tokens: ["t1", "t2"])
        auth.celtVersions = []
        var reader = ProtobufReader(auth.encodePayload())
        var strings: [Int: String] = [:]
        var tokens: [String] = []
        var opus: Bool?
        try! reader.forEachField { field in
            switch field.number {
            case 1, 2: strings[field.number] = field.stringValue
            case 3: tokens.append(field.stringValue)
            case 5: opus = field.boolValue
            default: break
            }
        }
        XCTAssertEqual(strings[1], "alice")
        XCTAssertEqual(strings[2], "pw")
        XCTAssertEqual(tokens, ["t1", "t2"])
        XCTAssertEqual(opus, true)
    }

    func testChannelStateRoundTrip() throws {
        var channel = ChannelStateMessage()
        channel.channelId = 5
        channel.parent = 0
        channel.name = "Lobby"
        channel.links = [1, 2]
        channel.position = -3
        channel.temporary = true
        channel.maxUsers = 10
        let decoded = try ChannelStateMessage(payload: channel.encodePayload())
        XCTAssertEqual(decoded.channelId, 5)
        XCTAssertEqual(decoded.parent, 0)
        XCTAssertEqual(decoded.name, "Lobby")
        XCTAssertEqual(decoded.links, [1, 2])
        XCTAssertEqual(decoded.position, -3)
        XCTAssertEqual(decoded.temporary, true)
        XCTAssertEqual(decoded.maxUsers, 10)
    }

    func testPackedRepeatedIsAccepted() throws {
        let packedLinks = Data([0x22, 0x02, 0x01, 0x02])
        let decoded = try ChannelStateMessage(payload: packedLinks)
        XCTAssertEqual(decoded.links, [1, 2])
    }

    func testUserStateRoundTrip() throws {
        var state = UserStateMessage()
        state.session = 42
        state.name = "bob"
        state.channelId = 3
        state.selfMute = true
        state.selfDeaf = false
        state.prioritySpeaker = true
        state.hash = "abc"
        let decoded = try UserStateMessage(payload: state.encodePayload())
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
        let text = TextMessageMessage(message: "<b>hi</b>", sessions: [1], channelIds: [2, 3], treeIds: [0])
        let decoded = try TextMessageMessage(payload: text.encodePayload())
        XCTAssertEqual(decoded.message, "<b>hi</b>")
        XCTAssertEqual(decoded.sessions, [1])
        XCTAssertEqual(decoded.channelIds, [2, 3])
        XCTAssertEqual(decoded.treeIds, [0])
    }

    func testRejectDecoding() throws {
        var writer = ProtobufWriter()
        writer.uint32(1, 6)
        writer.string(2, "full")
        let reject = try RejectMessage(payload: writer.data)
        XCTAssertEqual(reject.type, .serverFull)
        XCTAssertEqual(reject.reason, "full")
    }

    func testDispatch() throws {
        var writer = ProtobufWriter()
        writer.uint32(1, 9)
        writer.string(3, "welcome")
        let message = try IncomingMessage.decode(type: MessageType.serverSync.rawValue, payload: writer.data)
        if case .serverSync(let sync) = message {
            XCTAssertEqual(sync.session, 9)
            XCTAssertEqual(sync.welcomeText, "welcome")
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
        var writer = ProtobufWriter()
        writer.bytes(14, Data([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF, 10, 0, 0, 1]))
        let stats = try UserStatsMessage(payload: writer.data)
        XCTAssertEqual(stats.addressString, "10.0.0.1")
    }
}
