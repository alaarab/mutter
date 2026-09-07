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
                .themedRows()

                Section {
                    TextField("Default username", text: $settings.defaultUsername, prompt: Text("Default username").foregroundStyle(Theme.muted))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: { SectionLabel(text: "Identity") } footer: {
                    Text("Used for quick connect and new servers.")
                }
                .themedRows()

                Section {
                    ThemeSegmentedPicker(selection: $settings.appearance, values: Appearance.allCases, title: { $0.title })
                    ThemePickerRow(selection: $settings.theme)
                } header: { SectionLabel(text: "Appearance") } footer: {
                    Text("Themes recolor the whole app.")
                }
                .themedRows()

                Section {
                    Toggle("Notify me about messages", isOn: $settings.notifyOnMessage)
                    Toggle("Show join and leave notices", isOn: $settings.showPresenceNotices)
                    Toggle("Hide empty channels", isOn: $settings.hideEmptyChannels)
                    Toggle("Haptic when voice activates", isOn: $settings.hapticsOnTransmit)
                    Toggle("Keep screen awake while connected", isOn: $settings.keepScreenAwake)
                } header: { SectionLabel(text: "Behaviour") }
                .themedRows()

                Section {
                    Picker("Headset button", selection: $settings.headsetButtonAction) {
                        ForEach(HeadsetAction.allCases) { Text($0.title).tag($0) }
                    }
                } header: { SectionLabel(text: "Lock screen & buttons") } footer: {
                    Text("Sets what the AirPods or headset play/pause button does. Siri and the Action button work too.")
                }
                .themedRows()

                Section {
                    TextField("TURN server", text: $settings.turnURL, prompt: Text("turn:host:3478"))
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    TextField("Username", text: $settings.turnUsername).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $settings.turnPassword)
                } header: { SectionLabel(text: "Screen share") } footer: {
                    Text("Only needed if watching a share fails on a strict network.")
                }
                .themedRows()

                Section {
                    NavigationLink { DiagnosticsView() } label: {
                        Label("Diagnostics", systemImage: "stethoscope")
                    }
                } footer: {
                    Text("A log of connection and audio events, for chasing down disconnects.")
                }
                .themedRows()

                Section {
                    LabeledContent("Version", value: Bundle.main.shortVersion ?? "")
                    LabeledContent("Protocol", value: "Mumble 1.5 (works with 1.2+ servers)")
                    Link(destination: URL(string: "https://www.mumble.info")!) {
                        Label("About Mumble", systemImage: "arrow.up.right.square")
                    }
                } header: { SectionLabel(text: "About") } footer: {
                    Text("An independent Mumble client. Voice and chat are encrypted.")
                }
                .themedRows()
            }
            .themedList()
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .doneToolbar(dismiss)
            .onChange(of: settings.turnPreferences) { _, _ in model.applyShareSettings() }
        }
        .preferredColorScheme(settings.appearance.colorScheme)
    }
}

struct ThemePickerRow: View {
    @Binding var selection: ThemeStyle
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                ForEach(ThemeStyle.allCases) { style in
                    let colors = colorScheme == .dark ? style.palette.dark : style.palette.light
                    Button {
                        withAnimation(reduceMotion ? nil : ThemeMotion.animation(DesignMotion.theme)) {
                            selection = style
                        }
                        Haptics.selection()
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 1) {
                                Color(hex: colors.elevated).frame(width: 9)
                                Color(hex: colors.surface).frame(width: 20)
                                VStack(alignment: .leading, spacing: 4) {
                                    Capsule().fill(Color(hex: colors.accent)).frame(width: 18, height: 3)
                                    Capsule().fill(Color(hex: colors.separator)).frame(height: 3)
                                    Capsule().fill(Color(hex: colors.separator)).frame(width: 25, height: 3)
                                }
                                .padding(6)
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                                .background(Color(hex: colors.bg))
                            }
                            .frame(height: 44)
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                            Text(style.title)
                                .font(.ui(11, .semibold, relativeTo: .caption))
                                .foregroundStyle(selection == style ? Theme.ink : Theme.body)
                                .lineLimit(1)
                                .padding(.horizontal, 3)
                        }
                        .padding(5)
                        .background(Theme.background, in: RoundedRectangle(cornerRadius: Theme.radiusMedium))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radiusMedium)
                            .strokeBorder(selection == style ? Theme.accent : Theme.separator, lineWidth: selection == style ? 2 : 1))
                    }
                    .buttonStyle(ThemePressStyle())
                    .accessibilityLabel(style.title)
                    .accessibilityHint(style.subtitle)
                    .accessibilityAddTraits(selection == style ? .isSelected : [])
                }
            }
            Text(selection.subtitle).font(.footnote).foregroundStyle(Theme.muted)
        }
        .padding(.vertical, 6)
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
            .themedRows()

            if settings.transmitMode == .pushToTalk {
                Section {
                    Picker("Button", selection: $settings.pushToTalkStyle) {
                        ForEach(PushToTalkStyle.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: { SectionLabel(text: "Push to talk") }
                .themedRows()
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
                .themedRows()
            }

            Section {
                Picker("Noise suppression", selection: $settings.noiseSuppression) {
                    ForEach(NoiseSuppressor.Level.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                Toggle("Echo cancellation & auto gain", isOn: $settings.voiceProcessing)
                MicrophoneModeRow()
            } header: { SectionLabel(text: "Noise & echo") } footer: {
                Text("Removes background noise and echo before your voice is sent.")
            }
            .themedRows()

            Section {
                Picker("Quality", selection: $settings.bitrate) {
                    ForEach(bitrates, id: \.self) { Text("\($0 / 1000) kbit/s").tag($0) }
                }
                Picker("Audio per packet", selection: $settings.frameMilliseconds) {
                    ForEach(frameSizes, id: \.self) { Text("\($0) ms").tag($0) }
                }
            } header: { SectionLabel(text: "Quality") } footer: {
                Text("Higher quality uses more data. 40 kbit/s at 20 ms is a good default.")
            }
            .themedRows()

            Section {
                Picker("Audio output", selection: $settings.audioRoute) {
                    ForEach(AudioRoute.allCases) { Label($0.title, systemImage: $0.symbol).tag($0) }
                }
                Toggle("Mix with other apps", isOn: $settings.mixWithOthers)
            } header: { SectionLabel(text: "Output") } footer: {
                Text("Phone is the earpiece; Speaker is the loudspeaker. Mixing lets videos and music play without pausing the call.")
            }
            .themedRows()
        }
        .themedList()
        .navigationTitle("Voice & audio")
        .navigationBarTitleDisplayMode(.inline)
        .onChange(of: settings.audioPreferences) { _, _ in model.applyAudioSettings() }
    }

    private var transmitFooter: String {
        switch model.settings.transmitMode {
        case .pushToTalk: return "Nothing is sent until you press the talk button. Best in noisy places."
        case .voiceActivity: return "Mutter opens the mic when it hears you speak. Tune the sensitivity below."
        case .continuous: return "Your mic is always live. Use with a headset."
        }
    }
}

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
