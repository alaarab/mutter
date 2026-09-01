import SwiftUI
import MumbleClient

/// Persistent voice controls shown above the tab strip while connected.
struct VoiceBar: View {
    @Environment(AppModel.self) private var model
    @State private var showTargets = false

    private var session: ServerSession { model.session }
    private var audio: AudioEngine { model.audio }

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Image(systemName: "number").font(.caption.weight(.bold)).foregroundStyle(Theme.coral)
                        Text(session.myChannel?.name ?? "—")
                            .font(.label)
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                    }
                    HStack(spacing: -6) {
                        ForEach(session.talkingUsers.prefix(5)) { u in
                            Avatar(name: u.name, texture: u.texture, size: 18)
                                .overlay(Circle().strokeBorder(Theme.surface, lineWidth: 1.5))
                        }
                        if session.talkingUsers.isEmpty {
                            Text(statusLine)
                                .font(.caption2)
                                .foregroundStyle(audio.isTransmitting ? Theme.speaking : Theme.muted)
                        } else {
                            Text(" \(session.talkingUsers.map { $0.name }.joined(separator: ", "))")
                                .font(.caption2)
                                .foregroundStyle(Theme.speaking)
                                .lineLimit(1)
                                .padding(.leading, 8)
                        }
                    }
                }
                Spacer(minLength: 4)

                RoundIconButton(
                    symbol: model.isMuted ? "mic.slash.fill" : "mic.fill",
                    label: model.isMuted ? "Unmute" : "Mute",
                    active: model.isMuted,
                    activeColor: Theme.danger,
                    size: 42
                ) { model.toggleMute() }
                .overlay(
                    Circle()
                        .strokeBorder(Theme.speaking, lineWidth: 2.5)
                        .opacity(audio.isTransmitting && !model.isMuted ? 1 : 0)
                        .animation(.easeOut(duration: 0.15), value: audio.isTransmitting)
                )

                RoundIconButton(
                    symbol: model.isDeafened ? "speaker.slash.fill" : "speaker.wave.2.fill",
                    label: model.isDeafened ? "Undeafen" : "Deafen",
                    active: model.isDeafened,
                    activeColor: Theme.danger,
                    size: 42
                ) { model.toggleDeafen() }

                RoundIconButton(
                    symbol: model.settings.speakerphone ? "speaker.wave.3.fill" : "iphone.gen3",
                    label: model.settings.speakerphone ? "Switch to earpiece" : "Switch to speaker",
                    active: false,
                    size: 42
                ) {
                    model.settings.speakerphone.toggle()
                    audio.useSpeaker = model.settings.speakerphone
                }

                Menu {
                    Picker("Transmit", selection: Binding(
                        get: { model.settings.transmitMode },
                        set: { model.settings.transmitMode = $0; audio.transmitMode = $0 }
                    )) {
                        ForEach(TransmitMode.allCases) { m in Label(m.title, systemImage: m.symbol).tag(m) }
                    }
                    Button { showTargets = true } label: {
                        Label(model.whisperTarget == nil ? "Whisper or shout…" : "Whisper target: \(model.whisperTarget!.title(in: session))", systemImage: "person.wave.2")
                    }
                    if model.whisperTarget != nil && model.settings.transmitMode != .pushToTalk {
                        Toggle(isOn: Binding(get: { model.isWhisperMode }, set: { model.isWhisperMode = $0 })) {
                            Label("Whisper mode", systemImage: "waveform.badge.mic")
                        }
                    }
                    Button(role: .destructive) { model.disconnect() } label: { Label("Disconnect", systemImage: "phone.down.fill") }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(width: 42, height: 42)
                        .foregroundStyle(Theme.ink)
                        .background(Theme.surfaceElevated, in: Circle())
                }
            }

            if model.settings.transmitMode == .pushToTalk {
                HStack(spacing: 8) {
                    PushToTalkButton()
                    if model.whisperTarget != nil { WhisperHoldButton() }
                }
            } else {
                if model.settings.transmitMode == .voiceActivity {
                    LevelMeter(level: audio.inputLevelDb, threshold: model.settings.vadThresholdDb, active: audio.isTransmitting)
                        .padding(.horizontal, 2)
                }
                if model.whisperTarget != nil && !model.isWhisperMode { WhisperHoldButton() }
            }
            if model.isWhisperingNow, let target = model.whisperTarget {
                Label("Whispering to \(target.title(in: session))", systemImage: "person.wave.2.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.whisper)
            }
            if let error = audio.lastError {
                Text(error).font(.caption2).foregroundStyle(Theme.danger)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .sheet(isPresented: $showTargets) { VoiceTargetsSheet() }
    }

    private var statusLine: String {
        if model.isDeafened { return "Deafened" }
        if model.isMuted { return "Muted" }
        if audio.isTransmitting { return "Transmitting" }
        switch model.settings.transmitMode {
        case .pushToTalk: return "Hold the button to talk"
        case .voiceActivity: return "Listening for your voice"
        case .continuous: return "Always transmitting"
        }
    }
}

/// Hold to send your voice to the whisper/shout target instead of the channel.
struct WhisperHoldButton: View {
    @Environment(AppModel.self) private var model
    @State private var pressed = false

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "person.wave.2.fill").font(.system(size: 15, weight: .semibold))
            Text(model.isWhisperHeld ? "Whispering" : "Whisper").font(.system(.subheadline, weight: .semibold))
        }
        .foregroundStyle(model.isWhisperHeld ? .white : Theme.whisper)
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(model.isWhisperHeld ? Theme.whisper : Theme.whisper.opacity(0.14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !pressed {
                        pressed = true
                        model.setWhisperHeld(true)
                        UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                    }
                }
                .onEnded { _ in
                    pressed = false
                    model.setWhisperHeld(false)
                }
        )
        .accessibilityLabel("Hold to whisper")
    }
}

struct PushToTalkButton: View {
    @Environment(AppModel.self) private var model
    @State private var pressed = false

    private var isOn: Bool { model.audio.isPushToTalkPressed }

    var body: some View {
        let toggle = model.settings.pushToTalkStyle == .toggle
        Group {
            if toggle {
                Button {
                    model.audio.isPushToTalkPressed.toggle()
                    UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                } label: { label }
                .buttonStyle(.plain)
            } else {
                label
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { _ in
                                if !pressed {
                                    pressed = true
                                    model.audio.isPushToTalkPressed = true
                                    UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                                }
                            }
                            .onEnded { _ in
                                pressed = false
                                model.audio.isPushToTalkPressed = false
                            }
                    )
            }
        }
        .accessibilityLabel(toggle ? "Toggle talking" : "Hold to talk")
    }

    private var label: some View {
        HStack(spacing: 8) {
            Image(systemName: isOn ? "waveform" : "hand.tap.fill")
                .font(.system(size: 16, weight: .semibold))
            Text(isOn ? "Talking" : (model.settings.pushToTalkStyle == .toggle ? "Tap to talk" : "Hold to talk"))
                .font(.system(.subheadline, weight: .semibold))
        }
        .foregroundStyle(isOn ? .white : Theme.ink)
        .frame(maxWidth: .infinity)
        .frame(height: 48)
        .background(isOn ? Theme.speaking : Theme.surfaceElevated, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .animation(.easeOut(duration: 0.1), value: isOn)
    }
}
