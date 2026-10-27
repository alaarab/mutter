import XCTest

final class ChatSelectionTests: XCTestCase {
    func testHoldingAMessageOffersCopyAndSelectingItsText() throws {
        continueAfterFailure = false
        try XCTSkipUnless(FakeServer.isListening(), FakeServer.skipReason)
        let app = launchConnectedToFakeServer(usernamePrefix: "SelectTest")
        app.buttons["tab-chat"].tap()

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Select these words please")
        app.buttons["chat-send"].tap()
        let transcript = app.descendants(matching: .any)["chat-transcript"]
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)).tap()

        let message = app.staticTexts["Select these words please"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        message.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 3), "Holding a message offers Copy")
        let selectText = app.buttons["Select Text"]
        XCTAssertTrue(selectText.exists, "Holding a message offers Select Text")
        attachScreenshot(of: app, named: "chat-message-menu")
        selectText.tap()

        let selectable = app.textViews["chat-message-selection"]
        XCTAssertTrue(selectable.waitForExistence(timeout: 3), "Select Text lays selectable text over the message")
        XCTAssertEqual(selectable.value as? String, "Select these words please")
        XCTAssertTrue(app.menuItems["Copy"].waitForExistence(timeout: 3), "The selection shows the native Copy menu")
        attachScreenshot(of: app, named: "chat-message-selecting")

        let empty = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
        let deadline = Date().addingTimeInterval(5)
        while selectable.exists && Date() < deadline {
            empty.tap()
            RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        }
        XCTAssertFalse(selectable.exists, "A tap elsewhere in the transcript ends the selection")
        XCTAssertTrue(message.exists)
    }
}
