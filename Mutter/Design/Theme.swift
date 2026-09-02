import SwiftUI
import UIKit

/// A complete color scheme. Every token has a light and dark variant; the accent pair is shared.
struct ThemePalette {
    var accent: UInt32
    var accentActive: UInt32
    var background, surface, surfaceElevated, surfaceSunken, separator: (light: UInt32, dark: UInt32)
    var ink, body, muted: (light: UInt32, dark: UInt32)
}

enum ThemeStyle: String, CaseIterable, Codable, Identifiable {
    case midnight
    case paper
    case emerald
    case violet
    case amber

    var id: String { rawValue }

    var title: String {
        switch self {
        case .midnight: return "Midnight"
        case .paper: return "Paper"
        case .emerald: return "Emerald"
        case .violet: return "Violet"
        case .amber: return "Amber"
        }
    }

    var palette: ThemePalette {
        switch self {
        case .midnight: return ThemePalette(
            accent: 0x5B9DD9, accentActive: 0x3D7DB8,
            background: (0xF5F7FA, 0x10141B), surface: (0xFFFFFF, 0x1A2029),
            surfaceElevated: (0xE7ECF2, 0x232B36), surfaceSunken: (0xEDF0F5, 0x0C0F15),
            separator: (0xD9E0E8, 0x2E3742),
            ink: (0x10151C, 0xEDF1F6), body: (0x39424E, 0xC9D2DD), muted: (0x66707D, 0x8794A3))
        case .paper: return ThemePalette(
            accent: 0xCC785C, accentActive: 0xA9583E,
            background: (0xFAF9F5, 0x181715), surface: (0xFFFFFF, 0x252320),
            surfaceElevated: (0xEFE9DE, 0x2E2B27), surfaceSunken: (0xF2EFE8, 0x1F1D1A),
            separator: (0xE6DFD8, 0x3A3733),
            ink: (0x141413, 0xFAF9F5), body: (0x3D3D3A, 0xD9D5CC), muted: (0x6C6A64, 0x9A968D))
        case .emerald: return ThemePalette(
            accent: 0x34C77B, accentActive: 0x219960,
            background: (0xF4F7F4, 0x121412), surface: (0xFFFFFF, 0x1B1F1B),
            surfaceElevated: (0xE6EEE7, 0x242A24), surfaceSunken: (0xECF1EC, 0x0E100E),
            separator: (0xD8E2D9, 0x2E362E),
            ink: (0x121712, 0xF2F4F1), body: (0x3A443B, 0xD3DAD2), muted: (0x687468, 0x93A093))
        case .violet: return ThemePalette(
            accent: 0x8B7CF6, accentActive: 0x6D5BD0,
            background: (0xF6F5FA, 0x131218), surface: (0xFFFFFF, 0x1C1A24),
            surfaceElevated: (0xEAE7F2, 0x262330), surfaceSunken: (0xEFEDF5, 0x0E0D13),
            separator: (0xDDD9E8, 0x322E40),
            ink: (0x141218, 0xF1F0F5), body: (0x3E3A4A, 0xD5D2DE), muted: (0x6E6980, 0x9994A8))
        case .amber: return ThemePalette(
            accent: 0xE8A33D, accentActive: 0xC4841F,
            background: (0xFAF8F2, 0x0C0C0C), surface: (0xFFFFFF, 0x171614),
            surfaceElevated: (0xF0EBDF, 0x22201C), surfaceSunken: (0xF4F0E7, 0x080808),
            separator: (0xE4DDCE, 0x2E2B26),
            ink: (0x161410, 0xF5F2EA), body: (0x44403A, 0xDAD5C8), muted: (0x746E63, 0x9C9689))
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

    // Semantic (shared across themes)
    static let speaking = Color(hex: 0x5DB872)
    static let warning = Color(hex: 0xD4A017)
    static let danger = Color(hex: 0xC64545)
    static let whisper = Color(hex: 0x7B8CDE)

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
    static let palette: [Color] = [
        Color(hex: 0xCC785C), Color(hex: 0x5DB872), Color(hex: 0x7B8CDE), Color(hex: 0xD4A017),
        Color(hex: 0xB86A9E), Color(hex: 0x4FA3A5), Color(hex: 0xC64545), Color(hex: 0x8A7A5A),
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

extension Font {
    /// Serif display face for names and headings (New York on iOS).
    static func display(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
    static let displayTitle = Font.system(.title, design: .serif).weight(.medium)
    static let displayHeadline = Font.system(.title3, design: .serif).weight(.medium)
    static let label = Font.system(.subheadline, weight: .medium)
    static let caption = Font.system(.caption, weight: .medium)
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
