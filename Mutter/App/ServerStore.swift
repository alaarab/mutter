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
    @ObservationIgnored private var credentialsLoaded = true

    init(directory: URL? = nil, credentials: any CredentialStore = KeychainCredentials(),
         passwords: any CredentialStore = KeychainCredentials(service: "com.alaarab.mutter.server-password")) {
        self.credentials = credentials
        self.passwords = passwords
        let dir = directory ?? AppDirectories.support
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("servers.json")
        if let data = try? Data(contentsOf: fileURL),
           let list = try? JSONDecoder().decode([SavedServer].self, from: data) {
            servers = list
            credentialsLoaded = false
            do {
                for index in servers.indices {
                    let server = servers[index]
                    let key = "tokens-\(server.id.uuidString)"
                    let saved = try credentials.data(for: key)
                    if let saved {
                        servers[index].tokens = try JSONDecoder().decode([String].self, from: saved)
                    } else if !server.tokens.isEmpty {
                        try credentials.set(JSONEncoder().encode(server.tokens), for: key)
                    }
                }
                credentialsLoaded = true
                persist()
            } catch { storageError = error.localizedDescription }
        }
    }

    var favorites: [SavedServer] {
        servers.filter { $0.isFavorite }.sorted { ($0.lastConnectedAt ?? .distantPast) > ($1.lastConnectedAt ?? .distantPast) }
    }

    var recents: [SavedServer] {
        servers.filter { !$0.isFavorite && $0.lastConnectedAt != nil }
            .sorted { ($0.lastConnectedAt ?? .distantPast) > ($1.lastConnectedAt ?? .distantPast) }
    }

    @discardableResult
    private func persist() -> Bool {
        guard canSaveCredentials else { return false }
        do {
            for server in servers {
                try credentials.set(JSONEncoder().encode(server.tokens), for: "tokens-\(server.id.uuidString)")
            }
            let metadata = servers.map { server in
                var copy = server
                copy.tokens = []
                return copy
            }
            try JSONEncoder().encode(metadata).write(to: fileURL, options: .atomic)
            return true
        } catch { storageError = error.localizedDescription; return false }
    }

    @discardableResult
    func upsert(_ server: SavedServer) -> Bool {
        guard canSaveCredentials else { return false }
        do { try credentials.set(JSONEncoder().encode(server.tokens), for: "tokens-\(server.id.uuidString)") }
        catch { storageError = error.localizedDescription; return false }
        if let i = servers.firstIndex(where: { $0.id == server.id }) {
            servers[i] = server
        } else {
            servers.append(server)
        }
        return persist()
    }

    @discardableResult
    func remove(_ server: SavedServer) -> Bool {
        guard canSaveCredentials else { return false }
        guard setPassword(nil, for: server) else { return false }
        do { try credentials.set(nil, for: "tokens-\(server.id.uuidString)") }
        catch { storageError = error.localizedDescription; return false }
        servers.removeAll { $0.id == server.id }
        status[server.id] = nil
        return persist()
    }

    func server(withID id: UUID) -> SavedServer? {
        servers.first { $0.id == id }
    }

    func server(for endpoint: ServerEndpoint) -> SavedServer? {
        servers.first { $0.host.lowercased() == endpoint.host.lowercased() && $0.port == endpoint.port }
    }

    func markConnected(_ id: UUID) {
        guard let i = servers.firstIndex(where: { $0.id == id }) else { return }
        servers[i].lastConnectedAt = Date()
        persist()
    }

    func setFingerprint(_ fingerprint: Data, for endpoint: ServerEndpoint) {
        for i in servers.indices where servers[i].host.lowercased() == endpoint.host.lowercased() && servers[i].port == endpoint.port {
            servers[i].certificateFingerprint = fingerprint
        }
        persist()
    }

    func password(for server: SavedServer) -> String? {
        do { return try passwords.data(for: server.id.uuidString).flatMap { String(data: $0, encoding: .utf8) } }
        catch { credentialsLoaded = false; storageError = error.localizedDescription; return nil }
    }

    @discardableResult
    func setPassword(_ password: String?, for server: SavedServer) -> Bool {
        guard canSaveCredentials else { return false }
        do {
            try passwords.set(password.flatMap { $0.isEmpty ? nil : Data($0.utf8) }, for: server.id.uuidString)
            return true
        } catch { storageError = error.localizedDescription; return false }
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
