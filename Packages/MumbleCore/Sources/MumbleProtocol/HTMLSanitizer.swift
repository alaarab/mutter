import Foundation

public enum HTMLSanitizer {
    private static let allowed = Set(["a", "b", "strong", "i", "em", "u", "s", "br", "p", "span", "div", "ul", "ol", "li", "pre", "code", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "td", "th"])
    private static let dropped = Set(["script", "style", "head", "template", "iframe", "object"])

    public static func isSafeLink(_ url: URL) -> Bool {
        ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "")
    }

    public static func sanitize(_ html: String) -> String {
        let text = String(html.prefix(65_536)) as NSString
        guard let tokens = try? NSRegularExpression(pattern: "<[^>]*>|[^<]+|<"),
              let names = try? NSRegularExpression(pattern: "^<\\s*(/?)\\s*([a-zA-Z][a-zA-Z0-9]*)\\b"),
              let href = try? NSRegularExpression(pattern: "\\s+href\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", options: .caseInsensitive) else { return "" }
        var output = ""
        var suppressed: String?
        for token in tokens.matches(in: text as String, range: NSRange(location: 0, length: text.length)) {
            let value = text.substring(with: token.range) as NSString
            let range = NSRange(location: 0, length: value.length)
            guard let name = names.firstMatch(in: value as String, range: range) else {
                if suppressed == nil { output += (value as String).replacingOccurrences(of: "<", with: "&lt;") }
                continue
            }
            let tag = value.substring(with: name.range(at: 2)).lowercased()
            let closing = name.range(at: 1).length > 0
            if let hidden = suppressed {
                if closing && hidden == tag { suppressed = nil }
                continue
            }
            if dropped.contains(tag) {
                if !closing { suppressed = tag }
                continue
            }
            guard allowed.contains(tag) else { continue }
            if closing {
                output += "</\(tag)>"
            } else if tag == "a", let attribute = href.firstMatch(in: value as String, range: range),
                      let index = (1...3).first(where: { attribute.range(at: $0).location != NSNotFound }) {
                let target = value.substring(with: attribute.range(at: index))
                guard let url = URL(string: target), isSafeLink(url) else { continue }
                let escaped = target.replacingOccurrences(of: "\"", with: "&quot;")
                    .replacingOccurrences(of: "<", with: "&lt;")
                    .replacingOccurrences(of: ">", with: "&gt;")
                output += "<a href=\"\(escaped)\">"
            } else {
                output += "<\(tag)>"
            }
        }
        return output
    }
}
