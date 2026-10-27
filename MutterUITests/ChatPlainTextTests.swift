import XCTest

final class ChatPlainTextTests: XCTestCase {
    /// The owner's TestFlight report: a one-line fence, the first message
    /// sent, showed as an empty bubble with only its time and ticks.
    func testAOneLineFenceSentFirstShowsItsBlock() throws {
        continueAfterFailure = false
        try XCTSkipUnless(FakeServer.isListening(), FakeServer.skipReason)
        let app = launchConnectedToFakeServer(usernamePrefix: "FenceTest")
        app.buttons["tab-chat"].tap()
        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("```\nhey\n```")
        app.buttons["chat-send"].tap()
        RunLoop.current.run(until: Date().addingTimeInterval(1))
        attachScreenshot(of: app, named: "fence-first")
        XCTAssertTrue(app.staticTexts["hey"].waitForExistence(timeout: 5), "the code shows")
        XCTAssertTrue(app.buttons["chat-code-toggle"].waitForExistence(timeout: 5), "the block shows its header")
        XCTAssertFalse(app.descendants(matching: .any)["chat-message-empty"].exists)
    }

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
        let headers = app.buttons.matching(identifier: "chat-code-toggle")
        for (typed, shown) in code {
            let headersBefore = headers.count
            composer.tap()
            composer.typeText(typed)
            app.buttons["chat-send"].tap()
            let visible = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", shown)).firstMatch
            XCTAssertTrue(visible.waitForExistence(timeout: 5), "“\(typed)” must show its code")
            if typed.hasPrefix("```") {
                // Each fence draws its own block, header included.
                let added = NSPredicate(format: "count == %d", headersBefore + 1)
                expectation(for: added, evaluatedWith: headers)
                waitForExpectations(timeout: 5)
            }
        }
        app.descendants(matching: .any)["chat-transcript"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        attachScreenshot(of: app, named: "plain-messages")
    }
}
