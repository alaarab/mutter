import ActivityKit
import WidgetKit
import SwiftUI
import AppIntents

/// Lock screen banner and Dynamic Island for a live voice session:
/// server, channel, who is speaking, and mute / talk buttons that work without unlocking.
struct VoiceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceActivityAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(Color(hex: 0x181715))
                .activitySystemActionForegroundColor(Color(hex: 0xFAF9F5))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.serverName)
                            .font(.custom(BrandFont.display, size: 15).weight(.bold))
                            .lineLimit(1)
                        Text("# \(context.state.channelName)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 8) {
                        MuteButton(state: context.state)
                        TalkButton(state: context.state)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    SpeakersLine(state: context.state)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: context.state.speakers.isEmpty ? "waveform" : "waveform.circle.fill")
                    .foregroundStyle(context.state.speakers.isEmpty ? Color(hex: 0x9A968D) : Color(hex: 0x5DB872))
                    .symbolEffect(.variableColor.iterative, isActive: !context.state.speakers.isEmpty)
            } compactTrailing: {
                if context.state.isMuted {
                    Image(systemName: "mic.slash.fill").foregroundStyle(Color(hex: 0xC64545))
                } else if let first = context.state.speakers.first {
                    Text(first).font(.caption2.weight(.semibold)).lineLimit(1).foregroundStyle(Color(hex: 0x5DB872))
                } else {
                    Text("\(context.state.onlineCount)").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                }
            } minimal: {
                Image(systemName: context.state.isMuted ? "mic.slash.fill" : "waveform")
                    .foregroundStyle(context.state.isMuted ? Color(hex: 0xC64545) : Color(hex: 0x5DB872))
            }
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<VoiceActivityAttributes>

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(Color(hex: 0xCC785C).opacity(0.18))
                Image(systemName: context.state.speakers.isEmpty ? "waveform" : "waveform.circle.fill")
                    .font(.icon(20, .semibold))
                    .foregroundStyle(context.state.speakers.isEmpty ? Color(hex: 0xCC785C) : Color(hex: 0x5DB872))
                    .symbolEffect(.variableColor.iterative, isActive: !context.state.speakers.isEmpty)
            }
            .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 3) {
                Text(context.attributes.serverName)
                    .font(.custom(BrandFont.display, size: 16).weight(.bold))
                    .foregroundStyle(Color(hex: 0xFAF9F5))
                    .lineLimit(1)
                Text("# \(context.state.channelName) · \(context.state.onlineCount) online")
                    .font(.caption)
                    .foregroundStyle(Color(hex: 0x9A968D))
                    .lineLimit(1)
                SpeakersLine(state: context.state)
            }
            Spacer(minLength: 6)
            MuteButton(state: context.state)
            TalkButton(state: context.state)
        }
        .padding(14)
    }
}

private struct SpeakersLine: View {
    let state: VoiceActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 6) {
            if state.isDeafened {
                Label("Deafened", systemImage: "speaker.slash.fill").foregroundStyle(Color(hex: 0xC64545))
            } else if state.isTransmitting {
                Label(state.isWhispering ? "You're whispering" : "You're talking", systemImage: "mic.fill").foregroundStyle(Color(hex: 0x5DB872))
            } else if state.speakers.isEmpty {
                Text(state.isMuted ? "You're muted" : "Quiet right now").foregroundStyle(Color(hex: 0x9A968D))
            } else {
                Image(systemName: "person.wave.2.fill").foregroundStyle(Color(hex: 0x5DB872))
                Text(state.speakers.joined(separator: ", ")).foregroundStyle(Color(hex: 0x5DB872)).lineLimit(1)
            }
        }
        .font(.caption.weight(.medium))
    }
}

private struct MuteButton: View {
    let state: VoiceActivityAttributes.ContentState

    var body: some View {
        Button(intent: ToggleMuteIntent()) {
            Image(systemName: state.isMuted ? "mic.slash.fill" : "mic.fill")
                .font(.icon(16, .semibold))
                .frame(width: 40, height: 40)
                .foregroundStyle(state.isMuted ? Color.white : Color(hex: 0xFAF9F5))
                .background(state.isMuted ? Color(hex: 0xC64545) : Color(hex: 0x2E2B27), in: Circle())
        }
        .buttonStyle(.plain)
    }
}

private struct TalkButton: View {
    let state: VoiceActivityAttributes.ContentState

    var body: some View {
        Button(intent: ToggleTalkIntent()) {
            Image(systemName: state.isPushToTalk ? "hand.tap.fill" : "waveform")
                .font(.icon(16, .semibold))
                .frame(width: 40, height: 40)
                .foregroundStyle(state.isTransmitting ? Color.white : Color(hex: 0xFAF9F5))
                .background(state.isTransmitting ? Color(hex: 0x5DB872) : Color(hex: 0x2E2B27), in: Circle())
        }
        .buttonStyle(.plain)
    }
}
