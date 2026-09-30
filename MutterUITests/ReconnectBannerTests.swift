import XCTest

final class ReconnectBannerTests: XCTestCase {
    func testADroppedConnectionKeepsTheSessionOnScreenWithAReconnectingBanner() throws {
        continueAfterFailure = false
        try XCTSkipUnless(FakeServer.isListening(), FakeServer.skipReason)
        let app = launchConnectedToFakeServer(usernamePrefix: "ReconnectTest")
        app.buttons["tab-chat"].tap()

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Before the drop")
        app.buttons["chat-send"].tap()
        let earlierMessage = app.staticTexts["Before the drop"]
        XCTAssertTrue(earlierMessage.waitForExistence(timeout: 5))

        composer.typeText("fake-server:drop-my-connection")
        app.buttons["chat-send"].tap()

        let reconnectingBanner = app.descendants(matching: .any)["connection-banner-reconnecting"]
        XCTAssertTrue(reconnectingBanner.waitForExistence(timeout: 10), "A dropped connection shows the reconnecting banner")
        attachScreenshot(of: app, named: "reconnecting-banner")
        XCTAssertTrue(app.buttons["tab-channels"].exists || app.keyboards.count > 0, "The session stays on screen while reconnecting")
        XCTAssertTrue(earlierMessage.exists, "The chat stays readable while reconnecting")
        XCTAssertFalse(app.staticTexts["Lost the connection. Hang tight."].exists, "The old full-screen reconnecting state is gone")

        XCTAssertTrue(waitForDisappearance(of: reconnectingBanner, timeout: 20), "The banner clears once the connection is back")
        XCTAssertTrue(earlierMessage.exists, "The chat survives the reconnect")
        XCTAssertTrue(app.buttons["chat-send"].exists)
    }

    private func waitForDisappearance(of element: XCUIElement, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !element.exists { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return false
    }
}
