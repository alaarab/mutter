import ActivityKit
import WidgetKit
import SwiftUI
import AppIntents

struct VoiceLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: VoiceActivityAttributes.self) { context in
            LockScreenView(context: context)
                .activityBackgroundTint(context.state.color(\.surface))
                .activitySystemActionForegroundColor(context.state.color(\.ink))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.serverName)
                            .font(.custom(BrandFont.display, size: 15).weight(.bold))
                            .lineLimit(1)
                        Text("# \(context.state.channelName)")
                            .font(.caption)
                            .foregroundStyle(context.state.color(\.muted))
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
                    .foregroundStyle(context.state.speakers.isEmpty ? context.state.color(\.muted) : context.state.color(\.speaking))
                    .symbolEffect(.variableColor.iterative, isActive: !context.state.speakers.isEmpty)
            } compactTrailing: {
                if context.state.isMuted {
                    Image(systemName: "mic.slash.fill").foregroundStyle(context.state.color(\.danger))
                } else if let first = context.state.speakers.first {
                    Text(first).font(.caption2.weight(.semibold)).lineLimit(1).foregroundStyle(context.state.color(\.speaking))
                } else {
                    Text("\(context.state.onlineCount)").font(.caption2.weight(.semibold)).foregroundStyle(context.state.color(\.muted))
                }
            } minimal: {
                Image(systemName: context.state.isMuted ? "mic.slash.fill" : "waveform")
                    .foregroundStyle(context.state.isMuted ? context.state.color(\.danger) : context.state.color(\.speaking))
            }
        }
    }
}

private struct LockScreenView: View {
    let context: ActivityViewContext<VoiceActivityAttributes>

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(context.state.color(\.accent).opacity(0.18))
                Image(systemName: context.state.speakers.isEmpty ? "waveform" : "waveform.circle.fill")
                    .font(.icon(20, .semibold))
                    .foregroundStyle(context.state.speakers.isEmpty ? context.state.color(\.accent) : context.state.color(\.speaking))
                    .symbolEffect(.variableColor.iterative, isActive: !context.state.speakers.isEmpty)
            }
            .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: 3) {
                Text(context.attributes.serverName)
                    .font(.custom(BrandFont.display, size: 16).weight(.bold))
                    .foregroundStyle(context.state.color(\.ink))
                    .lineLimit(1)
                Text("# \(context.state.channelName) · \(context.state.onlineCount) online")
                    .font(.caption)
                    .foregroundStyle(context.state.color(\.muted))
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
                Label("Deafened", systemImage: "speaker.slash.fill").foregroundStyle(state.color(\.danger))
            } else if state.isTransmitting {
                Label(state.isWhispering ? "You're whispering" : "You're talking", systemImage: "mic.fill").foregroundStyle(state.color(state.isWhispering ? \.whisper : \.speaking))
            } else if state.speakers.isEmpty {
                Text(state.isMuted ? "You're muted" : "Quiet right now").foregroundStyle(state.color(\.muted))
            } else {
                Image(systemName: "person.wave.2.fill").foregroundStyle(state.color(\.speaking))
                Text(state.speakers.joined(separator: ", ")).foregroundStyle(state.color(\.speaking)).lineLimit(1)
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
                .foregroundStyle(state.isMuted ? state.color(\.onStatus) : state.color(\.ink))
                .background(state.isMuted ? state.color(\.danger) : state.color(\.elevated), in: Circle())
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
                .foregroundStyle(state.isTransmitting ? state.color(\.onStatus) : state.color(\.ink))
                .background(state.isTransmitting ? state.color(\.speaking) : state.color(\.elevated), in: Circle())
        }
        .buttonStyle(.plain)
    }
}

private extension VoiceActivityAttributes.ContentState {
    func color(_ key: KeyPath<ThemeColors, UInt32>) -> Color {
        let style = theme.flatMap(ThemeStyle.init(rawValue:)) ?? .defaultStyle
        return Color(hex: style.palette.dark[keyPath: key])
    }
}
