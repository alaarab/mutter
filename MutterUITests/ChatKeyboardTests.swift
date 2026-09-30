import XCTest
import Network

final class ChatKeyboardTests: XCTestCase {
    private static let serverHost = "127.0.0.1"
    private static let serverPort: UInt16 = 64740

    func testChatKeyboardDismissesByDraggingAndTheDraftSurvivesTabs() throws {
        continueAfterFailure = false
        try XCTSkipUnless(
            Self.serverIsListening(),
            "Start node web/test/fake-server.mjs on port \(Self.serverPort) on the test machine to run this test"
        )
        let app = XCUIApplication()
        app.launchArguments = ["-defaultUsername", "KeyboardTest\(Int.random(in: 1000...9999))", "-rememberedSelfMute", "NO", "-rememberedSelfDeaf", "NO"]
        app.launch()

        app.buttons["Add"].tap()
        app.buttons["Quick connect"].tap()
        let address = app.textFields["host or host:port"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.typeText("\(Self.serverHost):\(Self.serverPort)")
        app.buttons["Connect"].tap()
        let trust = app.buttons["Trust & connect"]
        if trust.waitForExistence(timeout: 10) { trust.tap() }

        let chatTab = app.buttons["tab-chat"]
        let channelsTab = app.buttons["tab-channels"]
        XCTAssertTrue(waitForSession(chatTab))
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

    private func waitForSession(_ chatTab: XCUIElement) -> Bool {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            for answer in ["Allow", "OK"] where springboard.buttons[answer].exists {
                springboard.buttons[answer].tap()
            }
            if chatTab.exists && chatTab.isHittable { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return false
    }

    private func waitForKeyboard(in app: XCUIApplication, visible: Bool) -> Bool {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if (app.keyboards.count > 0) == visible { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return false
    }

    private func attachScreenshot(of app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private static func serverIsListening() -> Bool {
        let connection = NWConnection(
            host: NWEndpoint.Host(serverHost),
            port: NWEndpoint.Port(rawValue: serverPort)!,
            using: .tcp
        )
        let finished = DispatchSemaphore(value: 0)
        var listening = false
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                listening = true
                finished.signal()
            case .failed, .waiting:
                finished.signal()
            default:
                break
            }
        }
        connection.start(queue: DispatchQueue(label: "mutter.uitest.probe"))
        _ = finished.wait(timeout: .now() + 2)
        connection.cancel()
        return listening
    }
}
