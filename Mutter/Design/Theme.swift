import SwiftUI
import UIKit
import Observation


@Observable
private final class ThemeSelection {
    var style: ThemeStyle = .defaultStyle
}

enum Theme {
    private static let selection = ThemeSelection()
    static var style: ThemeStyle {
        get { selection.style }
        set { selection.style = newValue }
    }

    static func color(_ key: KeyPath<ThemeColors, UInt32>) -> Color {
        let palette = style.palette
        return Color(uiColor: UIColor { traits in
            UIColor(hex: (traits.userInterfaceStyle == .dark ? palette.dark : palette.light)[keyPath: key])
        })
    }

    static var accent: Color { color(\.accent) }
    static var accentActive: Color { color(\.accentActive) }
    static var onAccent: Color { color(\.onAccent) }
    static var ownBubble: Color { color(\.ownBubble) }
    static var onOwnBubble: Color { color(\.onOwnBubble) }
    static var onOwnBubbleMuted: Color { color(\.onOwnBubbleMuted) }
    static var secondary: Color { color(\.secondary) }
    static var speaking: Color { color(\.speaking) }
    static var warning: Color { color(\.warn) }
    static var danger: Color { color(\.danger) }
    static var whisper: Color { color(\.whisper) }
    static var onStatus: Color { color(\.onStatus) }
    static var onAvatar: Color { color(\.onAvatar) }
    static var background: Color { color(\.bg) }
    static var surface: Color { color(\.surface) }
    static var surfaceElevated: Color { color(\.elevated) }
    static var surfaceSunken: Color { color(\.sunken) }
    static var separator: Color { color(\.separator) }
    static var ink: Color { color(\.ink) }
    static var body: Color { color(\.body) }
    static var muted: Color { color(\.muted) }
    static var shadow: Color { color(\.shadow) }

    static var palette: [Color] { (0..<6).map { color(index: $0) } }

    static func color(for name: String) -> Color {
        var hash: UInt32 = 5381
        for byte in name.utf8 { hash = (hash &* 33) &+ UInt32(byte) }
        return color(index: Int(hash % 6))
    }

    static func color(index: Int) -> Color {
        let index = ((index % 6) + 6) % 6
        let palette = style.palette
        return Color(uiColor: UIColor { traits in
            UIColor(hex: (traits.userInterfaceStyle == .dark ? palette.dark : palette.light).avatars[index])
        })
    }

    static func latencyColor(_ milliseconds: Double) -> Color {
        if milliseconds <= 0 { return muted }
        if milliseconds < 90 { return speaking }
        if milliseconds < 200 { return warning }
        return danger
    }

    /// A status colour that stays readable inside a code block on your own
    /// bubble. The bubble is dark in both appearances, so this starts from
    /// the dark palette's colour and moves toward the bubble's text until it
    /// reaches 4.5:1 against the block's shaded fill.
    /// How much a code block darkens your own bubble behind it.
    static let ownCodeShade = 0.18

    static func onOwnBubble(_ key: KeyPath<ThemeColors, UInt32>) -> Color {
        let palette = style.palette
        return Color(uiColor: UIColor { traits in
            let colors = traits.userInterfaceStyle == .dark ? palette.dark : palette.light
            let fill = mix(0x000000, colors.ownBubble, ownCodeShade)
            let start = palette.dark[keyPath: key]
            let readable = (0...20).lazy.map { mix(colors.onOwnBubble, start, Double($0) / 20) }.first { contrast($0, fill) >= 4.5 }
            return UIColor(hex: readable ?? colors.onOwnBubble)
        })
    }

    private static func mix(_ a: UInt32, _ b: UInt32, _ amount: Double) -> UInt32 {
        [16, 8, 0].reduce(0) { result, shift in
            let channel = Double((a >> shift) & 0xFF) * amount + Double((b >> shift) & 0xFF) * (1 - amount)
            return result | (UInt32(channel.rounded()) << shift)
        }
    }

    private static func contrast(_ a: UInt32, _ b: UInt32) -> Double {
        func luminance(_ color: UInt32) -> Double {
            zip([16, 8, 0], [0.2126, 0.7152, 0.0722]).reduce(0) { sum, part in
                let channel = Double((color >> UInt32(part.0)) & 0xFF) / 255
                return sum + part.1 * (channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4))
            }
        }
        let (high, low) = (max(luminance(a), luminance(b)), min(luminance(a), luminance(b)))
        return (high + 0.05) / (low + 0.05)
    }

    static var surfaceGradient: LinearGradient {
        LinearGradient(colors: [color(\.surfaceHighlight), surface], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    static var accentGradient: LinearGradient {
        LinearGradient(colors: [accent, accentActive], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    static var ambientGradient: LinearGradient {
        LinearGradient(colors: [accent.opacity(0.08), .clear, secondary.opacity(0.04)], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
    static let radiusSmall = CGFloat(DesignRadius.small)
    static let radiusMedium = CGFloat(DesignRadius.medium)
    static let radiusLarge = CGFloat(DesignRadius.large)
}

enum ThemeMotion {
    static func animation(_ duration: Double = DesignMotion.standard) -> Animation {
        let curve = DesignMotion.curve
        return .timingCurve(curve[0], curve[1], curve[2], curve[3], duration: duration)
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
            .background(Theme.surfaceGradient, in: RoundedRectangle(cornerRadius: Theme.radiusMedium, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radiusMedium, style: .continuous)
                    .strokeBorder(Theme.separator, lineWidth: 1)
            )
    }
}

extension View {
    func card(padding: CGFloat = 14) -> some View { modifier(CardModifier(padding: padding)) }
}
