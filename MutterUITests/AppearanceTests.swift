import XCTest
import UIKit

final class AppearanceTests: XCTestCase {
    func testChangingThemesKeepsSettingsOpen() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-appearance", "dark"]
        app.launch()
        app.buttons["Settings"].tap()

        for appearance in ["Dark", "Light"] {
            reveal(app.buttons[appearance], in: app, scrollingDown: false)
            app.buttons[appearance].tap()
            assertPreviewAppearance(app.buttons["Carbon"], light: appearance == "Light")
            for theme in ThemeStyle.allCases {
                let button = app.buttons[theme.title]
                reveal(button, in: app, scrollingDown: true)
                button.tap()
                XCTAssertTrue(app.navigationBars["Settings"].exists, "Changing \(theme.title) must preserve the sheet")
                XCTAssertTrue(button.isSelected, "\(theme.title) must remain selected")
            }
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = "Themes-\(appearance)"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        app.buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Mutter"].exists)
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication, scrollingDown: Bool) {
        for _ in 0..<6 where !element.isHittable {
            if scrollingDown { app.swipeUp() } else { app.swipeDown() }
        }
        XCTAssertTrue(element.isHittable)
    }

    private func assertPreviewAppearance(_ element: XCUIElement, light: Bool) {
        let image = UIImage(data: element.screenshot().pngRepresentation)!.cgImage!
        let width = image.width
        let height = image.height
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let pixels = context.data!.assumingMemoryBound(to: UInt8.self)
        let offset = (height / 3 * width + width * 9 / 10) * 4
        let brightness = Double(Int(pixels[offset]) + Int(pixels[offset + 1]) + Int(pixels[offset + 2])) / (3 * 255)
        if light { XCTAssertGreaterThan(brightness, 0.65, "Open settings must actually render the light palette") }
        else { XCTAssertLessThan(brightness, 0.25, "Open settings must actually render the dark palette") }
    }
}
