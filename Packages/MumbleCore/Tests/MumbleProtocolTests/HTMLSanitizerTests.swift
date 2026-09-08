import Foundation
import XCTest
@testable import MumbleProtocol

final class HTMLSanitizerTests: XCTestCase {
    func testFormattingSurvivesWithoutActiveAttributes() {
        let html = "<p style='background:url(https://tracker.example)'>Hello <b onclick='alert(1)'>there</b><br><a href='https://example.com/?a=1&amp;b=2' target='_self'>link</a></p>"
        XCTAssertEqual(HTMLSanitizer.sanitize(html), "<p>Hello <b>there</b><br><a href=\"https://example.com/?a=1&amp;b=2\">link</a></p>")
    }

    func testEmbeddedResourcesAndScriptsAreRemoved() {
        let html = "<link rel='stylesheet' href='https://tracker.example'><style>@import 'https://tracker.example';</style><iframe src='file:///etc/passwd'>hidden</iframe><img src='https://tracker.example'><script>alert(1)</script><b>Message</b>"
        XCTAssertEqual(HTMLSanitizer.sanitize(html), "<b>Message</b>")
    }

    func testUnsafeSchemesCannotBecomeLinks() {
        for target in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", "tel:123", "&#106;avascript:alert(1)"] {
            XCTAssertFalse(HTMLSanitizer.sanitize("<a href='\(target)'>text</a>").contains("href="), target)
        }
        XCTAssertTrue(HTMLSanitizer.sanitize("<a href='mailto:hello@example.com'>mail</a>").contains("href="))
    }

    func testUnknownAndMalformedTagsCannotAddMarkup() {
        XCTAssertEqual(HTMLSanitizer.sanitize("<constructor>hello</constructor>"), "hello")
        XCTAssertEqual(HTMLSanitizer.sanitize("hello <"), "hello &lt;")
        XCTAssertEqual(HTMLSanitizer.sanitize("<b onclick='x'>text</b><script>unfinished"), "<b>text</b>")
    }

    func testOversizedTextIsBounded() {
        XCTAssertEqual(HTMLSanitizer.sanitize(String(repeating: "a", count: 100_000)).count, 65_536)
    }
}
