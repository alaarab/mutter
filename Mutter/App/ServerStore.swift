import Foundation
import Observation
import MumbleClient

struct SavedServer: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var host: String
    var port: UInt16 = 64738
    var username: String
    var identityID: UUID?
    var tokens: [String] = []
    var certificateFingerprint: Data?
    var lastConnectedAt: Date?
    var isFavorite = true
    var accentIndex: Int = Int.random(in: 0..<8)

    var endpoint: ServerEndpoint { ServerEndpoint(host: host, port: port) }

    var displayName: String { name.isEmpty ? host : name }
}

@Observable
final class ServerStore {
    private(set) var servers: [SavedServer] = []
    private(set) var status: [UUID: ServerPingResult] = [:]
    private(set) var unreachable: Set<UUID> = []
    var storageError: String?

    @ObservationIgnored private let fileURL: URL
    @ObservationIgnored private let credentials: any CredentialStore
    @ObservationIgnored private let passwords: any CredentialStore
    @ObservationIgnored private var credentialsLoaded = false

    private struct CredentialChange {
        let store: any CredentialStore
        let key: String
        let data: Data?
    }

    init(directory: URL? = nil, credentials: any CredentialStore = KeychainCredentials(),
         passwords: any CredentialStore = KeychainCredentials(service: "com.alaarab.mutter.server-password")) {
        self.credentials = credentials
        self.passwords = passwords
        let dir = directory ?? AppDirectories.support
        fileURL = dir.appendingPathComponent("servers.json")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: fileURL.path) {
                let data = try Data(contentsOf: fileURL)
                servers = try JSONDecoder().decode([SavedServer].self, from: data)
                let hasLegacyTokens = servers.contains { !$0.tokens.isEmpty }
                for index in servers.indices {
                    let server = servers[index]
                    let key = tokenKey(server.id)
                    let saved = try credentials.data(for: key)
                    if let saved {
                        servers[index].tokens = try JSONDecoder().decode([String].self, from: saved)
                    } else if !server.tokens.isEmpty {
                        try credentials.set(JSONEncoder().encode(server.tokens), for: key)
                    }
                }
                credentialsLoaded = true
                if hasLegacyTokens { persist(servers) }
            } else {
                credentialsLoaded = true
            }
        } catch { storageError = error.localizedDescription }
    }

    var favorites: [SavedServer] {
        servers.filter { $0.isFavorite }.sorted { ($0.lastConnectedAt ?? .distantPast) > ($1.lastConnectedAt ?? .distantPast) }
    }

    var recents: [SavedServer] {
        servers.filter { !$0.isFavorite && $0.lastConnectedAt != nil }
            .sorted { ($0.lastConnectedAt ?? .distantPast) > ($1.lastConnectedAt ?? .distantPast) }
    }

    @discardableResult
    private func persist(_ updated: [SavedServer], changing changes: [CredentialChange] = []) -> Bool {
        guard canSaveCredentials else { return false }
        var applied: [(CredentialChange, Data?)] = []
        do {
            let previous = try changes.map { try $0.store.data(for: $0.key) }
            for (change, oldValue) in zip(changes, previous) {
                try change.store.set(change.data, for: change.key)
                applied.append((change, oldValue))
            }
            let metadata = updated.map { server in
                var copy = server
                copy.tokens = []
                return copy
            }
            try JSONEncoder().encode(metadata).write(to: fileURL, options: .atomic)
            servers = updated
            return true
        } catch {
            for (change, oldValue) in applied.reversed() {
                do { try change.store.set(oldValue, for: change.key) }
                catch { credentialsLoaded = false }
            }
            storageError = credentialsLoaded ? error.localizedDescription
                : "Saved credentials could not be restored. Unlock your device and reopen Mutter before editing them."
            return false
        }
    }

    @discardableResult
    func upsert(_ server: SavedServer) -> Bool {
        update(server)
    }

    @discardableResult
    func save(_ server: SavedServer, password: String) -> Bool {
        update(server, password: passwordChange(password, for: server))
    }

    private func update(_ server: SavedServer, password: CredentialChange? = nil) -> Bool {
        guard canSaveCredentials else { return false }
        var updated = servers
        var changes = password.map { [$0] } ?? []
        if (self.server(withID: server.id)?.tokens ?? []) != server.tokens {
            do {
                changes.append(CredentialChange(store: credentials, key: tokenKey(server.id),
                                                data: try JSONEncoder().encode(server.tokens)))
            }
            catch { storageError = error.localizedDescription; return false }
        }
        if let i = updated.firstIndex(where: { $0.id == server.id }) {
            updated[i] = server
        } else {
            updated.append(server)
        }
        return persist(updated, changing: changes)
    }

    @discardableResult
    func remove(_ server: SavedServer) -> Bool {
        guard canSaveCredentials else { return false }
        guard persist(servers.filter { $0.id != server.id }, changing: [
            passwordChange(nil, for: server),
            CredentialChange(store: credentials, key: tokenKey(server.id), data: nil),
        ]) else { return false }
        status[server.id] = nil
        unreachable.remove(server.id)
        return true
    }

    func server(withID id: UUID) -> SavedServer? {
        servers.first { $0.id == id }
    }

    func server(for endpoint: ServerEndpoint) -> SavedServer? {
        servers.first { $0.host.lowercased() == endpoint.host.lowercased() && $0.port == endpoint.port }
    }

    func markConnected(_ id: UUID) {
        guard let i = servers.firstIndex(where: { $0.id == id }) else { return }
        var updated = servers
        updated[i].lastConnectedAt = Date()
        persist(updated)
    }

    func setFingerprint(_ fingerprint: Data, for endpoint: ServerEndpoint) {
        var updated = servers
        for i in updated.indices where updated[i].host.lowercased() == endpoint.host.lowercased() && updated[i].port == endpoint.port {
            updated[i].certificateFingerprint = fingerprint
        }
        if updated != servers { persist(updated) }
    }

    private func tokenKey(_ id: UUID) -> String { "tokens-\(id.uuidString)" }

    private func passwordChange(_ password: String?, for server: SavedServer) -> CredentialChange {
        CredentialChange(store: passwords, key: server.id.uuidString,
                         data: password.flatMap { $0.isEmpty ? nil : Data($0.utf8) })
    }

    func password(for server: SavedServer) -> String? {
        do { return try passwords.data(for: server.id.uuidString).flatMap { String(data: $0, encoding: .utf8) } }
        catch { credentialsLoaded = false; storageError = error.localizedDescription; return nil }
    }

    private var canSaveCredentials: Bool {
        guard credentialsLoaded else {
            storageError = "Saved credentials could not be read. Unlock your device and reopen Mutter before editing them."
            return false
        }
        return true
    }

    @MainActor
    func refreshStatus() async {
        let list = servers
        await withTaskGroup(of: (UUID, ServerPingResult?).self) { group in
            for server in list {
                group.addTask { (server.id, await ServerPinger.ping(server.endpoint)) }
            }
            for await (id, result) in group {
                if let result {
                    status[id] = result
                    unreachable.remove(id)
                } else {
                    unreachable.insert(id)
                }
            }
        }
    }
}
