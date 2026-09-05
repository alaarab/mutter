import SwiftUI
import MumbleProtocol
import MumbleClient

enum SessionTab: String, CaseIterable, Identifiable {
    case channels, chat, server
    var id: String { rawValue }
    var title: String {
        switch self {
        case .channels: return "Channels"
        case .chat: return "Chat"
        case .server: return "Server"
        }
    }
    var symbol: String {
        switch self {
        case .channels: return "rectangle.3.group"
        case .chat: return "bubble.left.and.bubble.right"
        case .server: return "server.rack"
        }
    }
}

extension ServerSession {
    func permissions(in channelID: UInt32) -> Permissions {
        channels[channelID]?.permissions ?? serverInfo.permissions
    }
}

struct SessionView: View {
    @Environment(AppModel.self) private var model
    @State private var tab: SessionTab = .channels
    @State private var userSheet: SheetID?
    @State private var channelSheet: SheetID?

    private var session: ServerSession { model.session }

    var body: some View {
        VStack(spacing: 0) {
            header
            ShareBanner()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .overlay(alignment: .bottom) {
                    if let toast = model.toast {
                        ToastView(notice: toast)
                            .padding(.bottom, 10)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
            dock
        }
        .background(Theme.background.ignoresSafeArea())
        .animation(.snappy, value: model.toast)
        .sheet(item: $userSheet) { id in UserSheet(sessionID: id.id) }
        .sheet(item: $channelSheet) { id in ChannelSheet(channelID: id.id) }
        .fullScreenCover(isPresented: Binding(
            get: { model.screenShare.watching != nil },
            set: { if !$0 { model.screenShare.stopWatching() } }
        )) { ScreenShareViewer() }
        .onChange(of: tab, initial: true) { _, selected in
            session.isChatVisible = (selected == .chat)
        }
        .onChange(of: model.pendingChatScope) { _, scope in
            if scope != nil { tab = .chat }
        }
        .onDisappear { session.isChatVisible = false }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button { model.isSessionMinimized = true } label: {
                Image(systemName: "chevron.left")
                    .font(.icon(17, .semibold))
                    .frame(width: 36, height: 36)
                    .background(Theme.surfaceElevated, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to servers")

            VStack(alignment: .leading, spacing: 1) {
                Text(model.activeServer?.displayName ?? session.endpoint?.displayString ?? "Server")
                    .font(.display(21))
                    .tracking(-0.3)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    StatusDot(color: stateColor, pulsing: !session.isConnected)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                }
            }
            Spacer()
            if session.isConnected {
                let ping = session.stats.isUsingUDP ? session.stats.udpPingAverageMs : session.stats.tcpPingAverageMs
                Pill(text: ping > 0 ? "\(Int(ping)) ms" : "…", symbol: session.stats.isUsingUDP ? "bolt.fill" : "arrow.triangle.2.circlepath", color: Theme.latencyColor(ping))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.background)
    }

    private var subtitle: String {
        switch session.state {
        case .connected:
            let count = session.users.count
            let ch = session.myChannel?.name ?? ""
            return "\(count) online · in \(ch)"
        case .connecting, .resolving, .authenticating, .synchronizing: return "Connecting…"
        case .reconnecting: return "Reconnecting…"
        case .disconnected: return "Disconnected"
        }
    }

    private var isReconnecting: Bool {
        if case .reconnecting = session.state { return true }
        return false
    }

    private var stateColor: Color {
        switch session.state {
        case .connected: return Theme.speaking
        case .reconnecting: return Theme.danger
        default: return Theme.warning
        }
    }

    @ViewBuilder
    private var content: some View {
        if !session.isConnected {
            VStack(spacing: 14) {
                ProgressView().controlSize(.large)
                Text(isReconnecting ? "Reconnecting…" : "Connecting…")
                    .font(.headline).foregroundStyle(Theme.ink)
                if isReconnecting {
                    Text("Lost the connection. Hang tight.")
                        .font(.subheadline).foregroundStyle(Theme.muted)
                }
                Button("Leave") { model.disconnect() }.buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            switch tab {
            case .channels:
                ChannelTreeView(
                    onUser: { userSheet = SheetID(id: $0.session) },
                    onChannel: { channelSheet = SheetID(id: $0.id) }
                )
            case .chat:
                ChatView(onUser: { userSheet = SheetID(id: $0) })
            case .server:
                ServerInfoView()
            }
        }
    }

    private var dock: some View {
        VStack(spacing: 0) {
            Divider().overlay(Theme.separator)
            VoiceBar()
            HStack(spacing: 0) {
                ForEach(SessionTab.allCases) { item in
                    Button { tab = item } label: {
                        VStack(spacing: 3) {
                            ZStack(alignment: .topTrailing) {
                                Image(systemName: item.symbol)
                                    .font(.icon(20, tab == item ? .semibold : .regular))
                                if item == .chat && session.unreadCount > 0 {
                                    Text(session.unreadCount > 99 ? "99+" : "\(session.unreadCount)")
                                        .font(.ui(10, .bold))
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(Theme.accent, in: Capsule())
                                        .offset(x: 12, y: -8)
                                }
                            }
                            Text(item.title).font(.ui(10, .medium))
                        }
                        .foregroundStyle(tab == item ? Theme.accent : Theme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 2)
        }
        .background(Theme.surface)
    }
}

struct SheetID: Identifiable, Hashable {
    let id: UInt32
}
