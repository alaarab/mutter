import SwiftUI
import MumbleProtocol
import MumbleClient

struct ChannelTreeView: View {
    @Environment(AppModel.self) private var model
    var onUser: (User) -> Void
    var onChannel: (Channel) -> Void
    @State private var search = ""

    private var session: ServerSession { model.session }

    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted)
                TextField("Find a channel or person", text: $search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($searchFocused)
                if !search.isEmpty {
                    Button { search = ""; searchFocused = false } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted)
                    }
                    .buttonStyle(.plain)
                } else {
                    Button { model.settings.hideEmptyChannels.toggle() } label: {
                        Image(systemName: model.settings.hideEmptyChannels ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                            .foregroundStyle(model.settings.hideEmptyChannels ? Theme.accent : Theme.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(model.settings.hideEmptyChannels ? "Show empty channels" : "Hide empty channels")
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 16)
            .padding(.bottom, 6)

            List {
                if search.trimmingCharacters(in: .whitespaces).isEmpty {
                    if let root = session.rootChannel {
                        ChannelNode(channel: root, depth: 0, onUser: onUser, onChannel: onChannel)
                    }
                } else {
                    searchResults
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.immediately)
            .environment(\.defaultMinListRowHeight, 40)
        }
        .background(Theme.background)
    }

    @ViewBuilder
    private var searchResults: some View {
        let q = search.trimmingCharacters(in: .whitespaces)
        let channels = session.channels.values.filter { $0.name.localizedCaseInsensitiveContains(q) }.sorted { $0.name < $1.name }
        let users = session.users.values.filter { $0.name.localizedCaseInsensitiveContains(q) }.sorted { $0.name < $1.name }
        if channels.isEmpty && users.isEmpty {
            EmptyState(symbol: "magnifyingglass", title: "Nothing found", message: "No channels or people match “\(q)”.")
                .listRowSeparator(.hidden)
        }
        if !channels.isEmpty {
            Section {
                ForEach(channels) { channel in
                    ChannelRow(channel: channel, depth: 0, showPath: true, onChannel: onChannel)
                }
            } header: { SectionLabel(text: "Channels") }
        }
        if !users.isEmpty {
            Section {
                ForEach(users) { user in
                    UserRow(user: user, depth: 0, showChannel: true, onUser: onUser)
                }
            } header: { SectionLabel(text: "People") }
        }
    }
}

/// One channel with its users and (unless collapsed) its sub-channels. Recursive.
struct ChannelNode: View {
    @Environment(AppModel.self) private var model
    var channel: Channel
    var depth: Int
    var onUser: (User) -> Void
    var onChannel: (Channel) -> Void

    var body: some View {
        let session = model.session
        let collapsed = model.isCollapsed(channel.id)
        ChannelRow(channel: channel, depth: depth, showPath: false, onChannel: onChannel)
        if !collapsed {
            ForEach(session.users(in: channel.id)) { user in
                UserRow(user: user, depth: depth + 1, showChannel: false, onUser: onUser)
            }
            ForEach(visibleChildren(session)) { child in
                ChannelNode(channel: child, depth: depth + 1, onUser: onUser, onChannel: onChannel)
            }
        }
    }
}

extension ChannelNode {
    /// With "hide empty channels" on, skip sub-trees nobody is in (but never the one we're in).
    func visibleChildren(_ session: ServerSession) -> [Channel] {
        let children = session.children(of: channel.id)
        guard model.settings.hideEmptyChannels else { return children }
        let mine = session.me?.channelID
        return children.filter { child in
            session.userCount(inTree: child.id) > 0 || session.path(to: mine ?? Channel.rootID).contains { $0.id == child.id }
        }
    }
}

struct ChannelRow: View {
    @Environment(AppModel.self) private var model
    var channel: Channel
    var depth: Int
    var showPath: Bool
    var onChannel: (Channel) -> Void

    private var session: ServerSession { model.session }
    private var isMine: Bool { session.me?.channelID == channel.id }
    private var hasChildren: Bool { !session.children(of: channel.id).isEmpty }
    private var collapsed: Bool { model.isCollapsed(channel.id) }
    private var treeCount: Int { session.userCount(inTree: channel.id) }
    private var isListening: Bool { session.me?.listeningChannels.contains(channel.id) ?? false }

    var body: some View {
        HStack(spacing: 8) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { model.toggleCollapsed(channel.id) }
            } label: {
                Image(systemName: "chevron.right")
                    .font(.icon(11, .bold))
                    .foregroundStyle(Theme.muted)
                    .rotationEffect(.degrees(collapsed ? 0 : 90))
                    .frame(width: 20, height: 24)
                    .opacity(hasChildren || treeCount > 0 ? 1 : 0.25)
            }
            .buttonStyle(.plain)

            Image(systemName: channel.isEnterRestricted && !channel.canEnter ? "lock.fill" : (channel.isTemporary ? "clock" : "number"))
                .font(.icon(13, .semibold))
                .foregroundStyle(isMine ? Theme.accent : Theme.muted)
                .frame(width: 16)

            VStack(alignment: .leading, spacing: 1) {
                Text(channel.id == Channel.rootID && channel.name.isEmpty ? "Root" : channel.name)
                    .font(.ui(16, isMine ? .semibold : .medium))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                if showPath {
                    Text(session.path(to: channel.id).dropLast().map { $0.name }.joined(separator: " › "))
                        .font(.caption2)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 6)

            if isListening {
                Image(systemName: "ear").font(.caption).foregroundStyle(Theme.whisper)
            }
            if channel.maxUsers > 0 {
                Text("\(treeCount)/\(channel.maxUsers)").font(.caption2).foregroundStyle(Theme.muted)
            } else if treeCount > 0 {
                Text("\(treeCount)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Theme.surfaceElevated, in: Capsule())
            }
            if !isMine {
                Button {
                    model.join(channel)
                } label: {
                    Image(systemName: "arrow.right.circle.fill")
                        .font(.icon(20))
                        .foregroundStyle(channel.canEnter ? Theme.accent : Theme.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Join \(channel.name)")
            }
        }
        .padding(.leading, CGFloat(depth) * 18)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { onChannel(channel) }
        .listRowBackground(isMine ? Theme.accent.opacity(0.10) : Color.clear)
        .listRowSeparator(.hidden)
        .contextMenu {
            if !isMine { Button { model.join(channel) } label: { Label("Join", systemImage: "arrow.right.circle") } }
            Button { onChannel(channel) } label: { Label("Details", systemImage: "info.circle") }
            Button {
                model.client.setListening(channel: channel.id, listening: !isListening)
            } label: {
                Label(isListening ? "Stop listening" : "Listen in", systemImage: "ear")
            }
            Button {
                model.pendingChatScope = .channel(channel.id)
            } label: { Label("Message channel", systemImage: "bubble.left") }
        }
    }
}

struct UserRow: View {
    @Environment(AppModel.self) private var model
    var user: User
    var depth: Int
    var showChannel: Bool
    var onUser: (User) -> Void

    private var isMe: Bool { model.session.mySession == user.session }

    var body: some View {
        HStack(spacing: 10) {
            UserAvatar(user: user, size: 30)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(user.name)
                        .font(.ui(14, isMe ? .semibold : .regular, relativeTo: .subheadline))
                        .foregroundStyle(user.isSilenced ? Theme.muted : Theme.ink)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .layoutPriority(1)
                    if isMe { Text("you").font(.caption2).foregroundStyle(Theme.muted) }
                    if user.isPrioritySpeaker { Image(systemName: "star.fill").font(.caption2).foregroundStyle(Theme.warning) }
                    if user.isRecording { Image(systemName: "record.circle").font(.caption2).foregroundStyle(Theme.danger) }
                    if user.isRegistered { Image(systemName: "checkmark.seal.fill").font(.caption2).foregroundStyle(Theme.muted) }
                }
                if showChannel, let ch = model.session.channels[user.channelID] {
                    Text(ch.name).font(.caption2).foregroundStyle(Theme.muted)
                } else if user.isTalking {
                    Text(user.talkingContext == .whisper ? "Whispering" : (user.talkingContext == .shout ? "Shouting" : "Speaking"))
                        .font(.caption2)
                        .foregroundStyle(user.talkingContext == .normal ? Theme.speaking : Theme.whisper)
                }
            }
            Spacer()
            if user.isLocallyMuted {
                Image(systemName: "speaker.slash").font(.caption).foregroundStyle(Theme.warning)
            }
        }
        .padding(.leading, CGFloat(depth) * 18 + 12)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .onTapGesture { onUser(user) }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
}
