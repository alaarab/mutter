import Foundation
import Observation
import Security
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

    @ObservationIgnored private let fileURL: URL

    init(directory: URL? = nil) {
        let dir = directory ?? AppDirectories.support
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("servers.json")
        if let data = try? Data(contentsOf: fileURL),
           let list = try? JSONDecoder().decode([SavedServer].self, from: data) {
            servers = list
        }
    }

    var favorites: [SavedServer] {
        servers.filter { $0.isFavorite }.sorted { ($0.lastConnectedAt ?? .distantPast) > ($1.lastConnectedAt ?? .distantPast) }
    }

    var recents: [SavedServer] {
        servers.filter { !$0.isFavorite && $0.lastConnectedAt != nil }
            .sorted { ($0.lastConnectedAt ?? .distantPast) > ($1.lastConnectedAt ?? .distantPast) }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(servers) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }

    func upsert(_ server: SavedServer) {
        if let i = servers.firstIndex(where: { $0.id == server.id }) {
            servers[i] = server
        } else {
            servers.append(server)
        }
        persist()
    }

    func remove(_ server: SavedServer) {
        servers.removeAll { $0.id == server.id }
        status[server.id] = nil
        setPassword(nil, for: server)
        persist()
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

    private func passwordQuery(_ server: SavedServer) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "com.alaarab.mutter.server-password",
            kSecAttrAccount: server.id.uuidString,
        ]
    }

    func password(for server: SavedServer) -> String? {
        var query = passwordQuery(server)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func setPassword(_ password: String?, for server: SavedServer) {
        let query = passwordQuery(server)
        SecItemDelete(query as CFDictionary)
        guard let password, !password.isEmpty else { return }
        var add = query
        add[kSecValueData] = Data(password.utf8)
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
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
