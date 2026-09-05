import ActivityKit
import Foundation

@MainActor
final class VoiceActivityController {
    private var activity: Activity<VoiceActivityAttributes>?
    private var lastState: VoiceActivityAttributes.ContentState?
    private var pending: Task<Void, Never>?

    var isActive: Bool { activity != nil }

    nonisolated static func endAllOnLaunch() {
        Task { @MainActor in await endAll() }
    }

    static func endAll() async {
        for activity in Activity<VoiceActivityAttributes>.activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func start(serverName: String, state: VoiceActivityAttributes.ContentState) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        if activity != nil {
            update(state)
            return
        }
        Task { await Self.endAll() }
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
