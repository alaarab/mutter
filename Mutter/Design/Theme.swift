import SwiftUI
import UIKit

/// Design tokens. Warm, editorial palette (cream "Paper" and warm-black "Ink") with a single
/// coral accent, paired with a Discord-style information structure.
enum Theme {
    // Brand
    static let coral = Color(hex: 0xCC785C)
    static let coralActive = Color(hex: 0xA9583E)
    static let accent = coral

    // Semantic
    static let speaking = Color(hex: 0x5DB872)
    static let warning = Color(hex: 0xD4A017)
    static let danger = Color(hex: 0xC64545)
    static let whisper = Color(hex: 0x7B8CDE)

    // Adaptive surfaces
    static let background = adaptive(light: 0xFAF9F5, dark: 0x181715)
    static let surface = adaptive(light: 0xFFFFFF, dark: 0x252320)
    static let surfaceElevated = adaptive(light: 0xEFE9DE, dark: 0x2E2B27)
    static let surfaceSunken = adaptive(light: 0xF2EFE8, dark: 0x1F1D1A)
    static let separator = adaptive(light: 0xE6DFD8, dark: 0x3A3733)

    // Text
    static let ink = adaptive(light: 0x141413, dark: 0xFAF9F5)
    static let body = adaptive(light: 0x3D3D3A, dark: 0xD9D5CC)
    static let muted = adaptive(light: 0x6C6A64, dark: 0x9A968D)

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

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
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
