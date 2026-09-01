import SwiftUI
import MumbleProtocol
import MumbleClient

struct UserSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let sessionID: UInt32

    @State private var volume: Float = 1
    @State private var kickReason = ""
    @State private var showKick = false
    @State private var showBan = false
    @State private var showComment = false
    @State private var commentDraft = ""

    private var session: ServerSession { model.session }
    private var user: User? { session.users[sessionID] }
    private var isMe: Bool { session.mySession == sessionID }
    private var perms: Permissions {
        guard let user else { return .none }
        return session.permissions(in: user.channelID)
    }

    var body: some View {
        NavigationStack {
            if let user {
                List {
                    Section {
                        HStack(spacing: 14) {
                            UserAvatar(user: user, size: 56)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(user.name).font(.displayTitle).foregroundStyle(Theme.ink)
                                HStack(spacing: 6) {
                                    if user.isRegistered { Pill(text: "Registered", symbol: "checkmark.seal.fill") }
                                    if user.isPrioritySpeaker { Pill(text: "Priority", symbol: "star.fill", color: Theme.warning) }
                                    if user.isTalking { Pill(text: "Speaking", symbol: "waveform", color: Theme.speaking) }
                                }
                                Text(session.path(to: user.channelID).map { $0.name }.joined(separator: " › "))
                                    .font(.caption)
                                    .foregroundStyle(Theme.muted)
                            }
                        }
                        .padding(.vertical, 4)
                        if let comment = user.comment, !comment.isEmpty {
                            Text(HTMLText.render(comment).text)
                                .font(.subheadline)
                                .foregroundStyle(Theme.body)
                        }
                    }
                    .listRowBackground(Theme.surface)

                    if !isMe {
                        Section {
                            Toggle(isOn: Binding(
                                get: { user.isLocallyMuted },
                                set: { model.setLocalMute(user, muted: $0) }
                            )) {
                                Label("Mute for me", systemImage: "speaker.slash")
                            }
                            VStack(alignment: .leading, spacing: 6) {
                                Label("Volume \(Int(volume * 100))%", systemImage: "speaker.wave.2")
                                Slider(value: $volume, in: 0...2, step: 0.05, onEditingChanged: { editing in
                                    if !editing { model.setLocalVolume(user, volume: volume) }
                                })
                            }
                            Button {
                                model.pendingChatScope = .user(user.session)
                                dismiss()
                            } label: { Label("Send a message", systemImage: "bubble.left") }
                        } header: { SectionLabel(text: "For you only") }
                    } else {
                        Section {
                            Button { commentDraft = user.comment ?? ""; showComment = true } label: {
                                Label("Set your comment", systemImage: "text.quote")
                            }
                            if !user.isRegistered && (perms.contains(.selfRegister) || perms.contains(.register)) {
                                Button { model.client.registerSelf() } label: {
                                    Label("Register on this server", systemImage: "checkmark.seal")
                                }
                            }
                            Toggle(isOn: Binding(
                                get: { user.isRecording },
                                set: { model.client.setRecording($0) }
                            )) { Label("Show as recording", systemImage: "record.circle") }
                        } header: { SectionLabel(text: "You") }
                    }

                    if !isMe && (perms.contains(.move) || perms.contains(.muteDeafen) || perms.contains(.kick) || perms.contains(.ban)) {
                        Section {
                            if perms.contains(.move), let mine = session.me?.channelID, mine != user.channelID {
                                Button { model.client.moveUser(session: user.session, to: mine) } label: {
                                    Label("Move to my channel", systemImage: "arrow.right.to.line")
                                }
                            }
                            if perms.contains(.muteDeafen) {
                                Toggle(isOn: Binding(get: { user.isMuted }, set: { model.client.serverMute(session: user.session, mute: $0) })) {
                                    Label("Server mute", systemImage: "mic.slash")
                                }
                                Toggle(isOn: Binding(get: { user.isDeafened }, set: { model.client.serverDeafen(session: user.session, deaf: $0) })) {
                                    Label("Server deafen", systemImage: "speaker.slash")
                                }
                                Toggle(isOn: Binding(get: { user.isPrioritySpeaker }, set: { model.client.setPrioritySpeaker(session: user.session, on: $0) })) {
                                    Label("Priority speaker", systemImage: "star")
                                }
                            }
                            if perms.contains(.kick) {
                                Button(role: .destructive) { showKick = true } label: { Label("Kick…", systemImage: "figure.walk.departure") }
                            }
                            if perms.contains(.ban) {
                                Button(role: .destructive) { showBan = true } label: { Label("Ban…", systemImage: "nosign") }
                            }
                        } header: { SectionLabel(text: "Moderation") }
                    }

                    Section {
                        if let stats = user.stats {
                            statsRows(stats)
                        } else {
                            HStack { ProgressView().controlSize(.small); Text("Loading details…").foregroundStyle(Theme.muted) }
                        }
                    } header: { SectionLabel(text: "Details") }
                }
                .scrollContentBackground(.hidden)
                .background(Theme.background)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .onAppear {
                    volume = user.localVolume
                    model.client.requestStats(session: sessionID)
                    model.client.requestPermissions(channel: user.channelID)
                }
                .alert("Kick \(user.name)", isPresented: $showKick) {
                    TextField("Reason (optional)", text: $kickReason)
                    Button("Kick", role: .destructive) { model.client.kick(session: sessionID, reason: kickReason, ban: false); dismiss() }
                    Button("Cancel", role: .cancel) {}
                }
                .alert("Ban \(user.name)", isPresented: $showBan) {
                    TextField("Reason (optional)", text: $kickReason)
                    Button("Ban", role: .destructive) { model.client.kick(session: sessionID, reason: kickReason, ban: true); dismiss() }
                    Button("Cancel", role: .cancel) {}
                }
                .alert("Your comment", isPresented: $showComment) {
                    TextField("Comment", text: $commentDraft)
                    Button("Save") { model.client.setComment(HTMLText.htmlFromPlain(commentDraft)) }
                    Button("Cancel", role: .cancel) {}
                }
            } else {
                EmptyState(symbol: "person.slash", title: "Gone", message: "This person has left the server.")
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func statsRows(_ stats: UserStatsMessage) -> some View {
        if let v = stats.version {
            LabeledContent("Client", value: [v.release, v.os].compactMap { $0 }.joined(separator: " on "))
        }
        if let secs = stats.onlineSeconds {
            LabeledContent("Online for", value: Duration.seconds(Double(secs)).formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated)))
        }
        if let idle = stats.idleSeconds, idle > 60 {
            LabeledContent("Idle for", value: Duration.seconds(Double(idle)).formatted(.units(allowed: [.hours, .minutes], width: .abbreviated)))
        }
        if let ping = stats.udpPingAvg, ping > 0 {
            LabeledContent("Ping (UDP)", value: "\(Int(ping)) ms")
        } else if let ping = stats.tcpPingAvg, ping > 0 {
            LabeledContent("Ping (TCP)", value: "\(Int(ping)) ms")
        }
        if let addr = stats.addressString {
            LabeledContent("Address", value: addr)
        }
        if let from = stats.fromClient {
            LabeledContent("Packets from them", value: "\(from.good) good · \(from.late) late · \(from.lost) lost")
        }
        if let bw = stats.bandwidth {
            LabeledContent("Bandwidth", value: "\(bw / 1000) kbit/s")
        }
        if let strong = stats.strongCertificate {
            LabeledContent("Certificate", value: strong ? "Verified" : "Self-signed")
        }
    }
}
