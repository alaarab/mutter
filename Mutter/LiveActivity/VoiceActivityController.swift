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

    /// Called once at launch, before any controller exists, to sweep leftovers.
    nonisolated static func endAllOnLaunch() {
        Task { @MainActor in
            for activity in Activity<VoiceActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    func start(serverName: String, state: VoiceActivityAttributes.ContentState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // If we already have one live (e.g. a reconnect), just refresh it instead of stacking.
        if activity != nil {
            update(state)
            return
        }
        endOrphans()
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

    /// Ends every live instance of our activity, including ones left over from a previous app
    /// launch that this controller never tracked — that's what stacks up in the Dynamic Island.
    func endOrphans() {
        for activity in Activity<VoiceActivityAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
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
