import SwiftUI
import MumbleProtocol
import MumbleClient

struct ServerInfoView: View {
    @Environment(AppModel.self) private var model
    @State private var showDisconnect = false
    @State private var showRegistered = false

    private var session: ServerSession { model.session }
    private var info: ServerInfo { session.serverInfo }
    private var stats: ConnectionStats { session.stats }

    var body: some View {
        List {
            if let welcome = info.welcomeText, !welcome.isEmpty {
                Section {
                    Text(HTMLText.render(welcome).text)
                        .font(.subheadline)
                        .foregroundStyle(Theme.body)
                } header: { SectionLabel(text: "Welcome") }
            }

            Section {
                LabeledContent("Address", value: session.endpoint?.displayString ?? "")
                LabeledContent("Version", value: [info.version.description, info.release].compactMap { $0 }.joined(separator: " · "))
                if let os = info.os { LabeledContent("Runs on", value: [os, info.osVersion].compactMap { $0 }.joined(separator: " ")) }
                LabeledContent("People online", value: info.maxUsers.map { "\(session.users.count) of \($0)" } ?? "\(session.users.count)")
                LabeledContent("Channels", value: "\(session.channels.count)")
                if let bw = info.maxBandwidth { LabeledContent("Max bandwidth", value: "\(bw / 1000) kbit/s") }
                if let suggest = info.suggestsPushToTalk, suggest {
                    Label("This server recommends push-to-talk.", systemImage: "hand.tap").font(.footnote).foregroundStyle(Theme.muted)
                }
            } header: { SectionLabel(text: "Server") }

            Section {
                LabeledContent("Voice path") {
                    HStack(spacing: 6) {
                        StatusDot(color: stats.isUsingUDP ? Theme.speaking : Theme.warning)
                        Text(stats.isUsingUDP ? "UDP (direct)" : "TCP tunnel")
                    }
                }
                LabeledContent("Ping (TCP)", value: stats.tcpPingAverageMs > 0 ? "\(Int(stats.tcpPingAverageMs)) ms" : "—")
                LabeledContent("Ping (UDP)", value: stats.udpPingAverageMs > 0 ? "\(Int(stats.udpPingAverageMs)) ms" : "—")
                LabeledContent("Packets", value: "\(stats.udpGood) good · \(stats.udpLate) late · \(stats.udpLost) lost")
                LabeledContent("Data", value: "\(format(stats.bytesIn)) in · \(format(stats.bytesOut)) out")
                LabeledContent("Codec", value: "Opus \(model.settings.bitrate / 1000) kbit/s · \(model.settings.frameMilliseconds) ms")
                if !model.audio.currentRoute.isEmpty { LabeledContent("Audio route", value: model.audio.currentRoute) }
            } header: { SectionLabel(text: "Connection") }

            if let cert = session.serverCertificate {
                Section {
                    LabeledContent("Issued to", value: cert.subjectSummary)
                    if let exp = cert.notValidAfter { LabeledContent("Expires", value: exp.formatted(date: .abbreviated, time: .omitted)) }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("SHA-256 fingerprint").foregroundStyle(Theme.ink)
                        Text(cert.wrappedFingerprint)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Theme.muted)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } header: { SectionLabel(text: "Certificate") }
            }

            Section {
                if let me = session.me {
                    LabeledContent("Connected as", value: me.name)
                    LabeledContent("Registered", value: me.isRegistered ? "Yes" : "No")
                    if !me.isRegistered && (info.permissions.contains(.selfRegister) || info.permissions.contains(.register)) {
                        Button { model.client.registerSelf() } label: { Label("Register on this server", systemImage: "checkmark.seal") }
                    }
                }
                let p = info.permissions
                LabeledContent("Permissions", value: permissionSummary(p))
            } header: { SectionLabel(text: "You") }

            Section {
                Button { showRegistered = true } label: {
                    Label("Registered users", systemImage: "person.text.rectangle")
                }
            } header: { SectionLabel(text: "Accounts") }

            Section {
                Button(role: .destructive) { showDisconnect = true } label: {
                    Label("Disconnect", systemImage: "phone.down.fill").frame(maxWidth: .infinity)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .confirmationDialog("Disconnect from this server?", isPresented: $showDisconnect, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { model.disconnect() }
        }
        .sheet(isPresented: $showRegistered) { RegisteredUsersView() }
    }

    private func format(_ bytes: UInt64) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary)
    }

    private func permissionSummary(_ p: Permissions) -> String {
        var parts: [String] = []
        if p.contains(.speak) { parts.append("speak") }
        if p.contains(.whisper) { parts.append("whisper") }
        if p.contains(.textMessage) { parts.append("chat") }
        if p.contains(.makeTempChannel) { parts.append("temp channels") }
        if p.contains(.makeChannel) { parts.append("channels") }
        if p.contains(.move) { parts.append("move") }
        if p.contains(.muteDeafen) { parts.append("mute") }
        if p.contains(.kick) { parts.append("kick") }
        if p.contains(.ban) { parts.append("ban") }
        if p.contains(.write) { parts.append("admin") }
        return parts.isEmpty ? "listen only" : parts.joined(separator: ", ")
    }
}
