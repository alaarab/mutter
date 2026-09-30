import Foundation

@main struct LiveActivityProbe {
    static func main() {
        let start = Date(timeIntervalSince1970: 1_000_000)
        var freshness = LiveActivityFreshness()
        precondition(freshness.needsKeepAlive(at: start), "Nothing published yet means the first update must go out")
        freshness.recordPublish(at: start)

        let staleDate = freshness.staleDate(publishedAt: start)
        let staleAfter = staleDate.timeIntervalSince(start)
        precondition(staleAfter > LiveActivityFreshness.keepAliveInterval, "The stale date must sit beyond the keep-alive cadence")
        precondition(staleAfter <= LiveActivityFreshness.keepAliveInterval * 3, "A dead session must go stale within a few keep-alive periods")

        precondition(!freshness.shouldPublish(stateChanged: false, at: start.addingTimeInterval(30)), "An unchanged state is not republished before the keep-alive is due")
        precondition(freshness.shouldPublish(stateChanged: true, at: start.addingTimeInterval(1)), "A changed state is always published")
        precondition(freshness.shouldPublish(stateChanged: false, at: start.addingTimeInterval(LiveActivityFreshness.keepAliveInterval)), "An unchanged state is republished once the keep-alive is due")

        let keepAliveTime = start.addingTimeInterval(LiveActivityFreshness.keepAliveInterval)
        freshness.recordPublish(at: keepAliveTime)
        precondition(freshness.staleDate(publishedAt: keepAliveTime) > staleDate, "Each keep-alive pushes the stale date forward")
        precondition(keepAliveTime < staleDate, "A healthy session refreshes before it would go stale")

        freshness.reset()
        precondition(freshness.lastPublishedAt == nil)
        precondition(freshness.needsKeepAlive(at: keepAliveTime))
        print("PASS live activity freshness")
    }
}
