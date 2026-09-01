import Foundation
import SwiftUI
import UIKit

/// Mumble text messages are HTML fragments. This renders them into attributed text and
/// pulls out inline images (data URIs) so chat can show them as attachments.
enum HTMLText {
    struct Rendered {
        var text: AttributedString
        var images: [UIImage]
        var links: [URL]
    }

    private static let cache = NSCache<NSString, Box>()
    private final class Box {
        let value: Rendered
        init(_ v: Rendered) { value = v }
    }

    static func render(_ html: String) -> Rendered {
        if let cached = cache.object(forKey: html as NSString) { return cached.value }
        let images = extractImages(from: html)
        let stripped = stripImages(from: html)
        var attributed: AttributedString
        if looksLikeHTML(stripped) {
            attributed = attributedFromHTML(stripped) ?? AttributedString(plainText(stripped))
        } else {
            attributed = AttributedString(stripped)
        }
        attributed = normalizeStyle(attributed)
        let links = detectLinks(in: String(attributed.characters))
        let result = Rendered(text: attributed, images: images, links: links)
        cache.setObject(Box(result), forKey: html as NSString)
        return result
    }

    static func plainText(_ html: String) -> String {
        var s = stripImages(from: html)
        s = s.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "</p>", with: "\n", options: .caseInsensitive)
        s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        s = decodeEntities(s)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Escapes user input for sending and auto-links URLs, matching what desktop Mumble does.
    static func htmlFromPlain(_ text: String) -> String {
        var escaped = text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            let ns = escaped as NSString
            let matches = detector.matches(in: escaped, range: NSRange(location: 0, length: ns.length)).reversed()
            for m in matches {
                guard let url = m.url else { continue }
                let original = ns.substring(with: m.range)
                escaped = (escaped as NSString).replacingCharacters(in: m.range, with: "<a href=\"\(url.absoluteString)\">\(original)</a>")
            }
        }
        return escaped.replacingOccurrences(of: "\n", with: "<br />")
    }

    // MARK: - Helpers

    private static func looksLikeHTML(_ s: String) -> Bool {
        s.range(of: "<[a-zA-Z/][^>]*>", options: .regularExpression) != nil || s.contains("&")
    }

    private static func attributedFromHTML(_ html: String) -> AttributedString? {
        let wrapped = "<span style=\"font-family: -apple-system; font-size: 16px;\">\(html)</span>"
        guard let data = wrapped.data(using: .utf8) else { return nil }
        let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [
            .documentType: NSAttributedString.DocumentType.html,
            .characterEncoding: String.Encoding.utf8.rawValue,
        ]
        guard let ns = try? NSAttributedString(data: data, options: options, documentAttributes: nil) else { return nil }
        return try? AttributedString(ns, including: \.uiKit)
    }

    /// Drops fonts/colors from the HTML importer but keeps bold/italic and links so text follows the theme.
    private static func normalizeStyle(_ input: AttributedString) -> AttributedString {
        var out = input
        for run in input.runs {
            let range = run.range
            var traits: UIFontDescriptor.SymbolicTraits = []
            if let font = run.uiKit.font {
                traits = font.fontDescriptor.symbolicTraits
            }
            out[range].uiKit.font = nil
            out[range].uiKit.foregroundColor = nil
            out[range].uiKit.backgroundColor = nil
            out[range].uiKit.paragraphStyle = nil
            if traits.contains(.traitBold) && traits.contains(.traitItalic) {
                out[range].swiftUI.font = .body.bold().italic()
            } else if traits.contains(.traitBold) {
                out[range].swiftUI.font = .body.bold()
            } else if traits.contains(.traitItalic) {
                out[range].swiftUI.font = .body.italic()
            }
            if run.link != nil {
                out[range].swiftUI.foregroundColor = Theme.coral
                out[range].swiftUI.underlineStyle = .single
            }
        }
        // Trim trailing newline the importer likes to add.
        while out.characters.last == "\n" {
            out.characters.removeLast()
        }
        return out
    }

    private static func extractImages(from html: String) -> [UIImage] {
        guard let regex = try? NSRegularExpression(pattern: "<img[^>]*src=[\"']data:image/[a-zA-Z]+;base64,([^\"']+)[\"'][^>]*>", options: .caseInsensitive) else { return [] }
        let ns = html as NSString
        return regex.matches(in: html, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            guard m.numberOfRanges > 1 else { return nil }
            let b64 = ns.substring(with: m.range(at: 1))
            guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { return nil }
            return UIImage(data: data)
        }
    }

    private static func stripImages(from html: String) -> String {
        html.replacingOccurrences(of: "<img[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])
    }

    private static func decodeEntities(_ s: String) -> String {
        var out = s
        let map = ["&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " ", "&apos;": "'"]
        for (k, v) in map { out = out.replacingOccurrences(of: k, with: v) }
        return out
    }

    private static func detectLinks(in text: String) -> [URL] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        let ns = text as NSString
        return detector.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { $0.url }
    }
}
