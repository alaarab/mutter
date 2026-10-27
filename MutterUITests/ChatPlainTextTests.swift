import XCTest

final class ChatPlainTextTests: XCTestCase {
    /// Every everyday message must show its words in the sender's own bubble;
    /// TestFlight 0.1.1 (4) showed one as an empty bubble with only its time.
    func testOwnPlainMessagesShowTheirText() throws {
        continueAfterFailure = true
        try XCTSkipUnless(FakeServer.isListening(), FakeServer.skipReason)
        let app = launchConnectedToFakeServer(usernamePrefix: "PlainTest")
        app.buttons["tab-chat"].tap()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))

        let messages = [
            "hi",
            "test",
            "Hello there",
            "it’s “quoted” now",
            "it's \"straight\" too",
            "a & b",
            "I <3 this",
            "see https://example.com/page",
            "👋🎉",
            "ok.",
            // A lone Markdown marker renders to nothing; it is sent as text.
            "```",
            ">",
        ]
        // Code: the owner's TestFlight report was a one-line fence alone.
        let code: [(typed: String, shown: String)] = [
            ("```\nhey\n```", "hey"),
            ("```swift\nlet x = 1\n```", "let x = 1"),
            ("`hey there`", "hey there"),
            ("say `hi` back", "hi"),
        ]
        for text in messages {
            composer.tap()
            composer.typeText(text)
            app.buttons["chat-send"].tap()
            let shown = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
            XCTAssertTrue(shown.waitForExistence(timeout: 5), "“\(text)” must show in its bubble")
        }
        for (typed, shown) in code {
            composer.tap()
            composer.typeText(typed)
            app.buttons["chat-send"].tap()
            let visible = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", shown)).firstMatch
            XCTAssertTrue(visible.waitForExistence(timeout: 5), "“\(typed)” must show its code")
            if typed.hasPrefix("```") {
                XCTAssertTrue(app.buttons["chat-code-toggle"].firstMatch.exists, "a fenced block shows its header")
            }
        }
        app.descendants(matching: .any)["chat-transcript"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        attachScreenshot(of: app, named: "plain-messages")
    }
}
