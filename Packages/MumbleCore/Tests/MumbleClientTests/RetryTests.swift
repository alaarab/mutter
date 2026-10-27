import XCTest
@testable import MumbleClient

@MainActor
final class RetryTests: XCTestCase {
    private func ownMessage(_ delivery: MessageDelivery) -> ChatMessage {
        var message = ChatMessage(senderSession: 1, senderName: "Me", html: "hello", scope: .channel(0), isOwn: true)
        message.delivery = delivery
        return message
    }

    func testOnlyALostMessageCanBeRetried() {
        XCTAssertTrue(MessageDelivery.failed(reason: "connection lost", canRetry: true).canRetry)
        XCTAssertFalse(MessageDelivery.failed(reason: "Message too long", canRetry: false).canRetry)
        XCTAssertFalse(MessageDelivery.delivered.canRetry)
        XCTAssertFalse(MessageDelivery.sending.canRetry)
    }

    func testARefusedMessageStaysWhereItIs() {
        let client = MumbleClient()
        let refused = ownMessage(.failed(reason: "Message too long", canRetry: false))
        client.session.state = .connected
        client.session.messages = [refused]
        client.retry(refused)
        XCTAssertEqual(client.session.messages.map(\.id), [refused.id])
    }

    func testRetryWaitsForAConnection() {
        let client = MumbleClient()
        let lost = ownMessage(.failed(reason: "connection lost", canRetry: true))
        client.session.messages = [lost]
        client.retry(lost)
        XCTAssertEqual(client.session.messages.map(\.id), [lost.id])
    }

    func testRetryTakesTheMessageOutOnceAndPutsItBackIfItCannotBeSent() async throws {
        let client = MumbleClient()
        let before = ownMessage(.delivered)
        let lost = ownMessage(.failed(reason: "connection lost", canRetry: true))
        let after = ChatMessage(senderSession: 2, senderName: "Them", html: "hi", scope: .channel(0))
        client.session.state = .connected
        client.session.messages = [before, lost, after]

        client.retry(lost)
        client.retry(lost)
        XCTAssertEqual(client.session.messages.map(\.id), [before.id, after.id], "a second tap finds nothing to send")

        // The session says connected but the client never synced, so the send
        // cannot happen and the failed message returns to its place.
        for _ in 0..<100 where client.session.messages.count < 3 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(client.session.messages.map(\.id), [before.id, lost.id, after.id])
        XCTAssertEqual(client.session.totalMessagesPosted, 0, "nothing new was posted")
    }
}
