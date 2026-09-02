import SwiftUI
import MumbleClient

struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showingAdd = false
    @State private var showingQuickConnect = false
    @State private var showingBrowser = false
    @State private var showingSettings = false
    @State private var editing: SavedServer?
    @State private var lanServers: [LANServer] = []
    @State private var lanBrowser = LANBrowser()

    var body: some View {
        NavigationStack {
            List {
                if let error = model.session.lastError, model.session.state == .disconnected {
                    Section {
                        Label(error.errorDescription ?? "Connection failed", systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(Theme.danger)
                            .font(.subheadline)
                    }
                }

                if model.servers.servers.isEmpty {
                    Section {
                        EmptyState(
                            symbol: "waveform.and.person.filled",
                            title: "No servers yet",
                            message: "Add a Mumble server you know, or browse the public directory."
                        )
                        HStack {
                            Button { showingAdd = true } label: { Label("Add server", systemImage: "plus") }
                                .buttonStyle(.borderedProminent)
                            Button { showingBrowser = true } label: { Label("Browse", systemImage: "globe") }
                                .buttonStyle(.bordered)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .listRowBackground(Color.clear)
                }

                if !model.servers.favorites.isEmpty {
                    Section {
                        ForEach(model.servers.favorites) { server in
                            serverRow(server)
                        }
                    } header: { SectionLabel(text: "Favourites") }
                }

                if !model.servers.recents.isEmpty {
                    Section {
                        ForEach(model.servers.recents) { server in
                            serverRow(server)
                        }
                    } header: { SectionLabel(text: "Recent") }
                }

                if !lanServers.isEmpty {
                    Section {
                        ForEach(lanServers) { lan in
                            Button {
                                guard let endpoint = lan.endpoint else { return }
                                model.quickConnect(host: endpoint.host, port: endpoint.port, username: model.settings.defaultUsername)
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "wifi")
                                        .frame(width: 40, height: 40)
                                        .background(Theme.surfaceElevated, in: RoundedRectangle(cornerRadius: 10))
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(lan.name).font(.display(17)).foregroundStyle(Theme.ink)
                                        Text(lan.endpoint?.displayString ?? "Resolving…").font(.caption).foregroundStyle(Theme.muted)
                                    }
                                    Spacer()
                                }
                            }
                            .disabled(lan.endpoint == nil)
                        }
                    } header: { SectionLabel(text: "On this network") }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("Mutter")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Settings")
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showingBrowser = true } label: { Image(systemName: "globe") }
                        .accessibilityLabel("Public servers")
                    Menu {
                        Button { showingAdd = true } label: { Label("Add server", systemImage: "plus") }
                        Button { showingQuickConnect = true } label: { Label("Quick connect", systemImage: "bolt") }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .refreshable { await model.servers.refreshStatus() }
            .task {
                await model.servers.refreshStatus()
            }
            .onAppear {
                lanBrowser.onUpdate = { lanServers = $0 }
                lanBrowser.start()
            }
            .onDisappear { lanBrowser.stop() }
            .sheet(isPresented: $showingAdd) { ServerEditView(server: nil) }
            .sheet(isPresented: $showingQuickConnect) { QuickConnectSheet() }
            .sheet(isPresented: $showingBrowser) { PublicServersView() }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .sheet(item: $editing) { ServerEditView(server: $0) }
        }
    }

    @ViewBuilder
    private func serverRow(_ server: SavedServer) -> some View {
        let status = model.servers.status[server.id]
        let unreachable = model.servers.unreachable.contains(server.id)
        Button {
            model.connect(server)
        } label: {
            HStack(spacing: 12) {
                Avatar(name: server.displayName, size: 44, color: Theme.color(index: server.accentIndex), rounded: true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(server.displayName)
                        .font(.display(18))
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)
                    Text(server.username.isEmpty ? server.endpoint.displayString : "\(server.endpoint.displayString) · \(server.username)")
                        .font(.caption)
                        .foregroundStyle(Theme.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 8)
                if let status {
                    VStack(alignment: .trailing, spacing: 4) {
                        Spacer(minLength: 0)
                        Pill(text: "\(status.users)/\(status.maxUsers)", symbol: "person.2.fill", color: status.users > 0 ? Theme.speaking : Theme.muted)
                        HStack(spacing: 4) {
                            StatusDot(color: latencyColor(status.latencyMs))
                            Text("\(Int(status.latencyMs)) ms").font(.caption2).foregroundStyle(Theme.muted)
                        }
                    }
                } else if unreachable {
                    Pill(text: "Offline", symbol: "bolt.slash", color: Theme.muted)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .padding(.vertical, 4)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) { model.servers.remove(server) } label: { Label("Delete", systemImage: "trash") }
            Button { editing = server } label: { Label("Edit", systemImage: "pencil") }.tint(Theme.accent)
        }
        .swipeActions(edge: .leading) {
            Button {
                var s = server
                s.isFavorite.toggle()
                model.servers.upsert(s)
            } label: {
                Label(server.isFavorite ? "Unfavourite" : "Favourite", systemImage: server.isFavorite ? "star.slash" : "star")
            }
            .tint(Theme.warning)
        }
        .contextMenu {
            Button { editing = server } label: { Label("Edit", systemImage: "pencil") }
            Button(role: .destructive) { model.servers.remove(server) } label: { Label("Delete", systemImage: "trash") }
        }
    }

    private func latencyColor(_ ms: Double) -> Color {
        if ms < 90 { return Theme.speaking }
        if ms < 200 { return Theme.warning }
        return Theme.danger
    }
}

struct QuickConnectSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var username = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("host or host:port", text: $address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Username", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Connects without saving. You can add it to favourites afterwards.")
                }
            }
            .navigationTitle("Quick connect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") {
                        let (host, port) = parse(address)
                        model.quickConnect(host: host, port: port, username: username)
                        dismiss()
                    }
                    .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { username = model.settings.defaultUsername }
        }
        .presentationDetents([.medium])
    }

    private func parse(_ s: String) -> (String, UInt16) {
        let trimmed = s.trimmingCharacters(in: .whitespaces)
        if let idx = trimmed.lastIndex(of: ":"), !trimmed.contains("]"), trimmed.filter({ $0 == ":" }).count == 1,
           let port = UInt16(trimmed[trimmed.index(after: idx)...]) {
            return (String(trimmed[..<idx]), port)
        }
        return (trimmed, 64738)
    }
}
