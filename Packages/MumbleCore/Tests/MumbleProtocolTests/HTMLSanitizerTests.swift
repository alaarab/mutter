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

    func testUnclosedAngleBracketsStayFast() {
        let inputs = [
            String(repeating: "<", count: 65_536),
            String(repeating: "<img", count: 16_384),
            "<a" + String(repeating: " ", count: 65_000),
            "<" + String(repeating: " ", count: 65_000) + "x",
            "<" + String(repeating: " ", count: 65_000) + ">",
            "<a" + String(repeating: " ", count: 65_000) + ">",
        ]
        for input in inputs {
            let started = Date()
            _ = HTMLSanitizer.sanitize(input)
            XCTAssertLessThan(Date().timeIntervalSince(started), 1.0, String(input.prefix(8)))
        }
    }

    func testStrayAngleBracketBeforeATagIsEscaped() {
        XCTAssertEqual(HTMLSanitizer.sanitize("<<b>bold</b>"), "&lt;<b>bold</b>")
    }

    func testCodeKeepsOnlyAFenceLanguageClass() {
        XCTAssertEqual(HTMLSanitizer.sanitize("<pre><code class=\"language-python\">x</code></pre>"), "<pre><code class=\"language-python\">x</code></pre>")
        XCTAssertEqual(HTMLSanitizer.sanitize("<code class='language-c++'>a</code><code class=language-c#>b</code>"), "<code class=\"language-c++\">a</code><code class=\"language-c#\">b</code>")
        let hostile = [
            "<code class=\"language-js\" onclick=\"alert(1)\">x</code>",
            "<code class=\"language-js evil\">x</code>",
            "<code class=\"language-\">x</code>",
            "<code class=\"Language-JS\">x</code>",
            "<code class=\"language-abcdefghijklmnopqrstu\">x</code>",
            "<code class=\"language-js\\\"><script>alert(1)</script>\">x</code>",
            "<code class='language-x\" onmouseover=\"alert(1)'>x</code>",
            "<code class=language-x/onfocus=alert(1)>x</code>",
            "<code style=\"color:red\" class=\"x\">x</code>",
            "<pre class=\"language-js\"><span class=\"language-js\">x</span></pre>",
        ]
        for html in hostile {
            let clean = HTMLSanitizer.sanitize(html)
            for unsafe in ["onclick", "onmouseover", "onfocus", "<script", "style", "evil", "Language"] {
                XCTAssertFalse(clean.contains(unsafe), "\(html) -> \(clean)")
            }
            XCTAssertFalse(clean.contains("class") && !clean.contains("<code class=\"language-"), "\(html) -> \(clean)")
        }
        XCTAssertEqual(HTMLSanitizer.sanitize(hostile[1]), "<code>x</code>")
        XCTAssertEqual(HTMLSanitizer.sanitize(hostile[9]), "<pre><span>x</span></pre>")
    }
}
