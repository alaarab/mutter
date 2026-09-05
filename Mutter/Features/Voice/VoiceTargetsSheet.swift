import SwiftUI
import MumbleProtocol
import MumbleClient

struct WhisperTarget: Hashable {
    var sessions: Set<UInt32> = []
    var channelID: UInt32?
    var includeChildren = false
    var includeLinks = false

    var isEmpty: Bool { sessions.isEmpty && channelID == nil }

    var entries: [VoiceTargetEntry] {
        if let channelID {
            return [VoiceTargetEntry(channelId: channelID, links: includeLinks, children: includeChildren)]
        }
        return [VoiceTargetEntry(sessions: Array(sessions))]
    }

    @MainActor func title(in session: ServerSession) -> String {
        if let channelID {
            let name = session.channels[channelID]?.name ?? "channel"
            return includeChildren ? "#\(name) + subs" : "#\(name)"
        }
        let names = sessions.compactMap { session.users[$0]?.name }.sorted()
        if names.count <= 2 { return names.joined(separator: ", ") }
        return "\(names[0]), \(names[1]) +\(names.count - 2)"
    }
}

struct VoiceTargetsSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var draft = WhisperTarget()
    @State private var mode = 0

    private var session: ServerSession { model.session }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("A whisper is heard only by the people you pick, wherever they are. A shout goes to everyone in a channel you're not in. Hold the Whisper button or switch the mic into whisper mode.")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                    Picker("Target", selection: $mode) {
                        Text("People").tag(0)
                        Text("A channel").tag(1)
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: mode) { _, selected in
                        if selected == 0 { draft.channelID = nil } else { draft.sessions = [] }
                    }
                }

                if mode == 0 {
                    Section {
                        let others = session.users.values.filter { $0.session != session.mySession }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                        ForEach(others) { user in
                            Button {
                                if draft.sessions.contains(user.session) { draft.sessions.remove(user.session) } else { draft.sessions.insert(user.session) }
                            } label: {
                                HStack(spacing: 10) {
                                    UserAvatar(user: user, size: 30)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(user.name).foregroundStyle(Theme.ink)
                                        Text(session.channels[user.channelID]?.name ?? "").font(.caption2).foregroundStyle(Theme.muted)
                                    }
                                    Spacer()
                                    Image(systemName: draft.sessions.contains(user.session) ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(draft.sessions.contains(user.session) ? Theme.accent : Theme.muted)
                                }
                            }
                        }
                    } header: { SectionLabel(text: "Whisper to") }
                } else {
                    Section {
                        let channels = session.channels.values.sorted { left, right in
                            session.path(to: left.id).map(\.name).joined(separator: "/") < session.path(to: right.id).map(\.name).joined(separator: "/")
                        }
                        ForEach(channels) { channel in
                            Button { draft.channelID = channel.id } label: {
                                HStack {
                                    Text(session.path(to: channel.id).map { $0.name.isEmpty ? "Root" : $0.name }.joined(separator: " › "))
                                        .foregroundStyle(Theme.ink)
                                        .lineLimit(1)
                                    Spacer()
                                    if draft.channelID == channel.id {
                                        Image(systemName: "checkmark").foregroundStyle(Theme.accent)
                                    }
                                }
                            }
                        }
                    } header: { SectionLabel(text: "Shout to") }
                    Section {
                        Toggle("Include sub-channels", isOn: $draft.includeChildren)
                        Toggle("Include linked channels", isOn: $draft.includeLinks)
                    }
                }

                if model.whisperTarget != nil {
                    Section {
                        Button(role: .destructive) {
                            model.setWhisperTarget(nil)
                            dismiss()
                        } label: { Label("Clear whisper target", systemImage: "xmark.circle") }
                    }
                }
            }
            .themedList()
            .navigationTitle("Whisper & shout")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        model.setWhisperTarget(draft.isEmpty ? nil : draft)
                        dismiss()
                    }
                    .bold()
                    .disabled(draft.isEmpty)
                }
            }
            .onAppear {
                if let existing = model.whisperTarget {
                    draft = existing
                    mode = existing.channelID == nil ? 0 : 1
                }
            }
        }
        .presentationDetents([.large])
    }
}
