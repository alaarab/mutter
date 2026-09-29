import XCTest
@testable import MumbleClient

final class ChannelTreeTests: XCTestCase {
    private func channel(_ id: UInt32, parent: UInt32?, name: String? = nil) -> Channel {
        Channel(id: id, parentID: parent, name: name ?? "Channel \(id)")
    }

    private var cyclicChannels: [UInt32: Channel] {
        [
            0: channel(0, parent: nil, name: "Root"),
            1: channel(1, parent: 2),
            2: channel(2, parent: 1),
            3: channel(3, parent: 0),
        ]
    }

    func testAncestryStopsAtACycle() {
        let lineage = Channel.ancestry(of: 1, in: cyclicChannels).map(\.id)
        XCTAssertEqual(lineage, [2, 1])
    }

    func testAncestryRunsFromRootDown() {
        let channels: [UInt32: Channel] = [0: channel(0, parent: nil), 5: channel(5, parent: 0), 9: channel(9, parent: 5)]
        XCTAssertEqual(Channel.ancestry(of: 9, in: channels).map(\.id), [0, 5, 9])
    }

    func testMovingAChannelUnderItsOwnDescendantIsACycle() {
        let channels: [UInt32: Channel] = [0: channel(0, parent: nil), 5: channel(5, parent: 0), 9: channel(9, parent: 5)]
        XCTAssertTrue(Channel.wouldCreateCycle(movingChannel: 5, under: 9, in: channels))
        XCTAssertTrue(Channel.wouldCreateCycle(movingChannel: 5, under: 5, in: channels))
        XCTAssertFalse(Channel.wouldCreateCycle(movingChannel: 9, under: 0, in: channels))
        XCTAssertFalse(Channel.wouldCreateCycle(movingChannel: 9, under: 42, in: channels))
    }

    @MainActor
    func testSessionQueriesSurviveAChannelCycle() {
        let session = ServerSession()
        session.channels = cyclicChannels
        var inCycle = User(session: 10, name: "Looped")
        inCycle.channelID = 1
        var elsewhere = User(session: 11, name: "Rooted")
        elsewhere.channelID = 3
        session.users = [10: inCycle, 11: elsewhere]
        XCTAssertEqual(session.path(to: 1).map(\.id), [2, 1])
        XCTAssertEqual(session.userCount(inTree: 1), 1)
        XCTAssertEqual(session.userCount(inTree: 0), 1)
    }

    @MainActor
    func testNoticeTotalKeepsCountingPastTheCap() {
        let session = ServerSession()
        for _ in 0..<250 {
            session.appendNotice(.connected)
        }
        XCTAssertEqual(session.notices.count, 200)
        XCTAssertEqual(session.totalNoticesPosted, 250)
    }
}
