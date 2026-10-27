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

        app.buttons["iPhone"].tap()
        let chosen = NSPredicate(format: "label == %@", "Audio output: iPhone")
        expectation(for: chosen, evaluatedWith: output)
        waitForExpectations(timeout: 5)
    }
}
