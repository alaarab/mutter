import Foundation
import MumbleClient

final class MemoryCredentials: CredentialStore {
    var values: [String: Data] = [:]
    var failReads = false
    var failWrites = false
    var writes = 0
    struct Unavailable: Error {}
    func data(for key: String) throws -> Data? {
        if failReads { throw Unavailable() }
        return values[key]
    }
    func set(_ data: Data?, for key: String) throws {
        if failWrites { throw Unavailable() }
        values[key] = data
        writes += 1
    }
}

@main
struct CredentialProbe {
    static func check(_ condition: @autoclosure () throws -> Bool) throws {
        let result = try condition()
        precondition(result)
    }

    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("servers.json")
        var legacy = SavedServer(name: "Test", host: "example.invalid", username: "Test", tokens: ["legacy-private-token"])
        let original = try JSONEncoder().encode([legacy])
        try original.write(to: file)
        let secrets = MemoryCredentials()
        let passwords = MemoryCredentials()
        let store = ServerStore(directory: directory, credentials: secrets, passwords: passwords)
        try check(store.servers.first?.tokens == legacy.tokens)
        try check(!String(data: try Data(contentsOf: file), encoding: .utf8)!.contains("legacy-private-token"))
        let reopened = ServerStore(directory: directory, credentials: secrets, passwords: passwords)
        try check(reopened.servers.first?.tokens == legacy.tokens)
        try check(secrets.writes == 1)
        reopened.markConnected(legacy.id)
        reopened.setFingerprint(Data([1, 2, 3]), for: legacy.endpoint)
        legacy.name = "Renamed"
        try check(reopened.upsert(legacy))
        try check(secrets.writes == 1)
        legacy.tokens = ["updated-private-token"]
        try check(reopened.upsert(legacy))
        try check(ServerStore(directory: directory, credentials: secrets, passwords: passwords).servers.first?.tokens == legacy.tokens)
        try check(reopened.save(legacy, password: "original-password"))
        passwords.failWrites = true
        try check(!reopened.save(legacy, password: "replacement"))
        passwords.failWrites = false
        try check(reopened.password(for: legacy) == "original-password")
        let secureMetadata = try Data(contentsOf: file)
        let originalServers = reopened.servers
        let originalTokens = secrets.values
        let originalPasswords = passwords.values
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        var changed = legacy
        changed.name = "Unsaved"
        changed.tokens = ["unsaved-token"]
        try check(!reopened.save(changed, password: "unsaved-password"))
        try check(reopened.servers == originalServers)
        try check(secrets.values == originalTokens)
        try check(passwords.values == originalPasswords)
        try check(!reopened.remove(legacy))
        try check(reopened.servers == originalServers)
        try check(secrets.values == originalTokens)
        try check(passwords.values == originalPasswords)
        try FileManager.default.removeItem(at: file)
        let corrupted = Data("broken metadata".utf8)
        try corrupted.write(to: file)
        let damaged = ServerStore(directory: directory, credentials: secrets, passwords: passwords)
        try check(damaged.storageError != nil)
        try check(!damaged.upsert(legacy))
        try check(try Data(contentsOf: file) == corrupted)
        try secureMetadata.write(to: file)
        secrets.failReads = true
        let locked = ServerStore(directory: directory, credentials: secrets, passwords: passwords)
        try check(locked.storageError != nil)
        try check(!locked.upsert(legacy))
        try check(!locked.remove(legacy))
        try check(try Data(contentsOf: file) == secureMetadata)
        secrets.failReads = false
        secrets.values = [:]
        secrets.failWrites = true
        try original.write(to: file)
        let failedMigration = ServerStore(directory: directory, credentials: secrets, passwords: passwords)
        try check(failedMigration.storageError != nil)
        try check(try Data(contentsOf: file) == original)
        let suite = "mutter-test-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set("turn-private-password", forKey: "turnPassword")
        let oldValue = Data(defaults.string(forKey: "turnPassword")!.utf8)
        do {
            _ = try secrets.migrate(oldValue, for: "turnPassword") { defaults.removeObject(forKey: "turnPassword") }
            preconditionFailure("Failed migration was accepted")
        } catch {}
        try check(defaults.string(forKey: "turnPassword") != nil)
        secrets.failWrites = false
        let migrated = try secrets.migrate(oldValue, for: "turnPassword") { defaults.removeObject(forKey: "turnPassword") }
        try check(migrated == oldValue)
        try check(defaults.object(forKey: "turnPassword") == nil)
        try check(try secrets.data(for: "turnPassword") == oldValue)
        print("PASS: credentials migrate, reopen, update, and survive storage failures")
    }
}
