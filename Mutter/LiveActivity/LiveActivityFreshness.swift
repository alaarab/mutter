import Foundation

struct LiveActivityFreshness {
    static let keepAliveInterval: TimeInterval = 60
    static let staleAfter: TimeInterval = 150

    private(set) var lastPublishedAt: Date?

    func staleDate(publishedAt publishDate: Date) -> Date {
        publishDate.addingTimeInterval(Self.staleAfter)
    }

    func needsKeepAlive(at now: Date) -> Bool {
        guard let lastPublishedAt else { return true }
        return now.timeIntervalSince(lastPublishedAt) >= Self.keepAliveInterval
    }

    func shouldPublish(stateChanged: Bool, at now: Date) -> Bool {
        stateChanged || needsKeepAlive(at: now)
    }

    mutating func recordPublish(at publishDate: Date) {
        lastPublishedAt = publishDate
    }

    mutating func reset() {
        lastPublishedAt = nil
    }
}
