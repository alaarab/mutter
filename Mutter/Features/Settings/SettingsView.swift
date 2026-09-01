import SwiftUI
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
                } header: { SectionLabel(text: "Appearance") }

                Section {
                    Toggle("Notify me about messages", isOn: $settings.notifyOnMessage)
                    Toggle("Show join and leave notices", isOn: $settings.showPresenceNotices)
                    Toggle("Haptic when voice activates", isOn: $settings.hapticsOnTransmit)
                    Toggle("Keep screen awake while connected", isOn: $settings.keepScreenAwake)
                } header: { SectionLabel(text: "Behaviour") }

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
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            Text("Sensitivity")
                            Spacer()
                            Text("\(Int(settings.vadThresholdDb)) dB").foregroundStyle(Theme.muted)
                        }
                        Slider(value: $settings.vadThresholdDb, in: -60 ... -15, step: 1)
                        LevelMeter(level: model.audio.inputLevelDb, threshold: settings.vadThresholdDb, active: model.audio.isTransmitting)
                        Text(model.audio.isRunning ? "Speak normally: the bar should pass the marker when you talk and stay below it when you're quiet." : "Connect to a server to see your live level here.")
                            .font(.caption)
                            .foregroundStyle(Theme.muted)
                    }
                } header: { SectionLabel(text: "Voice activity") }
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
                Toggle("Prefer speakerphone", isOn: $settings.speakerphone)
            } header: { SectionLabel(text: "Output") } footer: {
                Text("Bluetooth headsets and AirPods are used automatically when connected.")
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
        .onChange(of: settings.speakerphone) { _, _ in model.applyAudioSettings() }
    }

    private var transmitFooter: String {
        switch model.settings.transmitMode {
        case .pushToTalk: return "Nothing is sent until you press the talk button. Best in noisy places."
        case .voiceActivity: return "Mutter opens the mic when it hears you speak. Tune the sensitivity below."
        case .continuous: return "Your mic is always live. Use with a headset."
        }
    }
}
