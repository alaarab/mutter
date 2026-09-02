import Foundation
import Observation

/// Rolling in-app event log for diagnosing disconnects and audio trouble in the field.
/// Cheap enough to always be on; capped so it can't grow unbounded.
@Observable
final class DiagnosticsLog {
    struct Entry: Identifiable {
        let id = UUID()
        let date: Date
        let tag: String
        let message: String
    }

    static let shared = DiagnosticsLog()

    private(set) var entries: [Entry] = []
    private static let cap = 400

    func add(_ tag: String, _ message: String) {
        Task { @MainActor in
            self.entries.append(Entry(date: Date(), tag: tag, message: message))
            if self.entries.count > Self.cap {
                self.entries.removeFirst(self.entries.count - Self.cap)
            }
        }
    }

    var exportText: String {
        let df = ISO8601DateFormatter()
        return entries.map { "\(df.string(from: $0.date)) [\($0.tag)] \($0.message)" }.joined(separator: "\n")
    }
}
