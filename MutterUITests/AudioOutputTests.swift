import XCTest

final class AudioOutputTests: XCTestCase {
    func testWithoutAHeadsetTheOutputMenuOffersOnlyIPhoneAndSpeaker() throws {
        continueAfterFailure = false
        try XCTSkipUnless(FakeServer.isListening(), FakeServer.skipReason)
        let app = launchConnectedToFakeServer(usernamePrefix: "OutputTest")

        let output = app.buttons["audio-output"]
        XCTAssertTrue(output.waitForExistence(timeout: 10))
        output.tap()
        XCTAssertTrue(app.buttons["iPhone"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Speaker"].exists)
        XCTAssertFalse(app.buttons["Bluetooth"].exists, "Bluetooth is listed only when a device is connected")
        attachScreenshot(of: app, named: "audio-output-menu")
        // The simulator has no earpiece, so choosing iPhone still plays on its
        // speaker, and the button rightly says so; that part needs a phone.
    }
}
