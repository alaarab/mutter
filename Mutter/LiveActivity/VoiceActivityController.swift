import ActivityKit
import Foundation

/// Owns the Live Activity that mirrors the voice session on the lock screen and Dynamic Island.
/// Updates are coalesced (300 ms) so rapid speaking changes don't burn the system budget.
@MainActor
final class VoiceActivityController {
    private var activity: Activity<VoiceActivityAttributes>?
    private var lastState: VoiceActivityAttributes.ContentState?
    private var pending: Task<Void, Never>?

    var isActive: Bool { activity != nil }

    func start(serverName: String, state: VoiceActivityAttributes.ContentState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        end()
        do {
            activity = try Activity.request(
                attributes: VoiceActivityAttributes(serverName: serverName),
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil
            )
            lastState = state
        } catch {
            activity = nil
        }
    }

    func update(_ state: VoiceActivityAttributes.ContentState) {
        guard let activity, state != lastState else { return }
        lastState = state
        pending?.cancel()
        pending = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }
    }

    func end() {
        pending?.cancel()
        guard let current = activity else { return }
        activity = nil
        lastState = nil
        Task {
            await current.end(nil, dismissalPolicy: .immediate)
        }
    }
}
