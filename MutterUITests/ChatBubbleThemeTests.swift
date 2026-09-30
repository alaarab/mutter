import XCTest
import UIKit
import Network

final class ChatBubbleThemeTests: XCTestCase {
    private static let fakeServerHost = "127.0.0.1"
    private static let fakeServerPort: UInt16 = 64740

    func testOwnBubblesStayCalmAndReadableInDarkThemes() throws {
        continueAfterFailure = false
        try XCTSkipUnless(
            Self.fakeServerAcceptsConnections(),
            "Start node web/test/fake-server.mjs on port \(Self.fakeServerPort) on the test machine to run this test"
        )
        for theme in [ThemeStyle.carbon, .midnight, .plum, .ultra] {
            let bubbleBrightness = try ownBubbleBrightness(theme: theme, appearance: "dark")
            XCTAssertLessThan(
                bubbleBrightness,
                0.5,
                "\(theme.title) dark must not paint your own messages as a pale, glaring bubble"
            )
        }
        let lightBrightness = try ownBubbleBrightness(theme: .carbon, appearance: "light")
        XCTAssertLessThan(lightBrightness, 0.5, "Carbon light keeps its filled accent bubble for your own messages")
    }

    private func ownBubbleBrightness(theme: ThemeStyle, appearance: String) throws -> Double {
        let app = XCUIApplication()
        app.launchArguments = [
            "-theme", theme.rawValue,
            "-appearance", appearance,
            "-defaultUsername", "BubbleTest\(Int.random(in: 1000...9999))",
            "-rememberedSelfMute", "NO",
            "-rememberedSelfDeaf", "NO",
        ]
        app.launch()
        defer { app.terminate() }

        app.buttons["Add"].tap()
        app.buttons["Quick connect"].tap()
        let address = app.textFields["host or host:port"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.tap()
        address.typeText("\(Self.fakeServerHost):\(Self.fakeServerPort)")
        app.buttons["Connect"].tap()
        let trust = app.buttons["Trust & connect"]
        if trust.waitForExistence(timeout: 10) { trust.tap() }

        let chatTab = app.buttons["tab-chat"]
        XCTAssertTrue(chatTabBecomesReachable(chatTab))
        chatTab.tap()

        let composer = app.descendants(matching: .any)["chat-composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        let messageText = "Bubble check \(theme.rawValue) https://example.com"
        composer.typeText(messageText)
        app.buttons["chat-send"].tap()

        let transcript = app.descendants(matching: .any)["chat-transcript"]
        transcript.tap()
        let sentMessage = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Bubble check \(theme.rawValue)")).firstMatch
        XCTAssertTrue(sentMessage.waitForExistence(timeout: 5))
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))

        let screenshot = app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "own-bubble-\(theme.rawValue)-\(appearance)"
        attachment.lifetime = .keepAlways
        add(attachment)

        let paddingPoint = CGPoint(x: sentMessage.frame.minX - 6, y: sentMessage.frame.midY)
        return brightness(of: screenshot.image, atPoint: paddingPoint)
    }

    private func brightness(of image: UIImage, atPoint point: CGPoint) -> Double {
        let cgImage = image.cgImage!
        let width = cgImage.width
        let height = cgImage.height
        let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )!
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        let pixels = context.data!.assumingMemoryBound(to: UInt8.self)
        let pixelX = min(max(Int(point.x * image.scale), 0), width - 1)
        let pixelYFromTop = min(max(Int(point.y * image.scale), 0), height - 1)
        let offset = (pixelYFromTop * width + pixelX) * 4
        return Double(Int(pixels[offset]) + Int(pixels[offset + 1]) + Int(pixels[offset + 2])) / (3 * 255)
    }

    private func chatTabBecomesReachable(_ chatTab: XCUIElement) -> Bool {
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

    private static func fakeServerAcceptsConnections() -> Bool {
        let connection = NWConnection(
            host: NWEndpoint.Host(fakeServerHost),
            port: NWEndpoint.Port(rawValue: fakeServerPort)!,
            using: .tcp
        )
        let finished = DispatchSemaphore(value: 0)
        var accepted = false
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                accepted = true
                finished.signal()
            case .failed, .waiting:
                finished.signal()
            default:
                break
            }
        }
        connection.start(queue: DispatchQueue(label: "mutter.uitest.bubble-probe"))
        _ = finished.wait(timeout: .now() + 2)
        connection.cancel()
        return accepted
    }
}
