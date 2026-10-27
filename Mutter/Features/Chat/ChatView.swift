import SwiftUI
import PhotosUI
import MumbleProtocol
import MumbleClient

struct ChatView: View {
    @Environment(AppModel.self) private var model
    var onUser: (UInt32) -> Void

    private var draft: String {
        get { model.chatDraft }
        nonmutating set { model.chatDraft = newValue }
    }

    private var customScope: MessageScope? {
        get { model.chatScope }
        nonmutating set { model.chatScope = newValue }
    }

    private var draftBinding: Binding<String> {
        Binding(get: { model.chatDraft }, set: { model.chatDraft = $0 })
    }
    @State private var photoItem: PhotosPickerItem?
    @State private var pendingPhoto: PendingPhoto?
    @State private var sendingImage = false
    @State private var imageError: String?
    @FocusState private var composerFocused: Bool
    @State private var isAtBottom = true
    @State private var unseenBelow = 0
    @State private var followsLatestMessageThroughKeyboard = false
    @State private var transcriptEndOffset: CGFloat = 0
    @State private var transcriptViewportHeight: CGFloat = 0
    @State private var messageSelection = MessageSelection()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let transcriptSpace = "chat-transcript-space"
    private static let bottomTolerance: CGFloat = 32
    private static let dockTransitionSeconds = 0.25

    private var session: ServerSession { model.session }

    private var scope: MessageScope {
        if let customScope, isValid(customScope) { return customScope }
        return .channel(session.me?.channelID ?? Channel.rootID)
    }

    private func isValid(_ candidate: MessageScope) -> Bool {
        switch candidate {
        case .channel(let id), .tree(let id): return session.channels[id] != nil
        case .user(let id): return session.users[id] != nil
        case .system: return false
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        LazyVStack(alignment: .leading, spacing: 3) {
                            if session.messages.isEmpty {
                                EmptyState(symbol: "bubble.left.and.bubble.right", title: "No messages yet", message: "Messages sent to your channel, or directly to you, show up here.")
                                    .padding(.top, 40)
                            }
                            ForEach(Array(session.messages.enumerated()), id: \.element.id) { index, message in
                                MessageRow(message: message, continuesGroup: continuesGroup(at: index), onUser: onUser)
                                    .id(message.id)
                                    .transition(.asymmetric(
                                        insertion: .move(edge: .bottom).combined(with: .opacity),
                                        removal: .opacity
                                    ))
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.top, 8)
                        .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86), value: session.messages.last?.id)
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                            .background(GeometryReader { marker in
                                Color.clear.preference(
                                    key: TranscriptEndOffsetKey.self,
                                    value: marker.frame(in: .named(Self.transcriptSpace)).minY
                                )
                            })
                    }
                }
                .coordinateSpace(name: Self.transcriptSpace)
                .background(GeometryReader { viewport in
                    Color.clear.preference(key: TranscriptViewportHeightKey.self, value: viewport.size.height)
                })
                .onPreferenceChange(TranscriptViewportHeightKey.self) { height in
                    transcriptViewportHeight = height
                    if followsLatestMessageThroughKeyboard {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    } else {
                        updateIsAtBottom()
                    }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                    beginFollowingThroughKeyboard(proxy)
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                    beginFollowingThroughKeyboard(proxy)
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                    finishFollowingThroughKeyboard(proxy)
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
                    finishFollowingThroughKeyboard(proxy)
                }
                .onPreferenceChange(TranscriptEndOffsetKey.self) { offset in
                    transcriptEndOffset = offset
                    if !followsLatestMessageThroughKeyboard { updateIsAtBottom() }
                }
                .scrollDismissesKeyboard(.interactively)
                .contentShape(Rectangle())
                .simultaneousGesture(TapGesture().onEnded {
                    composerFocused = false
                    messageSelection.transcriptTapped()
                })
                .environment(messageSelection)
                .accessibilityIdentifier("chat-transcript")
                .overlay(alignment: .bottom) {
                    if !isAtBottom && unseenBelow > 0 {
                        NewMessagesButton(count: unseenBelow) { scrollToBottom(proxy) }
                            .padding(.bottom, 10)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .animation(.easeOut(duration: 0.2), value: unseenBelow > 0 && !isAtBottom)
                .onChange(of: session.totalMessagesPosted, initial: true) { previous, current in
                    let newestIsOwn = session.messages.last?.isOwn ?? false
                    if isAtBottom || newestIsOwn || previous == current {
                        scrollToBottom(proxy)
                    } else {
                        unseenBelow += current - previous
                    }
                }
                .onChange(of: composerFocused) { _, focused in
                    if focused && isAtBottom { scrollToBottom(proxy) }
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
        defer {
            sendingImage = false
            photoItem = nil
        }
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

    private func beginFollowingThroughKeyboard(_ proxy: ScrollViewProxy) {
        guard isAtBottom else { return }
        followsLatestMessageThroughKeyboard = true
        unseenBelow = 0
        DispatchQueue.main.async { proxy.scrollTo("bottom", anchor: .bottom) }
    }

    private func finishFollowingThroughKeyboard(_ proxy: ScrollViewProxy) {
        guard followsLatestMessageThroughKeyboard else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.dockTransitionSeconds) {
            proxy.scrollTo("bottom", anchor: .bottom)
            followsLatestMessageThroughKeyboard = false
            isAtBottom = true
        }
    }

    private func updateIsAtBottom() {
        guard transcriptViewportHeight > 0 else { return }
        let atBottom = transcriptEndOffset <= transcriptViewportHeight + Self.bottomTolerance
        if atBottom != isAtBottom { isAtBottom = atBottom }
        if atBottom && unseenBelow != 0 { unseenBelow = 0 }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        unseenBelow = 0
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
    }

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
                                ForEach(others) { user in
                                    Button { customScope = .user(user.session) } label: { Text(user.name) }
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
                    .contentShape(Rectangle().inset(by: -6))
                }

                TextField(session.isConnected ? "Message" : "Waiting for the connection…", text: draftBinding, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Theme.surfaceSunken, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .focused($composerFocused)
                    .accessibilityIdentifier("chat-composer")
                    .onSubmit { send() }

                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.icon(15, .bold))
                        .foregroundStyle(Theme.onAccent)
                        .frame(width: 34, height: 34)
                        .background(canSend ? Theme.accent : Theme.muted, in: Circle())
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .disabled(!canSend)
                .accessibilityLabel("Send")
                .accessibilityIdentifier("chat-send")
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
        .background(Theme.background)
        .contentShape(Rectangle())
        .dismissKeyboardOnDownwardDrag { composerFocused = false }
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

    private static let groupWindow: TimeInterval = 5 * 60

    private func continuesGroup(at index: Int) -> Bool {
        guard index > 0 else { return false }
        let previous = session.messages[index - 1], message = session.messages[index]
        return !previous.isSystem && !message.isSystem && previous.isOwn == message.isOwn
            && previous.senderSession == message.senderSession && previous.scope == message.scope
            && message.date.timeIntervalSince(previous.date) < Self.groupWindow
            && Calendar.current.isDate(previous.date, inSameDayAs: message.date)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.client.sendText(html: ChatMarkdown.html(from: text), to: scope)
        draft = ""
        Haptics.impact(.light)
    }
}

private struct TranscriptEndOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct TranscriptViewportHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct NewMessagesButton: View {
    var count: Int
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down").font(.caption.weight(.bold))
                Text(count == 1 ? "1 new message" : "\(count) new messages").font(.caption.weight(.semibold))
            }
            .foregroundStyle(Theme.onAccent)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Theme.accent, in: Capsule())
            .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        }
        .buttonStyle(ThemePressStyle())
        .accessibilityIdentifier("chat-new-messages")
    }
}

struct PendingPhoto: Identifiable {
    let id = UUID()
    let image: UIImage
}

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
                        .foregroundStyle(Theme.onAccent)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(Theme.accentGradient, in: RoundedRectangle(cornerRadius: Theme.radiusMedium, style: .continuous))
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
    @Environment(MessageSelection.self) private var selection: MessageSelection?
    var message: ChatMessage
    /// The same person's previous message, close enough in time that this
    /// one joins its group: no avatar or name, a tighter gap.
    var continuesGroup = false
    var onUser: (UInt32) -> Void
    @State private var viewedImage: ViewedImage?

    private static let bubbleWidth: CGFloat = 300
    private static let radius: CGFloat = 18

    private var rendered: HTMLText.Rendered { HTMLText.render(message.html) }

    private var hasText: Bool {
        !String(rendered.text.characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func bubbleText(_ text: AttributedString) -> AttributedString {
        guard message.isOwn else { return text }
        var restyled = text
        for run in restyled.runs where run.link != nil {
            restyled[run.range].swiftUI.foregroundColor = Theme.onOwnBubble
        }
        return restyled
    }

    private var textColor: Color { message.isOwn ? Theme.onOwnBubble : Theme.ink }
    private var quietColor: Color { message.isOwn ? Theme.onOwnBubbleMuted : Theme.muted }
    private var isSelecting: Bool { selection?.active == message.id }
    private var failure: String? {
        if case .failed(let reason, _) = message.delivery { return reason }
        return nil
    }
    private var canRetry: Bool { message.delivery?.canRetry == true }

    /// A message that is one run of prose is selected in place; anything
    /// with code or quotes is selected as its whole text, laid over all of it.
    private var isSingleProse: Bool {
        if rendered.blocks.count == 1, case .prose = rendered.blocks[0] { return true }
        return false
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
            HStack(alignment: .bottom, spacing: 8) {
                if message.isOwn { Spacer(minLength: 48) } else {
                    Group {
                        if continuesGroup {
                            Color.clear.frame(width: 30, height: 1)
                        } else {
                            Button { if let sender = message.senderSession { onUser(sender) } } label: {
                                Avatar(name: message.senderName, texture: model.session.users[message.senderSession ?? 0]?.texture, size: 30)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                VStack(alignment: message.isOwn ? .trailing : .leading, spacing: 4) {
                    if !continuesGroup { header }
                    bubble
                    if let failure {
                        HStack(spacing: 8) {
                            Label("Not delivered · \(failure)", systemImage: "exclamationmark.circle.fill")
                                .accessibilityIdentifier("chat-message-failed")
                            if canRetry {
                                Button("Try Again") { model.client.retry(message) }
                                    .buttonStyle(.borderless)
                                    .disabled(!model.session.isConnected)
                                    .accessibilityLabel("Try again, message not delivered")
                                    .accessibilityIdentifier("chat-message-retry")
                            }
                        }
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: Self.bubbleWidth, alignment: .trailing)
                    }
                }
                if !message.isOwn { Spacer(minLength: 48) }
            }
            .padding(.top, continuesGroup ? 0 : 8)
        }
    }

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 6) {
            if !message.isOwn {
                Text(message.senderName).font(.caption.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
            }
            scopeTag
            if !message.isOwn {
                Text(message.date, style: .time).font(.caption2).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: Self.bubbleWidth, alignment: message.isOwn ? .trailing : .leading)
        .padding(.horizontal, 4)
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !hasText && rendered.images.isEmpty && rendered.unreadableImages > 0 {
                Label("Image couldn't be shown", systemImage: "photo.badge.exclamationmark")
                    .font(.footnote)
                    .foregroundStyle(quietColor)
            }
            // Nothing to show at all, as 0.1.1 sent a lone ```: say so rather
            // than leave a bubble with only its time.
            if !hasText && rendered.images.isEmpty && rendered.unreadableImages == 0 {
                Text("Empty message")
                    .font(.footnote.italic())
                    .foregroundStyle(quietColor)
                    .accessibilityIdentifier("chat-message-empty")
            }
            if hasText {
                let selectsWhole = isSelecting && !isSingleProse
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(rendered.blocks.enumerated()), id: \.offset) { _, block in
                        blockView(block)
                    }
                }
                .opacity(selectsWhole ? 0 : 1)
                .overlay(alignment: .topLeading) {
                    if selectsWhole, let selection { selectable(rendered.text, selection: selection) }
                }
            }
            images
            if message.isOwn { ownFooter }
        }
        .padding(.horizontal, 13)
        .padding(.top, hasText ? 8 : 12)
        .padding(.bottom, message.isOwn ? 6 : (hasText ? 9 : 12))
        .background(bubbleShape.fill(message.isOwn ? Theme.ownBubble : Theme.surface))
        .overlay(bubbleShape.strokeBorder(failure != nil ? Theme.danger.opacity(0.7) : (message.isOwn ? Color.clear : Theme.separator), lineWidth: 1))
        .contentShape(.contextMenuPreview, bubbleShape)
        .contextMenu {
            if canRetry {
                Button("Try Again", systemImage: "arrow.clockwise") { model.client.retry(message) }
                    .disabled(!model.session.isConnected)
                    .accessibilityLabel("Try again, message not delivered")
            }
            if hasText && !isSelecting {
                Button("Copy", systemImage: "doc.on.doc") { MessageSelection.copy(rendered.text) }
                if let selection {
                    Button("Select Text", systemImage: "character.cursor.ibeam") { selection.begin(message.id) }
                }
            }
            Button("Copy Conversation", systemImage: "text.bubble") {
                UIPasteboard.general.string = MessageRow.transcript(model.session.messages)
                Haptics.impact(.light)
            }
        }
    }

    private var bubbleShape: UnevenRoundedRectangle {
        // The corner nearest the sender tightens when the next bubble is theirs too.
        let tight: CGFloat = 6
        return UnevenRoundedRectangle(
            topLeadingRadius: !message.isOwn && continuesGroup ? tight : Self.radius,
            bottomLeadingRadius: Self.radius,
            bottomTrailingRadius: Self.radius,
            topTrailingRadius: message.isOwn && continuesGroup ? tight : Self.radius,
            style: .continuous
        )
    }

    @ViewBuilder
    private func blockView(_ block: HTMLText.Block) -> some View {
        switch block {
        case .prose(let text):
            if isSingleProse {
                Text(bubbleText(text))
                    .font(.body)
                    .foregroundStyle(textColor)
                    .fixedSize(horizontal: false, vertical: true)
                    .opacity(isSelecting ? 0 : 1)
                    .overlay {
                        if isSelecting, let selection { selectable(text, selection: selection) }
                    }
                    .frame(maxWidth: Self.bubbleWidth, alignment: .leading)
            } else {
                Text(bubbleText(text))
                    .font(.body)
                    .foregroundStyle(textColor)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: Self.bubbleWidth, alignment: .leading)
            }
        case .quote(let text):
            HStack(spacing: 10) {
                Capsule().fill(message.isOwn ? Theme.onOwnBubbleMuted : Theme.accent.opacity(0.7)).frame(width: 3)
                Text(bubbleText(text))
                    .font(.body)
                    .foregroundStyle(quietColor)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: Self.bubbleWidth, alignment: .leading)
        case .code(let code, let language):
            ChatCodeBlock(code: code, language: language, onOwnBubble: message.isOwn)
                .frame(maxWidth: Self.bubbleWidth, alignment: .leading)
        }
    }

    private func selectable(_ text: AttributedString, selection: MessageSelection) -> some View {
        SelectableMessageText(
            text: text,
            color: textColor,
            linkColor: message.isOwn ? Theme.onOwnBubble : Theme.accent,
            touched: { selection.noteTouchInside() },
            finished: { selection.end(message.id) }
        )
    }

    /// Your own messages carry their time and how far they have got.
    private var ownFooter: some View {
        HStack(spacing: 4) {
            Text(message.date, style: .time)
            if let delivery = message.delivery, failure == nil {
                DeliveryMark(delivery: delivery)
            }
        }
        .font(.caption2)
        .foregroundStyle(quietColor)
        .frame(maxWidth: .infinity, alignment: .trailing)
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

    /// The conversation as plain text, one message per paragraph.
    static func transcript(_ messages: [ChatMessage]) -> String {
        messages.filter { !$0.isSystem }.map { message in
            let time = message.date.formatted(date: .numeric, time: .shortened)
            let text = HTMLText.plainText(message.html)
            return "\(message.senderName) · \(time)\n\(text.isEmpty ? "[image]" : text)"
        }.joined(separator: "\n\n")
    }
}

/// A clock while sending, one tick once written to the connection, two once
/// the server confirms it.
struct DeliveryMark: View {
    let delivery: MessageDelivery

    var body: some View {
        Group {
            switch delivery {
            case .sending:
                Image(systemName: "clock")
            case .sent:
                Image(systemName: "checkmark")
            case .delivered:
                HStack(spacing: -5) {
                    Image(systemName: "checkmark")
                    Image(systemName: "checkmark")
                }
            case .failed:
                EmptyView()
            }
        }
        .font(.icon(9, .bold))
        .transition(.scale(scale: 0.5).combined(with: .opacity))
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: delivery)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityIdentifier("chat-delivery")
    }

    private var label: String {
        switch delivery {
        case .sending: return "Sending"
        case .sent: return "Sent"
        case .delivered: return "Delivered to the server"
        case .failed: return "Not delivered"
        }
    }
}

/// A fenced code block: coloured by language, monospaced, scrolls sideways
/// rather than wrapping, under a header with its language, line count, Copy
/// and a fold toggle. Long blocks start folded to their first few lines.
struct ChatCodeBlock: View {
    let code: String
    var language: String?
    var onOwnBubble = false
    @State private var copied = false
    /// Nil until the reader folds or opens it; it then holds their choice.
    @State private var expandedChoice: Bool?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private static let foldOverLines = 12
    private static let previewLines = 8

    private var highlighted: Highlighted { Highlighted.make(code, language: language, onOwnBubble: onOwnBubble) }
    private var isLong: Bool { highlighted.lines > Self.foldOverLines }
    private var expanded: Bool { expandedChoice ?? !isLong }
    private var lineText: String { "\(highlighted.lines) \(highlighted.lines == 1 ? "line" : "lines")" }
    private var fill: Color { onOwnBubble ? Color.black.opacity(Theme.ownCodeShade) : Theme.surfaceSunken }
    private var quiet: Color { onOwnBubble ? Theme.onOwnBubbleMuted : Theme.muted }

    private var previewHeight: CGFloat {
        let font = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
        return font.lineHeight * CGFloat(Self.previewLines) + 10
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if expanded || isLong {
                Rectangle().fill(quiet.opacity(0.18)).frame(height: 1)
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(highlighted.text)
                        .font(.footnote.monospaced())
                        .foregroundStyle(onOwnBubble ? Theme.onOwnBubble : Theme.ink)
                        .fixedSize()
                        .padding(.vertical, 10)
                        .padding(.horizontal, 12)
                }
                .frame(maxHeight: expanded ? nil : previewHeight, alignment: .top)
                .clipped()
                .overlay(alignment: .bottom) {
                    if !expanded {
                        LinearGradient(colors: [.clear, onOwnBubble ? Theme.ownBubble.opacity(0.9) : Theme.surfaceSunken], startPoint: .top, endPoint: .bottom)
                            .frame(height: 36)
                            .allowsHitTesting(false)
                    }
                }
                .transition(.opacity)
                if !expanded {
                    Button { setExpanded(true) } label: {
                        Text("Show all \(highlighted.lines) lines")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(quiet)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("chat-code-show-all")
                }
            }
        }
        .background(fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 0) {
            Button { setExpanded(!expanded) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.icon(10, .bold))
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                    Text(highlighted.label)
                        .foregroundStyle(onOwnBubble ? Theme.onOwnBubble : Theme.body)
                    Text("· \(lineText)")
                }
                .font(.caption2.monospaced().weight(.semibold))
                .foregroundStyle(quiet)
                .lineLimit(1)
                .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                .padding(.leading, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(highlighted.label) code, \(lineText), \(expanded ? "expanded" : "collapsed")")
            .accessibilityHint(expanded ? "Folds the code" : "Shows all the code")
            .accessibilityAction(named: expanded ? "Collapse" : "Expand") { setExpanded(!expanded) }
            .accessibilityIdentifier("chat-code-toggle")
            Button {
                UIPasteboard.general.string = code
                Haptics.impact(.light)
                withAnimation(.snappy) { copied = true }
                Task {
                    try? await Task.sleep(for: .seconds(1.4))
                    withAnimation(.snappy) { copied = false }
                }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.icon(12, .semibold))
                    .contentTransition(.symbolEffect(.replace))
                    .foregroundStyle(copied ? (onOwnBubble ? Theme.onOwnBubble(\.speaking) : Theme.speaking) : quiet)
                    .frame(width: 36, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copied ? "Copied" : "Copy code")
            .accessibilityIdentifier("chat-code-copy")
        }
    }

    private func setExpanded(_ value: Bool) {
        withAnimation(reduceMotion ? nil : .snappy(duration: 0.28)) { expandedChoice = value }
    }

    /// The coloured code, built once per block and kept like HTMLText keeps
    /// its renders. The key includes the theme, since the colours come from it.
    struct Highlighted {
        var text: AttributedString
        var label: String
        var lines: Int

        private final class Box {
            let value: Highlighted
            init(_ value: Highlighted) { self.value = value }
        }

        private static let cache: NSCache<NSString, Box> = {
            let cache = NSCache<NSString, Box>()
            cache.countLimit = 200
            return cache
        }()

        static func make(_ code: String, language: String?, onOwnBubble: Bool) -> Highlighted {
            let key = "\(Theme.style.rawValue)|\(onOwnBubble)|\(language ?? "")|\(code)" as NSString
            if let cached = cache.object(forKey: key) { return cached.value }
            let result = ChatHighlighter.highlight(code, language: language)
            var text = AttributedString()
            for token in result.tokens {
                var run = AttributedString(token.text)
                if let kind = token.kind {
                    run.foregroundColor = color(for: kind, onOwnBubble: onOwnBubble)
                    if kind == .comment { run.font = .footnote.monospaced().italic() }
                }
                text += run
            }
            let lines = code.utf8.reduce(1) { $1 == 10 ? $0 + 1 : $0 } - (code.utf8.last == 10 ? 1 : 0)
            let value = Highlighted(text: text, label: result.language ?? "code", lines: lines)
            cache.setObject(Box(value), forKey: key, cost: code.utf8.count)
            return value
        }

        private static func color(for kind: ChatHighlighter.Kind, onOwnBubble: Bool) -> Color {
            let key: KeyPath<ThemeColors, UInt32>
            switch kind {
            case .keyword: key = \.whisper
            case .string, .inserted: key = \.speaking
            case .number, .type: key = \.warn
            case .property, .variable, .deleted: key = \.danger
            case .comment: return onOwnBubble ? Theme.onOwnBubbleMuted : Theme.muted
            }
            return onOwnBubble ? Theme.onOwnBubble(key) : Theme.color(key)
        }
    }
}
