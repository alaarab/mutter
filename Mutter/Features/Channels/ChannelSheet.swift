import SwiftUI
import MumbleProtocol
import MumbleClient

struct ChannelSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let channelID: UInt32

    @State private var showCreate = false
    @State private var newName = ""
    @State private var newTemporary = true
    @State private var showRename = false
    @State private var renameText = ""
    @State private var showDelete = false

    private var session: ServerSession { model.session }
    private var channel: Channel? { session.channels[channelID] }
    private var perms: Permissions { session.permissions(in: channelID) }
    private var isMine: Bool { session.me?.channelID == channelID }
    private var isListening: Bool { session.me?.listeningChannels.contains(channelID) ?? false }

    var body: some View {
        NavigationStack {
            if let channel {
                List {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(channel.name.isEmpty ? "Root" : channel.name)
                                .font(.displayTitle)
                                .foregroundStyle(Theme.ink)
                            Text(session.path(to: channelID).dropLast().map { $0.name.isEmpty ? "Root" : $0.name }.joined(separator: " › "))
                                .font(.caption)
                                .foregroundStyle(Theme.muted)
                            HStack(spacing: 6) {
                                Pill(text: "\(session.userCount(inTree: channelID)) here", symbol: "person.2.fill")
                                if channel.isTemporary { Pill(text: "Temporary", symbol: "clock", color: Theme.warning) }
                                if channel.isEnterRestricted { Pill(text: channel.canEnter ? "Restricted" : "Locked", symbol: "lock", color: channel.canEnter ? Theme.muted : Theme.danger) }
                                if channel.maxUsers > 0 { Pill(text: "Max \(channel.maxUsers)") }
                            }
                        }
                        .padding(.vertical, 4)
                        if let description = channel.description, !description.isEmpty {
                            Text(HTMLText.render(description).text)
                                .font(.subheadline)
                                .foregroundStyle(Theme.body)
                        }
                        if !channel.links.isEmpty {
                            let names = channel.links.compactMap { session.channels[$0]?.name }.sorted()
                            LabeledContent("Linked with", value: names.joined(separator: ", "))
                        }
                    }
                    .listRowBackground(Theme.surface)

                    Section {
                        if !isMine {
                            Button {
                                model.join(channel)
                                dismiss()
                            } label: {
                                Label("Join channel", systemImage: "arrow.right.circle.fill")
                            }
                            .disabled(!channel.canEnter)
                        }
                        Toggle(isOn: Binding(get: { isListening }, set: { model.client.setListening(channel: channelID, listening: $0) })) {
                            Label("Listen without joining", systemImage: "ear")
                        }
                        .disabled(!perms.contains(.listen) && !isListening)
                        Button {
                            model.pendingChatScope = .channel(channelID)
                            dismiss()
                        } label: {
                            Label("Message this channel", systemImage: "bubble.left")
                        }
                        if !session.children(of: channelID).isEmpty {
                            Button {
                                model.pendingChatScope = .tree(channelID)
                                dismiss()
                            } label: {
                                Label("Message channel and sub-channels", systemImage: "bubble.left.and.text.bubble.right")
                            }
                        }
                    }

                    if perms.contains(.makeChannel) || perms.contains(.makeTempChannel) || perms.contains(.write) {
                        Section {
                            if perms.contains(.makeChannel) || perms.contains(.makeTempChannel) {
                                Button { newName = ""; newTemporary = !perms.contains(.makeChannel); showCreate = true } label: {
                                    Label("New sub-channel…", systemImage: "plus.rectangle.on.folder")
                                }
                            }
                            if perms.contains(.write) && channelID != Channel.rootID {
                                Button {
                                    renameText = channel.name
                                    showRename = true
                                } label: {
                                    Label("Rename…", systemImage: "pencil")
                                }
                                Button(role: .destructive) { showDelete = true } label: {
                                    Label("Delete channel…", systemImage: "trash")
                                }
                            }
                        } header: { SectionLabel(text: "Manage") }
                    }
                }
                .themedList()
                .navigationBarTitleDisplayMode(.inline)
                .doneToolbar(dismiss)
                .onAppear { model.client.requestPermissions(channel: channelID) }
                .alert("New sub-channel", isPresented: $showCreate) {
                    TextField("Name", text: $newName)
                    Button("Create") {
                        model.client.createChannel(name: newName, parent: channelID, temporary: newTemporary || !perms.contains(.makeChannel))
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text(perms.contains(.makeChannel) ? "The channel will be permanent." : "Temporary channels disappear when the last person leaves.")
                }
                .alert("Rename channel", isPresented: $showRename) {
                    TextField("Name", text: $renameText)
                    Button("Rename") { model.client.renameChannel(channelID, name: renameText) }
                    Button("Cancel", role: .cancel) {}
                }
                .confirmationDialog("Delete “\(channel.name)” and everything in it?", isPresented: $showDelete, titleVisibility: .visible) {
                    Button("Delete", role: .destructive) { model.client.removeChannel(channelID); dismiss() }
                }
            } else {
                EmptyState(symbol: "number", title: "Channel removed", message: "This channel no longer exists.")
                    .doneToolbar(dismiss)
            }
        }
        .presentationDetents([.medium, .large])
    }
}
