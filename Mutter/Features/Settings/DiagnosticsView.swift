import SwiftUI

/// Read-only view of the in-app event log, with a share button for sending it along.
struct DiagnosticsView: View {
    private var log: DiagnosticsLog { DiagnosticsLog.shared }

    var body: some View {
        List {
            if log.entries.isEmpty {
                Text("Nothing logged yet. Connection state changes, audio interruptions and route changes show up here.")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
            }
            ForEach(log.entries.reversed()) { entry in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(entry.tag)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(tagColor(entry.tag))
                        Text(entry.date, format: .dateTime.hour().minute().second())
                            .font(.caption2)
                            .foregroundStyle(Theme.muted)
                    }
                    Text(entry.message)
                        .font(.footnote)
                        .foregroundStyle(Theme.ink)
                }
                .listRowBackground(Theme.surface)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                ShareLink(item: log.exportText) { Image(systemName: "square.and.arrow.up") }
                    .disabled(log.entries.isEmpty)
            }
        }
    }

    private func tagColor(_ tag: String) -> Color {
        switch tag {
        case "connection": return Theme.accent
        case "audio": return Theme.speaking
        default: return Theme.muted
        }
    }
}
