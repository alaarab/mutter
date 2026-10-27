import Foundation
import XCTest
@testable import MumbleProtocol

final class ChatMarkdownTests: XCTestCase {
    private struct Case: Decodable {
        let name: String
        let markdown: String
        let html: String
    }

    /// The browser's converter is checked against the same cases, so both
    /// apps send the same HTML for the same Markdown.
    func testMatchesTheSharedFixtures() throws {
        let fixtures = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("web/test/fixtures/markdown.json")
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: fixtures))
        XCTAssertFalse(cases.isEmpty)
        for item in cases {
            XCTAssertEqual(ChatMarkdown.html(from: item.markdown), item.html, item.name)
        }
    }

    func testOutputPassesTheSanitizerUnchanged() {
        let html = ChatMarkdown.html(from: "**a** `b`\n- c\n> d\n```\ne\n```\n```C++\nf\n```")
        XCTAssertEqual(HTMLSanitizer.sanitize(html), html)
    }
}
