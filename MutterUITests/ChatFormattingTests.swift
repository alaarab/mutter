import XCTest

final class ChatFormattingTests: XCTestCase {
    func testMarkdownIsFormattedCodeCopiesAndTheServerConfirmsDelivery() throws {
        continueAfterFailure = false
        try XCTSkipUnless(FakeServer.isListening(), FakeServer.skipReason)
        let app = launchConnectedToFakeServer(usernamePrefix: "FormatTest")
        app.buttons["tab-chat"].tap()

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Ready for **raid night**? Use `push-to-talk`")
        app.buttons["chat-send"].tap()

        // The marks are gone from the text: it was sent as HTML and shown formatted.
        let formatted = app.staticTexts["Ready for raid night? Use push-to-talk"]
        XCTAssertTrue(formatted.waitForExistence(timeout: 5), "Markdown marks become formatting")
        let delivery = app.descendants(matching: .any)["chat-delivery"].firstMatch
        XCTAssertTrue(delivery.waitForExistence(timeout: 5))
        let confirmed = NSPredicate(format: "label == %@", "Delivered to the server")
        expectation(for: confirmed, evaluatedWith: delivery)
        waitForExpectations(timeout: 5)

        composer.tap()
        composer.typeText("Run this:\n```\nnpm run raid\n```")
        app.buttons["chat-send"].tap()
        let copyCode = app.buttons["chat-code-copy"]
        XCTAssertTrue(copyCode.waitForExistence(timeout: 5), "A code block has its own Copy button")
        XCTAssertTrue(app.staticTexts["npm run raid"].exists, "The code shows without its fences")
        app.descendants(matching: .any)["chat-transcript"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        attachScreenshot(of: app, named: "chat-formatting")
        copyCode.tap()
        XCTAssertTrue(app.buttons["Copied"].waitForExistence(timeout: 2), "Copying the code confirms it")

        formatted.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Copy Conversation"].waitForExistence(timeout: 3), "Holding a message offers Copy Conversation")
        attachScreenshot(of: app, named: "chat-formatting-menu")
        app.buttons["Copy Conversation"].tap()

        composer.tap()
        composer.typeText("Todo:\n- milk\n- eggs")
        app.buttons["chat-send"].tap()
        let list = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "•  milk")).firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 5), "List items keep their bullets")

        // A message with a code block is selected as its whole text.
        app.descendants(matching: .any)["chat-transcript"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)).tap()
        app.staticTexts["Run this:"].press(forDuration: 1.0)
        app.buttons["Select Text"].tap()
        attachScreenshot(of: app, named: "chat-formatting-selecting")
        let selectable = app.textViews["chat-message-selection"]
        XCTAssertTrue(selectable.waitForExistence(timeout: 3))
        XCTAssertEqual(selectable.value as? String, "Run this:\nnpm run raid")
    }
}
