import XCTest
import UIKit

final class ChatBubbleThemeTests: XCTestCase {
    func testOwnBubblesStayCalmAndReadableInDarkThemes() throws {
        continueAfterFailure = false
        try XCTSkipUnless(FakeServer.isListening(), FakeServer.skipReason)
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
        let app = launchConnectedToFakeServer(
            usernamePrefix: "BubbleTest",
            arguments: ["-theme", theme.rawValue, "-appearance", appearance]
        )
        defer { app.terminate() }
        app.buttons["tab-chat"].tap()

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
}
