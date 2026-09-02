import SwiftUI
import AVFoundation
import MumbleClient

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var settings = model.settings
        NavigationStack {
            Form {
                Section {
                    NavigationLink { AudioSettingsView() } label: {
                        Label {
                            VStack(alignment: .leading) {
                                Text("Voice & audio")
                                Text("\(settings.transmitMode.title) · \(settings.bitrate / 1000) kbit/s")
                                    .font(.caption).foregroundStyle(Theme.muted)
                            }
                        } icon: { Image(systemName: "waveform") }
                    }
                    NavigationLink { IdentitiesView() } label: {
                        Label {
                            VStack(alignment: .leading) {
                                Text("Certificates")
                                Text(model.identities.isEmpty ? "None yet" : "\(model.identities.count) identit\(model.identities.count == 1 ? "y" : "ies")")
                                    .font(.caption).foregroundStyle(Theme.muted)
                            }
                        } icon: { Image(systemName: "person.badge.key") }
                    }
                }

                Section {
                    TextField("Default username", text: $settings.defaultUsername)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: { SectionLabel(text: "Identity") } footer: {
                    Text("Used for quick connect and new servers.")
                }

                Section {
                    Picker("Appearance", selection: $settings.appearance) {
                        ForEach(Appearance.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    ThemePickerRow(selection: $settings.theme)
                } header: { SectionLabel(text: "Appearance") } footer: {
                    Text("Themes recolor the whole app.")
                }

                Section {
                    Toggle("Notify me about messages", isOn: $settings.notifyOnMessage)
                    Toggle("Show join and leave notices", isOn: $settings.showPresenceNotices)
                    Toggle("Hide empty channels", isOn: $settings.hideEmptyChannels)
                    Toggle("Haptic when voice activates", isOn: $settings.hapticsOnTransmit)
                    Toggle("Keep screen awake while connected", isOn: $settings.keepScreenAwake)
                } header: { SectionLabel(text: "Behaviour") }

                Section {
                    Picker("Headset button", selection: $settings.headsetButtonAction) {
                        ForEach(HeadsetAction.allCases) { Text($0.title).tag($0) }
                    }
                } header: { SectionLabel(text: "Lock screen & buttons") } footer: {
                    Text("While connected, the lock screen and Dynamic Island show who's speaking with mute and talk buttons. The play/pause button on AirPods and headsets runs the action above. Add “Push to talk” or “Toggle mute” from Mutter to the Action button or a Shortcut in the Shortcuts app; Siri understands “Push to talk in Mutter” and “Connect to <server> in Mutter”.")
                }

                Section {
                    NavigationLink { DiagnosticsView() } label: {
                        Label("Diagnostics", systemImage: "stethoscope")
                    }
                } footer: {
                    Text("Connection and audio events from this run, for tracking down disconnects. Actual crash reports live in the iPhone's Settings → Privacy & Security → Analytics & Improvements → Analytics Data, under “Mutter”.")
                }

                Section {
                    LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "")
                    LabeledContent("Protocol", value: "Mumble 1.5 (works with 1.2+ servers)")
                    Link(destination: URL(string: "https://www.mumble.info")!) {
                        Label("About Mumble", systemImage: "arrow.up.right.square")
                    }
                } header: { SectionLabel(text: "About") } footer: {
                    Text("Mutter is an independent Mumble client. Voice is encrypted end-to-server with OCB2-AES128 and the control channel uses TLS.")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// Swatch row for picking the app theme: a circle per theme in its accent color on its
/// dark background, ringed when selected.
struct ThemePickerRow: View {
    @Binding var selection: ThemeStyle

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Theme")
            HStack(spacing: 14) {
                ForEach(ThemeStyle.allCases) { style in
                    let p = style.palette
                    Button {
                        selection = style
                    } label: {
                        VStack(spacing: 5) {
                            ZStack {
                                Circle().fill(Color(hex: p.background.dark))
                                Circle().fill(Color(hex: p.accent)).padding(9)
                            }
                            .frame(width: 40, height: 40)
                            .overlay(
                                Circle().strokeBorder(
                                    selection == style ? Color(hex: p.accent) : Theme.separator,
                                    lineWidth: selection == style ? 2.5 : 1
                                )
                            )
                            Text(style.title)
                                .font(.caption2.weight(selection == style ? .semibold : .regular))
                                .foregroundStyle(selection == style ? Theme.ink : Theme.muted)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(.vertical, 4)
    }
}

struct AudioSettingsView: View {
    @Environment(AppModel.self) private var model

    private let bitrates = [16_000, 24_000, 32_000, 40_000, 48_000, 64_000, 96_000]
    private let frameSizes = [10, 20, 40, 60]

    var body: some View {
        @Bindable var settings = model.settings
        Form {
            Section {
                Picker("Transmit", selection: $settings.transmitMode) {
                    ForEach(TransmitMode.allCases) { Label($0.title, systemImage: $0.symbol).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            } header: { SectionLabel(text: "How you talk") } footer: {
                Text(transmitFooter)
            }

            if settings.transmitMode == .pushToTalk {
                Section {
                    Picker("Button", selection: $settings.pushToTalkStyle) {
                        ForEach(PushToTalkStyle.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: { SectionLabel(text: "Push to talk") }
            }

            if settings.transmitMode == .voiceActivity {
                Section {
                    Toggle("Automatic sensitivity", isOn: $settings.autoSensitivity)
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text(settings.autoSensitivity ? "Threshold (auto)" : "Sensitivity")
                            Spacer()
                            Text("\(Int(settings.autoSensitivity ? model.audio.effectiveThresholdDb : settings.vadThresholdDb)) dB").foregroundStyle(Theme.muted)
                        }
                        if !settings.autoSensitivity {
                            Slider(value: $settings.vadThresholdDb, in: -60 ... -15, step: 1)
                        }
                        LevelMeter(level: model.audio.inputLevelDb, threshold: settings.autoSensitivity ? model.audio.effectiveThresholdDb : settings.vadThresholdDb, active: model.audio.isTransmitting)
                        if model.audio.isRunning {
                            Text(settings.autoSensitivity
                                 ? "Room noise is about \(Int(model.audio.noiseFloorDb)) dB; the gate opens 12 dB above it and follows the room as it changes."
                                 : "Speak normally: the bar should pass the marker when you talk and stay below it when you're quiet.")
                                .font(.caption)
                                .foregroundStyle(Theme.muted)
                        } else {
                            Text("Connect to a server to see your live level here.")
                                .font(.caption)
                                .foregroundStyle(Theme.muted)
                        }
                    }
                } header: { SectionLabel(text: "Voice activity") }
            }

            Section {
                Picker("Noise suppression", selection: $settings.noiseSuppression) {
                    ForEach(NoiseSuppressor.Level.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                Toggle("Echo cancellation & auto gain", isOn: $settings.voiceProcessing)
                MicrophoneModeRow()
            } header: { SectionLabel(text: "Noise & echo") } footer: {
                Text("Noise suppression removes hiss, fans and hum before your voice is sent. Echo cancellation uses Apple's voice processing, which also unlocks the system Voice Isolation mic mode: the same machine-learning isolation FaceTime uses, and the closest thing on iOS to Discord's Krisp.")
            }

            Section {
                Picker("Quality", selection: $settings.bitrate) {
                    ForEach(bitrates, id: \.self) { Text("\($0 / 1000) kbit/s").tag($0) }
                }
                Picker("Audio per packet", selection: $settings.frameMilliseconds) {
                    ForEach(frameSizes, id: \.self) { Text("\($0) ms").tag($0) }
                }
            } header: { SectionLabel(text: "Quality") } footer: {
                Text("Higher quality uses more data. Longer packets cost a little latency but survive bad Wi‑Fi better. 40 kbit/s at 20 ms is a good default.")
            }

            Section {
                Picker("Audio output", selection: $settings.audioRoute) {
                    ForEach(AudioRoute.allCases) { Label($0.title, systemImage: $0.symbol).tag($0) }
                }
            } header: { SectionLabel(text: "Output") } footer: {
                Text("Phone plays through the earpiece you hold to your ear; Speaker is the loudspeaker. Both always use the phone itself. Bluetooth routes to your headset or AirPods when one is connected. You can also switch from the voice bar during a call.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("Voice & audio")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: settings.transmitMode) { _, _ in model.applyAudioSettings() }
        .onChange(of: settings.vadThresholdDb) { _, _ in model.applyAudioSettings() }
        .onChange(of: settings.bitrate) { _, _ in model.applyAudioSettings() }
        .onChange(of: settings.frameMilliseconds) { _, _ in model.applyAudioSettings() }
        .onChange(of: settings.audioRoute) { _, _ in model.applyAudioSettings() }
        .onChange(of: settings.noiseSuppression) { _, _ in model.applyAudioSettings() }
        .onChange(of: settings.voiceProcessing) { _, _ in model.applyAudioSettings() }
        .onChange(of: settings.autoSensitivity) { _, _ in model.applyAudioSettings() }
    }

    private var transmitFooter: String {
        switch model.settings.transmitMode {
        case .pushToTalk: return "Nothing is sent until you press the talk button. Best in noisy places."
        case .voiceActivity: return "Mutter opens the mic when it hears you speak. Tune the sensitivity below."
        case .continuous: return "Your mic is always live. Use with a headset."
        }
    }
}

/// Shows the system microphone mode (Standard / Voice Isolation / Wide Spectrum) and opens
/// the Control Centre picker for it. Voice Isolation is only offered while a voice-processing
/// audio session is active, i.e. while connected with echo cancellation on.
struct MicrophoneModeRow: View {
    @Environment(AppModel.self) private var model
    @State private var mode = AVCaptureDevice.activeMicrophoneMode

    private var modeName: String {
        switch mode {
        case .voiceIsolation: return "Voice Isolation"
        case .wideSpectrum: return "Wide Spectrum"
        default: return "Standard"
        }
    }

    var body: some View {
        Button {
            AVCaptureDevice.showSystemUserInterface(.microphoneModes)
        } label: {
            HStack {
                Text("Microphone mode").foregroundStyle(Theme.ink)
                Spacer()
                Text(modeName).foregroundStyle(Theme.muted)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            }
        }
        .disabled(!model.audio.isRunning)
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { _ in
            mode = AVCaptureDevice.activeMicrophoneMode
        }
    }
}
