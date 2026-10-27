import Foundation

/// Markdown typed in the composer becomes the HTML that Mumble carries, as
/// Mumble's own desktop client does, so every client shows the formatting.
/// Plain text comes out escaped, with `<br />` for newlines. web/app/markdown.js
/// is the same converter for the browser; both are checked against
/// web/test/fixtures/markdown.json.
public enum ChatMarkdown {
    private static let fence = #/^\s{0,3}```/#
    private static let fenceLanguage = #/[A-Za-z0-9+#-]{1,20}/#
    private static let bullet = #/^\s{0,3}[-*+]\s+(.*)$/#
    private static let numbered = #/^\s{0,3}(\d{1,9})[.)]\s+(.*)$/#
    private static let quote = #/^\s{0,3}>\s?(.*)$/#
    private static let heading = #/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/#
    private static let link = #/^\[([^\]\n]+)\]\((https?:\/\/[^\s()<>"]+)\)/#
    private static let bareURL = #/^https?:\/\/[^\s<>"']+/#
    private static let marks: [(mark: String, tag: String)] = [("**", "b"), ("__", "b"), ("~~", "s"), ("*", "i"), ("_", "i")]

    public static func html(from source: String) -> String {
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var out = ""
        // Whether the last thing written was a line of prose, which a
        // following line of prose joins with <br />.
        var afterProse = false
        func block(_ html: String) {
            out += html
            afterProse = false
        }
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if let opening = line.firstMatch(of: fence) {
                let language = Self.language(after: line[opening.range.upperBound...])
                var code: [String] = []
                index += 1
                while index < lines.count, !lines[index].contains(fence) {
                    code.append(lines[index])
                    index += 1
                }
                index += 1
                block("<pre><code\(language.map { " class=\"language-\($0)\"" } ?? "")>\(escape(code.joined(separator: "\n")))</code></pre>")
                continue
            }
            if line.wholeMatch(of: bullet) != nil {
                var items = ""
                while index < lines.count, let match = lines[index].wholeMatch(of: bullet) {
                    items += "<li>\(inline(String(match.1)))</li>"
                    index += 1
                }
                block("<ul>\(items)</ul>")
                continue
            }
            if let first = line.wholeMatch(of: numbered) {
                let start = Int(first.1) ?? 1
                var items = ""
                while index < lines.count, let match = lines[index].wholeMatch(of: numbered) {
                    items += "<li>\(inline(String(match.2)))</li>"
                    index += 1
                }
                block("<ol\(start != 1 ? " start=\"\(start)\"" : "")>\(items)</ol>")
                continue
            }
            if line.wholeMatch(of: quote) != nil {
                var quoted: [String] = []
                while index < lines.count, let match = lines[index].wholeMatch(of: quote) {
                    quoted.append(String(match.1))
                    index += 1
                }
                block("<blockquote>\(html(from: quoted.joined(separator: "\n")))</blockquote>")
                continue
            }
            if let match = line.wholeMatch(of: heading) {
                block("<h3>\(inline(String(match.1)))</h3>")
                index += 1
                continue
            }
            if afterProse { out += "<br />" }
            out += inline(line)
            afterProse = true
            index += 1
        }
        return out
    }

    /// The word after the opening fence, as a class other clients can
    /// ignore. Anything but a plain name is dropped rather than escaped.
    private static func language(after fence: Substring) -> String? {
        guard let word = fence.split(whereSeparator: \.isWhitespace).first,
              word.wholeMatch(of: fenceLanguage) != nil else { return nil }
        return word.lowercased()
    }

    public static func escape(_ text: String) -> String {
        var escaped = ""
        for character in text {
            switch character {
            case "&": escaped += "&amp;"
            case "<": escaped += "&lt;"
            case ">": escaped += "&gt;"
            case "\"": escaped += "&quot;"
            default: escaped.append(character)
            }
        }
        return escaped
    }

    /// Inline marks: `code`, **bold**, *italic*, _italic_, ~~strike~~,
    /// [text](url) and bare http(s) links. Code spans are taken first, so
    /// nothing inside them is formatted.
    private static func inline(_ string: String) -> String {
        let text = Array(string)
        var html = ""
        var index = 0
        while index < text.count {
            let rest = String(text[index...])
            let character = text[index]
            if character == "`", let end = firstIndex(of: "`", in: text, from: index + 1), end > index + 1 {
                html += "<code>\(escape(String(text[(index + 1)..<end])))</code>"
                index = end + 1
                continue
            }
            if character == "[", let match = rest.prefixMatch(of: link) {
                html += "<a href=\"\(escape(String(match.2)))\">\(inline(String(match.1)))</a>"
                index += match.0.count
                continue
            }
            if character == "h", boundaryBefore(text, index), let match = rest.prefixMatch(of: bareURL) {
                var url = String(match.0)
                while let last = url.last, ".,;:!?)]'\"".contains(last) { url.removeLast() }
                html += "<a href=\"\(escape(url))\">\(escape(url))</a>"
                index += url.count
                continue
            }
            if let span = emphasis(text, index) {
                html += "<\(span.tag)>\(inline(span.inner))</\(span.tag)>"
                index = span.end
                continue
            }
            html += escape(String(character))
            index += 1
        }
        return html
    }

    private static func emphasis(_ text: [Character], _ index: Int) -> (tag: String, inner: String, end: Int)? {
        for (mark, tag) in marks {
            let markCharacters = Array(mark)
            guard starts(text, with: markCharacters, at: index) else { continue }
            // Underscores inside words (snake_case) are not emphasis.
            if mark.first == "_" && !boundaryBefore(text, index) { continue }
            let open = index + markCharacters.count
            guard open < text.count, !text[open].isWhitespace, text[open] != markCharacters[0] else { continue }
            var close = find(markCharacters, in: text, from: open + 1)
            while let found = close {
                let after = found + markCharacters.count
                let closesWord = !text[found - 1].isWhitespace && !(markCharacters.count == 1 && after < text.count && text[after] == markCharacters[0])
                let underscoreBoundary = mark.first != "_" || after >= text.count || !(text[after].isLetter || text[after].isNumber)
                if closesWord && underscoreBoundary && !text[open..<found].contains("`") {
                    return (tag, String(text[open..<found]), after)
                }
                close = find(markCharacters, in: text, from: found + 1)
            }
        }
        return nil
    }

    private static func boundaryBefore(_ text: [Character], _ index: Int) -> Bool {
        guard index > 0 else { return true }
        let previous = text[index - 1]
        return !(previous.isLetter || previous.isNumber || previous == "_")
    }

    private static func starts(_ text: [Character], with mark: [Character], at index: Int) -> Bool {
        index + mark.count <= text.count && Array(text[index..<(index + mark.count)]) == mark
    }

    private static func find(_ mark: [Character], in text: [Character], from start: Int) -> Int? {
        var index = start
        while index + mark.count <= text.count {
            if starts(text, with: mark, at: index) { return index }
            index += 1
        }
        return nil
    }

    private static func firstIndex(of character: Character, in text: [Character], from start: Int) -> Int? {
        guard start < text.count else { return nil }
        return text[start...].firstIndex(of: character)
    }
}
