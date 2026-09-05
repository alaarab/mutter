import SwiftUI
import UIKit

struct ThemePalette {
    var accent: UInt32
    var accentActive: UInt32
    var background, surface, surfaceElevated, surfaceSunken, separator: (light: UInt32, dark: UInt32)
    var ink, body, muted: (light: UInt32, dark: UInt32)
}

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

enum Theme {
    static var style: ThemeStyle = .midnight
    private static var activePalette: ThemePalette { style.palette }

    static var accent: Color { Color(hex: activePalette.accent) }
    static var accentActive: Color { Color(hex: activePalette.accentActive) }

    static let speaking = Color(hex: 0x3DDC84)
    static let warning = Color(hex: 0xFFC53D)
    static let danger = Color(hex: 0xFF5A5A)
    static let whisper = Color(hex: 0x9C8CFF)

    static var background: Color { adaptive(activePalette.background) }
    static var surface: Color { adaptive(activePalette.surface) }
    static var surfaceElevated: Color { adaptive(activePalette.surfaceElevated) }
    static var surfaceSunken: Color { adaptive(activePalette.surfaceSunken) }
    static var separator: Color { adaptive(activePalette.separator) }

    static var ink: Color { adaptive(activePalette.ink) }
    static var body: Color { adaptive(activePalette.body) }
    static var muted: Color { adaptive(activePalette.muted) }

    static let palette: [Color] = [
        Color(hex: 0x3D9BFF), Color(hex: 0x3DDC84), Color(hex: 0xFF6B35), Color(hex: 0xC084FC),
        Color(hex: 0x2DD4A7), Color(hex: 0xFFC53D), Color(hex: 0xFF7AA2), Color(hex: 0xA8E831),
    ]

    static func color(for name: String) -> Color {
        var hash: UInt32 = 5381
        for byte in name.utf8 { hash = (hash &* 33) &+ UInt32(byte) }
        return palette[Int(hash % UInt32(palette.count))]
    }

    static func color(index: Int) -> Color {
        palette[((index % palette.count) + palette.count) % palette.count]
    }

    static func latencyColor(_ milliseconds: Double) -> Color {
        if milliseconds <= 0 { return muted }
        if milliseconds < 90 { return speaking }
        if milliseconds < 200 { return warning }
        return danger
    }

    static let radiusSmall: CGFloat = 8
    static let radiusMedium: CGFloat = 12
    static let radiusLarge: CGFloat = 16

    private static func adaptive(_ pair: (light: UInt32, dark: UInt32)) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: pair.dark) : UIColor(hex: pair.light)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(uiColor: UIColor(hex: hex, alpha: CGFloat(alpha)))
    }
}

enum BrandFont {
    static let display = "Bricolage Display"
    static let text = "Plus Jakarta Sans"
}

extension Font {
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        .custom(BrandFont.text, size: size, relativeTo: style).weight(weight)
    }

    static func display(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .custom(BrandFont.display, size: size, relativeTo: .title).weight(weight)
    }

    static func icon(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

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
