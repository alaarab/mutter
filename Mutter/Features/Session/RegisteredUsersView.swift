import SwiftUI
import MumbleProtocol
import MumbleClient

struct RegisteredUsersView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var renaming: RegisteredUser?
    @State private var newName = ""
    @State private var removing: RegisteredUser?
    @State private var search = ""

    private var session: ServerSession { model.session }
    private var canEdit: Bool { session.serverInfo.permissions.contains(.register) || session.serverInfo.permissions.contains(.write) }

    private var users: [RegisteredUser] {
        let query = search.trimmingCharacters(in: .whitespaces)
        let list = session.registeredUsers.sorted { ($0.name ?? "").localizedCaseInsensitiveCompare($1.name ?? "") == .orderedAscending }
        guard !query.isEmpty else { return list }
        return list.filter { ($0.name ?? "").localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            List {
                if session.registeredUsers.isEmpty {
                    HStack { ProgressView().controlSize(.small); Text("Loading…").foregroundStyle(Theme.muted) }
                }
                ForEach(users, id: \.userId) { user in
                    HStack(spacing: 12) {
                        Avatar(name: user.name ?? "?", size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(user.name ?? "#\(user.userId)").foregroundStyle(Theme.ink)
                            HStack(spacing: 6) {
                                if let seen = user.lastSeen, !seen.isEmpty { Text("Last seen \(seen)") }
                                if let ch = user.lastChannel, let name = session.channels[ch]?.name { Text("· \(name)") }
                            }
                            .font(.caption2)
                            .foregroundStyle(Theme.muted)
                        }
                        Spacer()
                        if session.users.values.contains(where: { $0.userID == user.userId }) {
                            StatusDot(color: Theme.speaking)
                        }
                    }
                    .swipeActions {
                        if canEdit {
                            Button(role: .destructive) { removing = user } label: { Label("Remove", systemImage: "trash") }
                            Button { newName = user.name ?? ""; renaming = user } label: { Label("Rename", systemImage: "pencil") }.tint(Theme.accent)
                        }
                    }
                }
            }
            .themedList()
            .searchable(text: $search, prompt: "Find an account")
            .navigationTitle("Registered users")
            .navigationBarTitleDisplayMode(.inline)
            .doneToolbar(dismiss)
            .onAppear { model.client.requestRegisteredUsers() }
            .alert("Rename account", isPresented: Binding(isPresent: $renaming)) {
                TextField("Name", text: $newName)
                Button("Rename") {
                    if let target = renaming { model.client.renameRegisteredUser(id: target.userId, name: newName) }
                    renaming = nil
                }
                Button("Cancel", role: .cancel) { renaming = nil }
            }
            .confirmationDialog("Remove “\(removing?.name ?? "")” from the server’s accounts?", isPresented: Binding(isPresent: $removing), titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    if let target = removing { model.client.removeRegisteredUser(id: target.userId) }
                    removing = nil
                }
            }
        }
    }
}
