import ActivityKit
import Foundation

@MainActor
final class VoiceActivityController {
    private var activity: Activity<VoiceActivityAttributes>?
    private var lastState: VoiceActivityAttributes.ContentState?
    private var pending: Task<Void, Never>?
    private var freshness = LiveActivityFreshness()

    var isActive: Bool { activity != nil }

    nonisolated static func endAllOnLaunch() {
        let activitiesFromEarlierLaunches = Activity<VoiceActivityAttributes>.activities
        Task { @MainActor in await end(activitiesFromEarlierLaunches) }
    }

    private static func end(_ activities: [Activity<VoiceActivityAttributes>]) async {
        for activity in activities {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    func start(serverName: String, state: VoiceActivityAttributes.ContentState, now: Date = Date()) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        if activity != nil {
            update(state, now: now)
            return
        }
        let leftoverActivities = Activity<VoiceActivityAttributes>.activities
        do {
            activity = try Activity.request(
                attributes: VoiceActivityAttributes(serverName: serverName),
                content: ActivityContent(state: state, staleDate: freshness.staleDate(publishedAt: now)),
                pushType: nil
            )
            lastState = state
            freshness.recordPublish(at: now)
        } catch {
            activity = nil
        }
        Task { await Self.end(leftoverActivities) }
    }

    func update(_ state: VoiceActivityAttributes.ContentState, now: Date = Date()) {
        guard let activity else { return }
        let stateChanged = state != lastState
        guard freshness.shouldPublish(stateChanged: stateChanged, at: now) else { return }
        lastState = state
        freshness.recordPublish(at: now)
        let content = ActivityContent(state: state, staleDate: freshness.staleDate(publishedAt: now))
        pending?.cancel()
        pending = Task {
            if stateChanged {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
            }
            await activity.update(content)
        }
    }

    func end() {
        pending?.cancel()
        freshness.reset()
        guard let current = activity else { return }
        activity = nil
        lastState = nil
        Task {
            await current.end(nil, dismissalPolicy: .immediate)
        }
    }
}
