import SwiftUI
import UIKit

/// A complete color scheme. Every token has a light and dark variant; the accent pair is shared.
struct ThemePalette {
    var accent: UInt32
    var accentActive: UInt32
    var background, surface, surfaceElevated, surfaceSunken, separator: (light: UInt32, dark: UInt32)
    var ink, body, muted: (light: UInt32, dark: UInt32)
}

/// Each theme is a point of view, not a hue swap: a near-black ground tinted toward the
/// accent's temperature, and one vivid accent bright enough to clear 4.5:1 on it.
enum ThemeStyle: String, CaseIterable, Codable, Identifiable {
    case midnight
    case ultra
    case ember
    case orchid
    case mint

    var id: String { rawValue }

    var title: String {
        switch self {
        case .midnight: return "Midnight"
        case .ultra: return "Ultra"
        case .ember: return "Ember"
        case .orchid: return "Orchid"
        case .mint: return "Mint"
        }
    }

    var palette: ThemePalette {
        switch self {
        case .midnight: return ThemePalette(
            accent: 0x3D9BFF, accentActive: 0x1C77DB,
            background: (0xF4F7FC, 0x0B0F17), surface: (0xFFFFFF, 0x151B26),
            surfaceElevated: (0xE6EDF7, 0x1E2633), surfaceSunken: (0xEDF2F9, 0x070A10),
            separator: (0xD7E1EE, 0x232C3A),
            ink: (0x0C1119, 0xEAF1FA), body: (0x37424F, 0xC3CFDE), muted: (0x667487, 0x7C8B9E))
        case .ultra: return ThemePalette(
            accent: 0xA8E831, accentActive: 0x7FB513,
            background: (0xF6F7F2, 0x0B0B0C), surface: (0xFFFFFF, 0x17181A),
            surfaceElevated: (0xEBEDE3, 0x212328), surfaceSunken: (0xF1F2EA, 0x060607),
            separator: (0xDEE0D3, 0x2A2C31),
            ink: (0x101107, 0xF2F3F0), body: (0x3F4237, 0xCBCEC6), muted: (0x6E7266, 0x878B84))
        case .ember: return ThemePalette(
            accent: 0xFF6B35, accentActive: 0xD9481A,
            background: (0xFCF6F2, 0x14100E), surface: (0xFFFFFF, 0x1F1916),
            surfaceElevated: (0xF4E7DE, 0x2B221D), surfaceSunken: (0xF8EFE9, 0x0D0A08),
            separator: (0xEBDACE, 0x362B25),
            ink: (0x1A100A, 0xFBF1EA), body: (0x4A3B32, 0xDCCCC0), muted: (0x8A7566, 0x9C8B7E))
        case .orchid: return ThemePalette(
            accent: 0xC084FC, accentActive: 0x9333EA,
            background: (0xF9F5FE, 0x120E18), surface: (0xFFFFFF, 0x1C1626),
            surfaceElevated: (0xEFE6F9, 0x271E33), surfaceSunken: (0xF4EDFB, 0x0B0810),
            separator: (0xE3D7F2, 0x322845),
            ink: (0x150E1D, 0xF3EDFB), body: (0x413552, 0xD4C8E4), muted: (0x7C6C90, 0x94869F))
        case .mint: return ThemePalette(
            accent: 0x2DD4A7, accentActive: 0x0E9C79,
            background: (0xF2F9F7, 0x08120F), surface: (0xFFFFFF, 0x121D1A),
            surfaceElevated: (0xE2F0EC, 0x1B2724), surfaceSunken: (0xEAF4F1, 0x050C0A),
            separator: (0xD3E6E1, 0x24332F),
            ink: (0x06150F, 0xE9F7F2), body: (0x31463F, 0xC2D6D0), muted: (0x638078, 0x7E948E))
        }
    }
}

/// Design tokens, resolved through the active theme. Set `Theme.style` at launch and on change;
/// the root view re-renders the tree via `.id(theme)`.
enum Theme {
    static var style: ThemeStyle = .midnight
    private static var p: ThemePalette { style.palette }

    // Brand
    static var accent: Color { Color(hex: p.accent) }
    static var accentActive: Color { Color(hex: p.accentActive) }

    // Semantic (shared across themes, tuned to sit at the same brightness as the accents)
    static let speaking = Color(hex: 0x3DDC84)
    static let warning = Color(hex: 0xFFC53D)
    static let danger = Color(hex: 0xFF5A5A)
    static let whisper = Color(hex: 0x9C8CFF)

    // Adaptive surfaces
    static var background: Color { adaptive(p.background) }
    static var surface: Color { adaptive(p.surface) }
    static var surfaceElevated: Color { adaptive(p.surfaceElevated) }
    static var surfaceSunken: Color { adaptive(p.surfaceSunken) }
    static var separator: Color { adaptive(p.separator) }

    // Text
    static var ink: Color { adaptive(p.ink) }
    static var body: Color { adaptive(p.body) }
    static var muted: Color { adaptive(p.muted) }

    // Stable per-server / per-user colours
    /// Avatar/user colours: evenly spaced around the wheel at one saturation and lightness,
    /// so no single person's bubble shouts louder than the rest.
    static let palette: [Color] = [
        Color(hex: 0x3D9BFF), Color(hex: 0x3DDC84), Color(hex: 0xFF6B35), Color(hex: 0xC084FC),
        Color(hex: 0x2DD4A7), Color(hex: 0xFFC53D), Color(hex: 0xFF7AA2), Color(hex: 0xA8E831),
    ]

    static func color(for name: String) -> Color {
        var hash: UInt32 = 5381
        for b in name.utf8 { hash = (hash &* 33) &+ UInt32(b) }
        return palette[Int(hash % UInt32(palette.count))]
    }

    static func color(index: Int) -> Color {
        palette[((index % palette.count) + palette.count) % palette.count]
    }

    // Radii & spacing
    static let radiusSmall: CGFloat = 8
    static let radiusMedium: CGFloat = 12
    static let radiusLarge: CGFloat = 16

    private static func adaptive(_ pair: (light: UInt32, dark: UInt32)) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: pair.dark) : UIColor(hex: pair.light)
        })
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// The two bundled families that carry the brand. Bricolage Display is a custom cut
/// (narrowed to 94%, pinned to a display optical size) so headings have a tighter,
/// more editorial rhythm than any stock weight ships with.
enum BrandFont {
    static let display = "Bricolage Display"
    static let text = "Plus Jakarta Sans"
}

extension Font {
    /// Plus Jakarta Sans — everything the user reads.
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(BrandFont.text, size: size, relativeTo: style).weight(weight)
    }

    /// Bricolage Display — names, headings, anything with a voice.
    static func display(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .custom(BrandFont.display, size: size, relativeTo: .title).weight(weight)
    }

    /// SF Symbols only: their stroke weight is derived from the system font, so icons
    /// keep system metrics while all text uses the brand faces.
    static func icon(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    // The tokens below deliberately shadow SwiftUI's built-ins. Unqualified lookup inside
    // this module prefers ours, so every existing `.font(.caption)` picks up the brand face.
    // Sizes follow a 1.18 ratio rather than +2 steps, so the scale has rhythm.
    static let displayTitle = Font.display(27, weight: .heavy)
    static let displayHeadline = Font.display(20)
    static let headline = Font.ui(17, .semibold, relativeTo: .headline)
    static let body = Font.ui(16, .regular)
    static let label = Font.ui(15, .medium, relativeTo: .subheadline)
    static let subheadline = Font.ui(14, .medium, relativeTo: .subheadline)
    static let footnote = Font.ui(13, .regular, relativeTo: .footnote)
    static let caption = Font.ui(12, .medium, relativeTo: .caption)
    static let caption2 = Font.ui(11, .medium, relativeTo: .caption2)
}

struct CardModifier: ViewModifier {
    var padding: CGFloat = 14
    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.radiusMedium, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMedium, style: .continuous)
                    .strokeBorder(Theme.separator, lineWidth: 1)
            )
    }
}

extension View {
    func card(padding: CGFloat = 14) -> some View { modifier(CardModifier(padding: padding)) }
}
