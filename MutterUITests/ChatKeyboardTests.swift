import XCTest

final class ChatKeyboardTests: XCTestCase {
    func testChatKeyboardDismissesByDraggingAndTheDraftSurvivesTabs() throws {
        continueAfterFailure = false
        try XCTSkipUnless(FakeServer.isListening(), FakeServer.skipReason)
        let app = launchConnectedToFakeServer(usernamePrefix: "KeyboardTest")
        let chatTab = app.buttons["tab-chat"]
        let channelsTab = app.buttons["tab-channels"]
        chatTab.tap()

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        for line in 1...4 {
            composer.typeText("Message \(line)")
            app.buttons["chat-send"].tap()
        }
        XCTAssertTrue(waitForKeyboard(in: app, visible: true))
        XCTAssertFalse(channelsTab.exists, "The tab bar makes way for the composer while typing")
        attachScreenshot(of: app, named: "chat-keyboard-up")

        let transcript = app.descendants(matching: .any)["chat-transcript"]
        let start = transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98))
        start.press(forDuration: 0.05, thenDragTo: end)
        XCTAssertTrue(waitForKeyboard(in: app, visible: false), "Dragging the transcript down must hide the keyboard")
        XCTAssertTrue(channelsTab.waitForExistence(timeout: 3))
        attachScreenshot(of: app, named: "chat-keyboard-dismissed")

        composer.tap()
        XCTAssertTrue(waitForKeyboard(in: app, visible: true))
        composer.typeText("Half written")
        let composerTop = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        composerTop.press(forDuration: 0.05, thenDragTo: composerTop.withOffset(CGVector(dx: 0, dy: 160)))
        XCTAssertTrue(waitForKeyboard(in: app, visible: false), "Dragging down on the composer must hide the keyboard")

        channelsTab.tap()
        chatTab.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, "Half written", "The draft must survive switching tabs")
    }

    func testOpeningTheKeyboardKeepsTheLatestMessageInView() throws {
        continueAfterFailure = false
        try XCTSkipUnless(FakeServer.isListening(), FakeServer.skipReason)
        let app = launchConnectedToFakeServer(usernamePrefix: "KeyboardTest")
        app.buttons["tab-chat"].tap()

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        let messageCount = 18
        let send = app.buttons["chat-send"]
        for line in 1...messageCount {
            app.typeText("Follow check \(line)")
            send.tap()
        }
        let composerTop = composer.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
        composerTop.press(forDuration: 0.05, thenDragTo: composerTop.withOffset(CGVector(dx: 0, dy: 160)))
        XCTAssertTrue(waitForKeyboard(in: app, visible: false))

        let latestMessage = app.staticTexts["Follow check \(messageCount)"]
        XCTAssertTrue(latestMessage.waitForExistence(timeout: 5))
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        attachScreenshot(of: app, named: "chat-keyboard-down-before-follow")
        XCTAssertTrue(
            isShownAbove(latestMessage, composer),
            "The latest message is in view before the keyboard opens (message \(latestMessage.frame), composer \(composer.frame))"
        )

        composer.tap()
        XCTAssertTrue(waitForKeyboard(in: app, visible: true))
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        attachScreenshot(of: app, named: "chat-keyboard-follows-latest-message")
        XCTAssertTrue(
            isShownAbove(latestMessage, composer),
            "Opening the keyboard must keep the latest message above the composer (message \(latestMessage.frame), composer \(composer.frame))"
        )
    }

    private func isShownAbove(_ message: XCUIElement, _ composer: XCUIElement) -> Bool {
        message.exists && message.frame.height > 0 && message.frame.maxY <= composer.frame.minY + 1 && message.frame.minY >= 0
    }

    private func waitForKeyboard(in app: XCUIApplication, visible: Bool) -> Bool {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if (app.keyboards.count > 0) == visible { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return false
    }
}
