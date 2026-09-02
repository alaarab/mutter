import SwiftUI
import MumbleClient

// MARK: - Avatar

struct Avatar: View {
    var name: String
    var texture: Data?
    var size: CGFloat = 36
    var color: Color?
    var rounded = false

    private var initials: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first }.map { String($0).uppercased() }
        return letters.isEmpty ? "?" : letters.joined()
    }

    var body: some View {
        ZStack {
            if let texture, let image = UIImage(data: texture) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                (color ?? Theme.color(for: name))
                Text(initials)
                    .font(.system(size: size * 0.38, weight: .semibold, design: .rounded))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
        .clipShape(rounded ? AnyShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)) : AnyShape(Circle()))
    }
}

/// Avatar with the speaking ring and status badges used throughout the channel tree.
struct UserAvatar: View {
    var user: User
    var size: CGFloat = 36

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Avatar(name: user.name, texture: user.texture, size: size)
                .overlay(
                    Circle()
                        .strokeBorder(ringColor, lineWidth: user.isTalking ? 2.5 : 0)
                        .padding(-3)
                )
                .animation(.easeOut(duration: 0.12), value: user.isTalking)
            if let badge = badgeSymbol {
                Image(systemName: badge.0)
                    .font(.system(size: size * 0.3, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(3)
                    .background(badge.1, in: Circle())
                    .overlay(Circle().strokeBorder(Theme.background, lineWidth: 1.5))
                    .offset(x: 3, y: 3)
            }
        }
    }

    private var ringColor: Color {
        switch user.talkingContext {
        case .whisper, .shout: return Theme.whisper
        default: return Theme.speaking
        }
    }

    private var badgeSymbol: (String, Color)? {
        if user.isSelfDeafened || user.isDeafened { return ("speaker.slash.fill", user.isDeafened ? Theme.danger : Theme.muted) }
        if user.isSelfMuted || user.isMuted || user.isSuppressed { return ("mic.slash.fill", user.isMuted ? Theme.danger : Theme.muted) }
        if user.isLocallyMuted { return ("ear.trianglebadge.exclamationmark", Theme.warning) }
        return nil
    }
}

// MARK: - Small pieces

struct StatusDot: View {
    var color: Color
    var pulsing = false
    @State private var on = false
    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .scaleEffect(pulsing && on ? 1.25 : 1)
            .opacity(pulsing && on ? 0.7 : 1)
            .onAppear {
                guard pulsing else { return }
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { on = true }
            }
    }
}

struct Pill: View {
    var text: String
    var symbol: String?
    var color: Color = Theme.muted
    var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).font(.system(size: 10, weight: .bold)) }
            Text(text).font(.caption.weight(.semibold))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: Capsule())
    }
}

struct SectionLabel: View {
    var text: String
    var body: some View {
        Text(text.uppercased())
            .font(.caption.weight(.bold))
            .tracking(0.8)
            .foregroundStyle(Theme.muted)
    }
}

struct EmptyState: View {
    var symbol: String
    var title: String
    var message: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(Theme.muted)
            Text(title).font(.displayHeadline).foregroundStyle(Theme.ink)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
        }
        .padding(28)
        .frame(maxWidth: .infinity)
    }
}

/// Live input level bar. `level` in dB (-80...0), `threshold` marks the gate.
struct LevelMeter: View {
    var level: Float
    var threshold: Float?
    var active = false

    private func fraction(_ db: Float) -> CGFloat {
        CGFloat(max(0, min(1, (db + 60) / 60)))
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.separator)
                Capsule()
                    .fill(active ? Theme.speaking : Theme.muted.opacity(0.6))
                    .frame(width: geo.size.width * fraction(level))
                    .animation(.linear(duration: 0.05), value: level)
                if let threshold {
                    Rectangle()
                        .fill(Theme.accent)
                        .frame(width: 2)
                        .offset(x: geo.size.width * fraction(threshold))
                }
            }
        }
        .frame(height: 6)
    }
}

struct ToastView: View {
    var notice: SessionNotice
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(color)
            Text(notice.text)
                .font(.subheadline)
                .foregroundStyle(Theme.ink)
                .lineLimit(2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Theme.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.separator, lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .padding(.horizontal, 16)
    }

    private var symbol: String {
        switch notice {
        case .userJoined: return "person.badge.plus"
        case .userLeft: return "person.badge.minus"
        case .userMoved: return "arrow.right.circle"
        case .permissionDenied: return "hand.raised"
        case .textMessage: return "bubble.left"
        case .disconnected: return "bolt.slash"
        case .connected: return "bolt"
        case .info: return "info.circle"
        }
    }

    private var color: Color {
        switch notice {
        case .permissionDenied, .disconnected: return Theme.danger
        case .userJoined, .connected: return Theme.speaking
        default: return Theme.muted
        }
    }
}

struct RoundIconButton: View {
    var symbol: String
    var label: String
    var active = false
    var activeColor: Color = Theme.accent
    var size: CGFloat = 46
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size * 0.4, weight: .semibold))
                .frame(width: size, height: size)
                .foregroundStyle(active ? .white : Theme.ink)
                .background(active ? activeColor : Theme.surfaceElevated, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
