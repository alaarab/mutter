import Foundation
import XCTest
@testable import MumbleProtocol

final class ChatHighlighterTests: XCTestCase {
    private struct Case: Decodable {
        let name: String
        let code: String
        let lang: String?
        let language: String?
        let detected: Bool
        let tokens: [[String?]]
    }

    /// The browser's highlighter is checked against the same cases, so both
    /// apps colour the same code the same way.
    func testMatchesTheSharedFixtures() throws {
        let fixtures = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("web/test/fixtures/highlight.json")
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: fixtures))
        XCTAssertFalse(cases.isEmpty)
        for item in cases {
            let result = ChatHighlighter.highlight(item.code, language: item.lang)
            XCTAssertEqual(result.language, item.language, item.name)
            XCTAssertEqual(result.detected, item.detected, item.name)
            let expected = item.tokens.map { ChatHighlighter.Token(kind: $0[0].flatMap(ChatHighlighter.Kind.init(rawValue:)), text: $0[1] ?? "") }
            XCTAssertEqual(result.tokens, expected, item.name)
            XCTAssertEqual(result.tokens.map(\.text).joined(), item.code, item.name)
        }
    }

    func testLongScriptsAndHostileInputStayFast() {
        let script = (0..<3000).map { "if [ \"$x\" -gt \($0) ]; then echo 'n' \"${HOME}\" # \($0); fi" }.joined(separator: "\n")
        let inputs: [(String, String?)] = [
            (script, "bash"),
            (script, nil),
            (String(repeating: "'", count: 50_000) + String(repeating: "\"", count: 50_000), "js"),
            (String(repeating: "/*", count: 40_000), "c"),
            (String(repeating: "<a b=\"", count: 20_000), "html"),
            ("{" + String(repeating: " a", count: 50_000), "css"),
            (String(repeating: "\"\\", count: 50_000), "py"),
            (String(repeating: "x", count: 100_000), "sql"),
        ]
        for (code, language) in inputs {
            let started = Date()
            let result = ChatHighlighter.highlight(code, language: language)
            XCTAssertLessThan(Date().timeIntervalSince(started), 3, language ?? "detected")
            XCTAssertEqual(result.tokens.map(\.text).joined(), code)
        }
    }
}
