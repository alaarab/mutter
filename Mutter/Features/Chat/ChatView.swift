import SwiftUI
import PhotosUI
import MumbleProtocol
import MumbleClient

struct ChatView: View {
    @Environment(AppModel.self) private var model
    var onUser: (UInt32) -> Void

    @State private var draft = ""
    @State private var customScope: MessageScope?
    @State private var photoItem: PhotosPickerItem?
    @State private var pendingPhoto: PendingPhoto?
    @State private var sendingImage = false
    @State private var imageError: String?
    @FocusState private var composerFocused: Bool

    private var session: ServerSession { model.session }

    private var scope: MessageScope {
        if let customScope, isValid(customScope) { return customScope }
        return .channel(session.me?.channelID ?? Channel.rootID)
    }

    private func isValid(_ s: MessageScope) -> Bool {
        switch s {
        case .channel(let id), .tree(let id): return session.channels[id] != nil
        case .user(let id): return session.users[id] != nil
        case .system: return false
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if session.messages.isEmpty {
                            EmptyState(symbol: "bubble.left.and.bubble.right", title: "No messages yet", message: "Messages sent to your channel, or directly to you, show up here.")
                                .padding(.top, 40)
                        }
                        ForEach(session.messages) { message in
                            MessageRow(message: message, onUser: onUser)
                                .id(message.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: session.messages.count, initial: true) { _, _ in
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .onChange(of: composerFocused) { _, focused in
                    if focused { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            composer
        }
        .background(Theme.background)
        .onChange(of: model.pendingChatScope, initial: true) { _, pending in
            if let pending {
                customScope = pending
                model.pendingChatScope = nil
                composerFocused = true
            }
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            Task { await loadPhoto(item) }
        }
        .sheet(item: $pendingPhoto) { photo in
            PhotoConfirmSheet(image: photo.image, destination: scopeTitle) {
                Task { await sendPhoto(photo.image) }
            }
        }
    }

    private func loadPhoto(_ item: PhotosPickerItem) async {
        sendingImage = true
        defer { sendingImage = false; photoItem = nil }
        guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
            imageError = "Couldn't read that photo."
            return
        }
        imageError = nil
        pendingPhoto = PendingPhoto(image: image)
    }

    private func sendPhoto(_ image: UIImage) async {
        sendingImage = true
        defer { sendingImage = false }
        let limit = Int(session.serverInfo.imageMessageLength ?? UInt32(ImageMessageEncoder.defaultLimit))
        let target = scope
        let html = await Task.detached(priority: .userInitiated) { ImageMessageEncoder.html(for: image, limit: limit) }.value
        guard let html else {
            imageError = "That photo is too large for this server, even after shrinking it."
            return
        }
        imageError = nil
        model.client.sendText(html: html, to: target)
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 6) {
            Divider().overlay(Theme.separator)
            if let imageError {
                Text(imageError).font(.caption).foregroundStyle(Theme.danger).padding(.horizontal, 12)
            }
            HStack(alignment: .bottom, spacing: 8) {
                AttachImageButton(selection: $photoItem, busy: sendingImage)

                Menu {
                    Section("Send to") {
                        if let mine = session.myChannel {
                            Button { customScope = nil } label: { Label("#\(mine.name) (your channel)", systemImage: "number") }
                            if !session.children(of: mine.id).isEmpty {
                                Button { customScope = .tree(mine.id) } label: { Label("#\(mine.name) and sub-channels", systemImage: "arrow.triangle.branch") }
                            }
                        }
                        let others = session.users.values.filter { $0.session != session.mySession }.sorted { $0.name < $1.name }
                        if !others.isEmpty {
                            Menu("Direct message") {
                                ForEach(others) { u in
                                    Button { customScope = .user(u.session) } label: { Text(u.name) }
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: scopeSymbol).font(.caption.weight(.bold))
                        Text(scopeTitle).font(.caption.weight(.semibold)).lineLimit(1)
                        Image(systemName: "chevron.up.chevron.down").font(.icon(9, .bold))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .foregroundStyle(scopeColor)
                    .background(scopeColor.opacity(0.12), in: Capsule())
                }

                TextField("Message", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .focused($composerFocused)
                    .onSubmit { send() }

                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.icon(15, .bold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(canSend ? Theme.accent : Theme.muted, in: Circle())
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
        .background(Theme.background)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && session.isConnected
    }

    private var scopeTitle: String {
        switch scope {
        case .channel(let id): return session.channels[id]?.name ?? "Channel"
        case .tree(let id): return "\(session.channels[id]?.name ?? "Channel") +subs"
        case .user(let id): return session.users[id]?.name ?? "User"
        case .system: return "System"
        }
    }

    private var scopeSymbol: String {
        switch scope {
        case .channel: return "number"
        case .tree: return "arrow.triangle.branch"
        case .user: return "person.fill"
        case .system: return "info.circle"
        }
    }

    private var scopeColor: Color {
        if case .user = scope { return Theme.whisper }
        return Theme.accent
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.client.sendText(html: HTMLText.htmlFromPlain(text), to: scope)
        draft = ""
    }
}

struct PendingPhoto: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// Preview shown after picking a photo, so nothing sends until you confirm.
struct PhotoConfirmSheet: View {
    let image: UIImage
    let destination: String
    var onSend: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 16) {
            Text("Send photo")
                .font(.headline)
                .foregroundStyle(Theme.ink)
                .padding(.top, 20)
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .frame(maxWidth: .infinity, maxHeight: 380)
                .padding(.horizontal, 20)
            Spacer(minLength: 0)
            VStack(spacing: 10) {
                Button {
                    onSend()
                    dismiss()
                } label: {
                    Label("Send to \(destination)", systemImage: "arrow.up.circle.fill")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                Button("Cancel") { dismiss() }
                    .font(.body.weight(.medium))
                    .foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 16)
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Theme.background)
    }
}

struct MessageRow: View {
    @Environment(AppModel.self) private var model
    var message: ChatMessage
    var onUser: (UInt32) -> Void
    @State private var viewedImage: ViewedImage?

    private var rendered: HTMLText.Rendered { HTMLText.render(message.html) }

    private var hasText: Bool {
        !String(rendered.text.characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        if message.isSystem {
            VStack(spacing: 4) {
                Text(rendered.text)
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                images
            }
        } else {
            HStack(alignment: .top, spacing: 8) {
                if message.isOwn { Spacer(minLength: 40) } else {
                    Button { if let s = message.senderSession { onUser(s) } } label: {
                        Avatar(name: message.senderName, texture: model.session.users[message.senderSession ?? 0]?.texture, size: 30)
                    }
                    .buttonStyle(.plain)
                }
                VStack(alignment: message.isOwn ? .trailing : .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        if !message.isOwn {
                            Text(message.senderName).font(.caption.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                        }
                        scopeTag
                        Text(message.date, style: .time).font(.caption2).foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: 300, alignment: message.isOwn ? .trailing : .leading)
                    VStack(alignment: .leading, spacing: 8) {
                        if hasText {
                            Text(rendered.text)
                                .font(.body)
                                .foregroundStyle(message.isOwn ? .white : Theme.ink)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: 300, alignment: .leading)
                        }
                        images
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, hasText ? 8 : 12)
                    .background(
                        message.isOwn ? Theme.accent : Theme.surface,
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(message.isOwn ? Color.clear : Theme.separator, lineWidth: 1)
                    )
                }
                if !message.isOwn { Spacer(minLength: 40) }
            }
        }
    }

    @ViewBuilder
    private var scopeTag: some View {
        switch message.scope {
        case .user:
            Pill(text: "DM", symbol: "lock.fill", color: Theme.whisper)
        case .tree(let id):
            Pill(text: "#\(model.session.channels[id]?.name ?? "") +subs", color: Theme.muted)
        case .channel(let id):
            if id != model.session.me?.channelID {
                Pill(text: "#\(model.session.channels[id]?.name ?? "")", color: Theme.muted)
            }
        case .system:
            EmptyView()
        }
    }

    @ViewBuilder
    private var images: some View {
        ForEach(Array(rendered.images.enumerated()), id: \.offset) { _, image in
            Button { viewedImage = ViewedImage(image: image) } label: {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 260, maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
        }
        .fullScreenCover(item: $viewedImage) { viewed in
            ImageViewerScreen(image: viewed.image)
        }
    }
}
