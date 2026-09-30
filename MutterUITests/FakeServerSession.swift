import XCTest
import Network

enum FakeServer {
    static let host = "127.0.0.1"
    static let port: UInt16 = 64740
    static let skipReason = "Start node web/test/fake-server.mjs on port \(port) on the test machine to run this test"

    static func isListening() -> Bool {
        let connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: port)!,
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

extension XCTestCase {
    func launchConnectedToFakeServer(usernamePrefix: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-defaultUsername", "\(usernamePrefix)\(Int.random(in: 1000...9999))", "-rememberedSelfMute", "NO", "-rememberedSelfDeaf", "NO"]
        app.launch()

        app.buttons["Add"].tap()
        app.buttons["Quick connect"].tap()
        let address = app.textFields["host or host:port"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.typeText("\(FakeServer.host):\(FakeServer.port)")
        app.buttons["Connect"].tap()
        let trust = app.buttons["Trust & connect"]
        if trust.waitForExistence(timeout: 10) { trust.tap() }
        XCTAssertTrue(waitForSession(app.buttons["tab-chat"]))
        return app
    }

    func waitForSession(_ chatTab: XCUIElement) -> Bool {
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

    func attachScreenshot(of app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
