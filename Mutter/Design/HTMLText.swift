import Foundation
import SwiftUI
import UIKit

enum HTMLText {
    struct Rendered {
        var text: AttributedString
        var images: [UIImage]
        var links: [URL]
        var unreadableImages: Int = 0
    }

    private static let cache = NSCache<NSString, Box>()
    private final class Box {
        let value: Rendered
        init(_ rendered: Rendered) { value = rendered }
    }

    static func trimmed(_ text: AttributedString) -> AttributedString {
        let ws = CharacterSet.whitespacesAndNewlines
        var result = text
        while let first = result.characters.first, first.unicodeScalars.allSatisfy(ws.contains) {
            result.removeSubrange(result.startIndex..<result.index(afterCharacter: result.startIndex))
        }
        while let last = result.characters.last, last.unicodeScalars.allSatisfy(ws.contains) {
            result.removeSubrange(result.index(beforeCharacter: result.endIndex)..<result.endIndex)
        }
        return result
    }

    static func render(_ html: String) -> Rendered {
        if let cached = cache.object(forKey: html as NSString) { return cached.value }
        let (images, unreadable) = extractImages(from: html)
        let stripped = stripImages(from: html)
        var attributed: AttributedString
        if looksLikeHTML(stripped) {
            attributed = attributedFromHTML(stripped) ?? AttributedString(plainText(stripped))
        } else {
            attributed = AttributedString(stripped)
        }
        attributed = normalizeStyle(attributed)
        let links = detectLinks(in: String(attributed.characters))
        let result = Rendered(text: attributed, images: images, links: links, unreadableImages: unreadable)
        cache.setObject(Box(result), forKey: html as NSString)
        return result
    }

    static func plainText(_ html: String) -> String {
        var text = stripImages(from: html)
        text = text.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "</p>", with: "\n", options: .caseInsensitive)
        text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        text = decodeEntities(text)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func htmlFromPlain(_ text: String) -> String {
        var escaped = text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            let nsText = escaped as NSString
            let matches = detector.matches(in: escaped, range: NSRange(location: 0, length: nsText.length)).reversed()
            for match in matches {
                guard let url = match.url else { continue }
                let original = nsText.substring(with: match.range)
                escaped = (escaped as NSString).replacingCharacters(in: match.range, with: "<a href=\"\(url.absoluteString)\">\(original)</a>")
            }
        }
        return escaped.replacingOccurrences(of: "\n", with: "<br />")
    }

    private static func looksLikeHTML(_ text: String) -> Bool {
        text.range(of: "<[a-zA-Z/][^>]*>", options: .regularExpression) != nil || text.contains("&")
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
                out[range].swiftUI.foregroundColor = Theme.accent
                out[range].swiftUI.underlineStyle = .single
            }
        }
        while out.characters.last == "\n" {
            out.characters.removeLast()
        }
        return out
    }

    private static func extractImages(from html: String) -> (images: [UIImage], unreadable: Int) {
        guard let regex = try? NSRegularExpression(pattern: "<img[^>]*src=[\"']data:image/[a-zA-Z]+;base64,([^\"']+)[\"'][^>]*>", options: .caseInsensitive) else { return ([], 0) }
        let nsHTML = html as NSString
        let matches = regex.matches(in: html, range: NSRange(location: 0, length: nsHTML.length))
        let images: [UIImage] = matches.compactMap { match in
            guard match.numberOfRanges > 1 else { return nil }
            var base64 = nsHTML.substring(with: match.range(at: 1))
            if base64.contains("%"), let decoded = base64.removingPercentEncoding { base64 = decoded }
            guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return nil }
            return UIImage(data: data)
        }
        return (images, matches.count - images.count)
    }

    private static func stripImages(from html: String) -> String {
        html.replacingOccurrences(of: "<img[^>]*>", with: "", options: [.regularExpression, .caseInsensitive])
    }

    private static func decodeEntities(_ text: String) -> String {
        var decoded = text
        let entities = ["&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&nbsp;": " ", "&apos;": "'"]
        for (entity, character) in entities { decoded = decoded.replacingOccurrences(of: entity, with: character) }
        return decoded
    }

    private static func detectLinks(in text: String) -> [URL] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        let nsText = text as NSString
        return detector.matches(in: text, range: NSRange(location: 0, length: nsText.length)).compactMap { $0.url }
    }
}
