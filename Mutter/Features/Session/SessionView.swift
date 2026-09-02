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
    /// Effective permissions in a channel: the queried value if we have it, else the root permissions.
    func permissions(in channelID: UInt32) -> Permissions {
        channels[channelID]?.permissions ?? serverInfo.permissions
    }
}

struct SessionView: View {
    @Environment(AppModel.self) private var model
    @State private var tab: SessionTab = .channels
    @State private var userSheet: SheetID?
    @State private var channelSheet: SheetID?
    @State private var showLeaveConfirm = false

    private var session: ServerSession { model.session }

    var body: some View {
        VStack(spacing: 0) {
            header
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
        .onChange(of: tab, initial: true) { _, new in
            session.isChatVisible = (new == .chat)
        }
        .onChange(of: model.pendingChatScope) { _, scope in
            if scope != nil { tab = .chat }
        }
        .onDisappear { session.isChatVisible = false }
        .confirmationDialog("Leave this server?", isPresented: $showLeaveConfirm, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { model.disconnect() }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 12) {
            Button { showLeaveConfirm = true } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .background(Theme.surfaceElevated, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Leave server")

            VStack(alignment: .leading, spacing: 1) {
                Text(model.activeServer?.displayName ?? session.endpoint?.displayString ?? "Server")
                    .font(.display(20, weight: .medium))
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
                Pill(text: ping > 0 ? "\(Int(ping)) ms" : "…", symbol: session.stats.isUsingUDP ? "bolt.fill" : "arrow.triangle.2.circlepath", color: pingColor(ping))
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
        case .connecting, .resolving: return "Connecting…"
        case .authenticating: return "Authenticating…"
        case .synchronizing: return "Loading channels…"
        case .reconnecting(let n): return "Reconnecting (try \(n))…"
        case .disconnected: return "Disconnected"
        }
    }

    private var stateColor: Color {
        switch session.state {
        case .connected: return Theme.speaking
        case .reconnecting: return Theme.danger
        default: return Theme.warning
        }
    }

    private func pingColor(_ ms: Double) -> Color {
        if ms == 0 { return Theme.muted }
        if ms < 90 { return Theme.speaking }
        if ms < 200 { return Theme.warning }
        return Theme.danger
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if !session.isConnected && session.channels.isEmpty {
            VStack(spacing: 14) {
                ProgressView().controlSize(.large)
                Text(subtitle).font(.subheadline).foregroundStyle(Theme.muted)
                if let error = session.lastError, case .reconnecting = session.state {
                    Text(error.errorDescription ?? "").font(.caption).foregroundStyle(Theme.danger)
                }
                Button("Cancel") { model.disconnect() }.buttonStyle(.bordered)
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

    // MARK: Dock

    private var dock: some View {
        VStack(spacing: 0) {
            Divider().overlay(Theme.separator)
            VoiceBar()
            HStack(spacing: 0) {
                ForEach(SessionTab.allCases) { t in
                    Button { tab = t } label: {
                        VStack(spacing: 3) {
                            ZStack(alignment: .topTrailing) {
                                Image(systemName: t.symbol)
                                    .font(.system(size: 20, weight: tab == t ? .semibold : .regular))
                                if t == .chat && session.unreadCount > 0 {
                                    Text(session.unreadCount > 99 ? "99+" : "\(session.unreadCount)")
                                        .font(.system(size: 10, weight: .bold))
                                        .foregroundStyle(.white)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 1)
                                        .background(Theme.accent, in: Capsule())
                                        .offset(x: 12, y: -8)
                                }
                            }
                            Text(t.title).font(.system(size: 10, weight: .medium))
                        }
                        .foregroundStyle(tab == t ? Theme.accent : Theme.muted)
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

/// Wrapper so a plain session/channel id can drive `.sheet(item:)`.
struct SheetID: Identifiable, Hashable {
    let id: UInt32
}
