import SwiftUI
import MumbleClient

enum ConnectionBannerState: Equatable {
    case hidden
    case reconnecting(attempt: Int)
    case lost(reason: String)

    static func make(state: ConnectionState, wasConnectedThisSession: Bool, lastError: ConnectionError?) -> ConnectionBannerState {
        guard wasConnectedThisSession else { return .hidden }
        switch state {
        case .connected:
            return .hidden
        case .reconnecting(let attempt):
            return .reconnecting(attempt: attempt)
        case .resolving, .connecting, .authenticating, .synchronizing:
            return .reconnecting(attempt: 0)
        case .disconnected:
            return .lost(reason: lastError?.errorDescription ?? "The connection was lost.")
        }
    }
}

struct ConnectionBanner: View {
    @Environment(AppModel.self) private var model

    private var bannerState: ConnectionBannerState {
        ConnectionBannerState.make(
            state: model.session.state,
            wasConnectedThisSession: model.session.wasConnectedThisSession,
            lastError: model.session.lastError
        )
    }

    var body: some View {
        switch bannerState {
        case .hidden:
            EmptyView()
        case .reconnecting(let attempt):
            HStack(spacing: 10) {
                ProgressView().controlSize(.small).tint(Theme.warning)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Reconnecting…")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                    Text(attempt > 1 ? "Still trying · attempt \(attempt)" : "Your chat and channels are kept while Mutter gets back in.")
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Theme.warning.opacity(0.12))
            .overlay(alignment: .bottom) { Divider().overlay(Theme.separator) }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("connection-banner-reconnecting")
            .transition(.move(edge: .top).combined(with: .opacity))
        case .lost(let reason):
            HStack(spacing: 10) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.icon(16, .semibold))
                    .foregroundStyle(Theme.danger)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Connection lost")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.ink)
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Button("Leave") { model.disconnect() }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.muted)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("connection-banner-leave")
                Button("Retry") { model.retryConnection() }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("connection-banner-retry")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
            .background(Theme.danger.opacity(0.12))
            .overlay(alignment: .bottom) { Divider().overlay(Theme.separator) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("connection-banner-lost")
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}
