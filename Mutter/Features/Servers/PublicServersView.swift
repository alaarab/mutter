import SwiftUI
import MumbleClient

struct PublicServersView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var servers: [PublicServer] = []
    @State private var isLoading = true
    @State private var errorText: String?
    @State private var search = ""
    @State private var selected: PublicServer?
    @State private var pings: [String: ServerPingResult] = [:]

    private var filtered: [PublicServer] {
        let q = search.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return servers }
        return servers.filter {
            $0.name.localizedCaseInsensitiveContains(q) || $0.country.localizedCaseInsensitiveContains(q) || $0.host.localizedCaseInsensitiveContains(q)
        }
    }

    private var grouped: [(String, [PublicServer])] {
        let dict = Dictionary(grouping: filtered) { $0.country.isEmpty ? "Unknown" : $0.country }
        return dict.keys.sorted().map { ($0, dict[$0]!) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading public servers…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorText {
                    EmptyState(symbol: "wifi.exclamationmark", title: "Couldn't load the list", message: errorText)
                } else {
                    List {
                        ForEach(grouped, id: \.0) { country, list in
                            Section {
                                ForEach(list) { server in
                                    Button { selected = server } label: { row(server) }
                                        .task(id: server.id) { await ping(server) }
                                }
                            } header: { SectionLabel(text: country) }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .scrollContentBackground(.hidden)
                    .background(Theme.background)
                    .searchable(text: $search, prompt: "Search by name, country or host")
                }
            }
            .navigationTitle("Public servers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
            .task { await load() }
            .sheet(item: $selected) { server in
                ServerEditView(server: nil, prefillHost: server.host, prefillPort: server.port, prefillName: server.name)
            }
        }
    }

    private func row(_ server: PublicServer) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(server.name).font(.display(17)).foregroundStyle(Theme.ink).lineLimit(1)
                HStack(spacing: 6) {
                    Text(server.endpoint.displayString).lineLimit(1)
                    if !server.region.isEmpty { Text("·"); Text(server.region) }
                }
                .font(.caption)
                .foregroundStyle(Theme.muted)
            }
            Spacer()
            if let p = pings[server.id] {
                Pill(text: "\(p.users)/\(p.maxUsers)", symbol: "person.2.fill", color: p.users > 0 ? Theme.speaking : Theme.muted)
            }
        }
    }

    private func load() async {
        isLoading = true
        do {
            servers = try await PublicServerList.fetch()
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
        isLoading = false
    }

    private func ping(_ server: PublicServer) async {
        guard pings[server.id] == nil else { return }
        if let result = await ServerPinger.ping(server.endpoint, timeout: 2) {
            pings[server.id] = result
        }
    }
}
