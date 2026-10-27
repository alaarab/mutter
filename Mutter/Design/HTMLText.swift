import Foundation
import SwiftUI
import UIKit
import ImageIO
import MumbleProtocol

enum HTMLText {
    struct Rendered {
        /// The whole message as one run of text, for copying and previews.
        var text: AttributedString
        /// The same text split where it is shown differently: prose, code
        /// blocks and quotes.
        var blocks: [Block] = []
        var images: [UIImage]
        var links: [URL]
        var unreadableImages: Int = 0
    }

    /// The brand text face has no italic, which SwiftUI will not slant,
    /// so italic runs use the system face.
    static let italicFont = Font.system(.body).italic()
    static let boldItalicFont = Font.system(.body, weight: .bold).italic()

    enum Block: Hashable {
        case prose(AttributedString)
        /// The code and the fence language it was sent with, if any.
        case code(String, language: String?)
        case quote(AttributedString)
    }

    private struct Prepared {
        var markup: String
        var looksLikeHTML: Bool
        var images: [UIImage]
        var unreadableImages: Int
    }

    private static let maximumScannedLength = 4 * 1024 * 1024
    private static let maximumTextLength = 65_536

    private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 300
        cache.totalCostLimit = 48 * 1024 * 1024
        return cache
    }()
    private static let preparedCache: NSCache<NSString, PreparedBox> = {
        let cache = NSCache<NSString, PreparedBox>()
        cache.countLimit = 100
        cache.totalCostLimit = 32 * 1024 * 1024
        return cache
    }()
    private final class Box {
        let value: Rendered
        init(_ rendered: Rendered) { value = rendered }
    }
    private final class PreparedBox {
        let value: Prepared
        init(_ prepared: Prepared) { value = prepared }
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

    static func prepareInBackground(_ html: String) {
        let key = html as NSString
        guard cache.object(forKey: key) == nil, preparedCache.object(forKey: key) == nil else { return }
        let prepared = prepare(html)
        preparedCache.setObject(PreparedBox(prepared), forKey: key, cost: cost(of: html, images: prepared.images))
    }

    static func render(_ html: String) -> Rendered {
        let key = html as NSString
        if let cached = cache.object(forKey: key) { return cached.value }
        let prepared = preparedCache.object(forKey: key)?.value ?? prepare(html)
        preparedCache.removeObject(forKey: key)
        var blocks: [Block]
        if prepared.looksLikeHTML {
            blocks = splitBlocks(prepared.markup).compactMap { block in
                switch block {
                case .prose(let markup):
                    let text = proseText(markup)
                    return text.characters.isEmpty ? nil : .prose(text)
                case .quote(let markup):
                    let text = proseText(markup)
                    return text.characters.isEmpty ? nil : .quote(text)
                case .code(let markup, let language):
                    let code = decodeEntities(markup.replacingOccurrences(of: "<[^<>]*+>", with: "", options: .regularExpression))
                    return code.isEmpty ? nil : .code(code.hasSuffix("\n") ? String(code.dropLast()) : code, language: language)
                }
            }
        } else {
            let text = normalizeStyle(AttributedString(prepared.markup))
            blocks = text.characters.isEmpty ? [] : [.prose(text)]
        }
        // Formatting that renders to nothing (an empty code block or quote
        // from another client) still shows whatever text the message has.
        if blocks.isEmpty {
            let plain = plainText(html)
            if !plain.isEmpty { blocks = [.prose(normalizeStyle(AttributedString(plain)))] }
        }
        var attributed = AttributedString()
        for (index, block) in blocks.enumerated() {
            if index > 0 { attributed += AttributedString("\n") }
            switch block {
            case .prose(let text), .quote(let text): attributed += text
            case .code(let code, _): attributed += AttributedString(code)
            }
        }
        let links = detectLinks(in: String(attributed.characters))
        let result = Rendered(text: attributed, blocks: blocks, images: prepared.images, links: links, unreadableImages: prepared.unreadableImages)
        cache.setObject(Box(result), forKey: key, cost: cost(of: html, images: prepared.images))
        return result
    }

    private static func prepare(_ html: String) -> Prepared {
        let bounded = String(html.prefix(maximumScannedLength))
        let (images, unreadable) = extractImages(from: bounded)
        let stripped = String(stripImages(from: bounded).prefix(maximumTextLength))
        let isHTML = looksLikeHTML(stripped)
        return Prepared(
            markup: isHTML ? HTMLSanitizer.sanitize(stripped) : stripped,
            looksLikeHTML: isHTML,
            images: images,
            unreadableImages: unreadable
        )
    }

    private static func cost(of html: String, images: [UIImage]) -> Int {
        html.utf8.count + images.reduce(0) { $0 + ($1.cgImage?.bytesPerRow ?? 0) * ($1.cgImage?.height ?? 0) }
    }

    static func plainText(_ html: String) -> String {
        var text = String(stripImages(from: String(html.prefix(maximumScannedLength))).prefix(maximumTextLength))
        text = text.replacingOccurrences(of: "<br\\s*+/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "</(p|li|pre|blockquote|h[1-6]|ul|ol|div|tr)>", with: "\n", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "<li[^<>]*+>", with: "- ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "<(pre|blockquote|ul|ol|h[1-6])[^<>]*+>", with: "\n", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: "<[^<>]*+>", with: "", options: .regularExpression)
        text = decodeEntities(text)
        text = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
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
        text.range(of: "<[a-zA-Z/][^<>]*+>", options: .regularExpression) != nil || text.contains("&")
    }

    private enum RawBlock {
        case prose(String)
        case code(String, language: String?)
        case quote(String)
    }

    private static let blockPattern = try! NSRegularExpression(
        pattern: "<pre>(?:\\s*<code(?: class=\"language-([a-z0-9+#-]{1,20})\")?>)?(.*?)(?:</code>\\s*)?</pre>|<blockquote>(.*?)</blockquote>",
        options: [.caseInsensitive, .dotMatchesLineSeparators]
    )

    /// Code blocks and quotes come out of the sanitized markup as their own
    /// blocks; everything around them is prose.
    private static func splitBlocks(_ markup: String) -> [RawBlock] {
        let ns = markup as NSString
        var blocks: [RawBlock] = []
        var cursor = 0
        for match in blockPattern.matches(in: markup, range: NSRange(location: 0, length: ns.length)) {
            if match.range.location > cursor {
                blocks.append(.prose(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))))
            }
            if match.range(at: 2).location != NSNotFound {
                let language = match.range(at: 1).location != NSNotFound ? ns.substring(with: match.range(at: 1)) : nil
                blocks.append(.code(ns.substring(with: match.range(at: 2)), language: language))
            } else {
                blocks.append(.quote(ns.substring(with: match.range(at: 3))))
            }
            cursor = match.range.location + match.range.length
        }
        if cursor < ns.length {
            blocks.append(.prose(ns.substring(from: cursor)))
        }
        return blocks
    }

    private static func proseText(_ markup: String) -> AttributedString {
        var text = normalizeStyle(attributedFromSanitizedHTML(markup) ?? AttributedString(plainText(markup)))
        // Only line breaks: a leading list marker's spaces are part of it.
        while text.characters.first == "\n" { text.characters.removeFirst() }
        return text
    }

    private static let listMarker = try! NSRegularExpression(pattern: "^\\t(•|\\d+)\\t", options: .anchorsMatchLines)

    /// iOS keeps list bullets and numbers in the paragraph style rather
    /// than the text, so they would vanish with it: write them in.
    private static func insertListMarkers(into text: NSMutableAttributedString) {
        let string = text.string as NSString
        var items: [(location: Int, marker: String)] = []
        var numbers: [ObjectIdentifier: Int] = [:]
        string.enumerateSubstrings(in: NSRange(location: 0, length: string.length), options: [.byParagraphs, .substringNotRequired]) { _, range, _, _ in
            guard range.length > 0,
                  let style = text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle,
                  let list = style.textLists.last,
                  !string.substring(with: range).hasPrefix("\t") else { return }
            let number = (numbers[ObjectIdentifier(list)] ?? list.startingItemNumber - 1) + 1
            numbers[ObjectIdentifier(list)] = number
            let ordered = list.markerFormat != .disc && list.markerFormat != .circle && list.markerFormat != .square && list.markerFormat != .hyphen
            items.append((range.location, ordered ? "  \(number).  " : "  •  "))
        }
        for item in items.reversed() {
            var attributes = text.attributes(at: item.location, effectiveRange: nil)
            attributes[.link] = nil
            text.insert(NSAttributedString(string: item.marker, attributes: attributes), at: item.location)
        }
    }

    private static func attributedFromSanitizedHTML(_ sanitized: String) -> AttributedString? {
        let wrapped = "<span style=\"font-family: -apple-system; font-size: 16px;\">\(sanitized)</span>"
        guard let data = wrapped.data(using: .utf8) else { return nil }
        let options: [NSAttributedString.DocumentReadingOptionKey: Any] = [
            .documentType: NSAttributedString.DocumentType.html,
            .characterEncoding: String.Encoding.utf8.rawValue,
        ]
        guard let ns = try? NSAttributedString(data: data, options: options, documentAttributes: nil) else { return nil }
        let normalized = NSMutableAttributedString(attributedString: ns)
        insertListMarkers(into: normalized)
        normalized.removeAttribute(.paragraphStyle, range: NSRange(location: 0, length: normalized.length))
        // Without paragraph styles, the importer's tab-indented list markers
        // would sit at arbitrary tab stops; give them fixed spacing instead.
        for match in listMarker.matches(in: normalized.string, range: NSRange(location: 0, length: normalized.length)).reversed() {
            let marker = (normalized.string as NSString).substring(with: match.range(at: 1))
            normalized.replaceCharacters(in: match.range, with: marker == "•" ? "  •  " : "  \(marker).  ")
        }
        return try? AttributedString(normalized, including: \.uiKit)
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
            if traits.contains(.traitMonoSpace) {
                out[range].swiftUI.font = .callout.monospaced()
                out[range].swiftUI.backgroundColor = Color.primary.opacity(0.09)
            } else if traits.contains(.traitBold) && traits.contains(.traitItalic) {
                out[range].swiftUI.font = boldItalicFont
            } else if traits.contains(.traitBold) {
                out[range].swiftUI.font = .body.bold()
            } else if traits.contains(.traitItalic) {
                out[range].swiftUI.font = italicFont
            }
            if let link = run.link, !HTMLSanitizer.isSafeLink(link) {
                out[range].link = nil
            } else if run.link != nil {
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
        guard let regex = try? NSRegularExpression(pattern: "<img[^<>]*?src=[\"']data:image/[a-zA-Z]++;base64,([^\"'<>]++)[\"'][^<>]*+>", options: .caseInsensitive) else { return ([], 0) }
        let nsHTML = html as NSString
        var matches: [NSTextCheckingResult] = []
        regex.enumerateMatches(in: html, range: NSRange(location: 0, length: nsHTML.length)) { match, _, stop in
            if let match { matches.append(match) }
            if matches.count == 8 { stop.pointee = true }
        }
        let images: [UIImage] = matches.compactMap { match in
            guard match.numberOfRanges > 1 else { return nil }
            var base64 = nsHTML.substring(with: match.range(at: 1))
            guard base64.utf8.count < 3 * 1024 * 1024 else { return nil }
            if base64.contains("%"), let decoded = base64.removingPercentEncoding { base64 = decoded }
            guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else { return nil }
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: 1280,
                  ] as CFDictionary) else { return nil }
            return UIImage(cgImage: image)
        }
        return (images, matches.count - images.count)
    }

    private static func stripImages(from html: String) -> String {
        html.replacingOccurrences(of: "<img[^<>]*+>", with: "", options: [.regularExpression, .caseInsensitive])
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
        return detector.matches(in: text, range: NSRange(location: 0, length: nsText.length)).compactMap { $0.url }.filter(HTMLSanitizer.isSafeLink)
    }
}
