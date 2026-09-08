#if canImport(Security)
import Foundation
import Security

public protocol CredentialStore {
    func data(for key: String) throws -> Data?
    func set(_ data: Data?, for key: String) throws
}

public extension CredentialStore {
    func migrate(_ legacy: Data?, for key: String, removeLegacy: () throws -> Void) throws -> Data? {
        let saved = try data(for: key)
        if let legacy {
            if saved == nil { try set(legacy, for: key) }
            try removeLegacy()
        }
        return saved ?? legacy
    }
}

public struct KeychainCredentials: CredentialStore {
    private let service: String

    public init(service: String = "com.alaarab.mutter.credentials") {
        self.service = service
    }

    private func query(_ key: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: key]
    }

    public func data(for key: String) throws -> Data? {
        var query = query(key)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw Failure(status: status) }
        return data
    }

    public func set(_ data: Data?, for key: String) throws {
        let query = query(key)
        guard let data else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
            return
        }
        let attributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let inserted = SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil)
            guard inserted == errSecSuccess else { throw Failure(status: inserted) }
        } else if status != errSecSuccess {
            throw Failure(status: status)
        }
    }

    private struct Failure: LocalizedError {
        let status: OSStatus
        var errorDescription: String? {
            if status == errSecMissingEntitlement {
                return "This build cannot access secure storage. Reinstall a signed build of Mutter."
            }
            return "Secure storage is unavailable (\(status)). Unlock your device and try again."
        }
    }
}
#endif
