#if canImport(Security)
import Foundation
import Security
import CryptoKit

public struct ClientIdentity: Identifiable, Codable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    public var commonName: String
    public var email: String?
    public var createdAt: Date
    public var notAfter: Date?
    public var sha1Fingerprint: String
    public var isImported: Bool

    var keychainLabel: String { "com.alaarab.mutter.identity.\(id.uuidString)" }
}

public final class IdentityStore {
    public static let shared = IdentityStore()

    private let fileURL: URL
    private let lock = NSLock()
    private var cache: [ClientIdentity]

    public init(directory: URL? = nil) {
        let dir = directory ?? AppDirectories.support
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        fileURL = dir.appendingPathComponent("identities.json")
        if let data = try? Data(contentsOf: fileURL),
           let list = try? JSONDecoder().decode([ClientIdentity].self, from: data) {
            cache = list
        } else {
            cache = []
        }
    }

    public var identities: [ClientIdentity] {
        lock.lock()
        defer { lock.unlock() }
        return cache
    }

    private func save() {
        if let data = try? JSONEncoder().encode(cache) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }

    public func create(name: String, commonName: String, email: String?) throws -> ClientIdentity {
        let id = UUID()
        var identity = ClientIdentity(
            id: id, name: name, commonName: commonName, email: email,
            createdAt: Date(), notAfter: nil, sha1Fingerprint: "", isImported: false
        )
        let result = try CertificateGenerator.makeSelfSigned(commonName: commonName, email: email, keyTag: identity.keychainLabel)
        identity.sha1Fingerprint = IdentityStore.sha1Hex(result.der)
        identity.notAfter = DERReader.certificateNotAfter(result.der)

        let addCert: [CFString: Any] = [
            kSecClass: kSecClassCertificate,
            kSecValueRef: result.certificate,
            kSecAttrLabel: identity.keychainLabel,
        ]
        let status = SecItemAdd(addCert as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: Data(identity.keychainLabel.utf8)] as CFDictionary)
            throw CertificateError.keychain(status)
        }

        lock.lock()
        cache.append(identity)
        save()
        lock.unlock()
        return identity
    }

    public func importPKCS12(_ data: Data, password: String, name: String) throws -> ClientIdentity {
        var items: CFArray?
        let options: [CFString: Any] = [kSecImportExportPassphrase: password]
        let status = SecPKCS12Import(data as CFData, options as CFDictionary, &items)
        guard status == errSecSuccess,
              let array = items as? [[String: Any]],
              let first = array.first,
              let identityRef = first[kSecImportItemIdentity as String],
              CFGetTypeID(identityRef as AnyObject) == SecIdentityGetTypeID() else {
            throw CertificateError.importFailed(status)
        }
        let secIdentity = identityRef as! SecIdentity
        var certRef: SecCertificate?
        SecIdentityCopyCertificate(secIdentity, &certRef)
        guard let cert = certRef else { throw CertificateError.importFailed(status) }
        let der = SecCertificateCopyData(cert) as Data
        let id = UUID()
        let summary = (SecCertificateCopySubjectSummary(cert) as String?) ?? name
        let identity = ClientIdentity(
            id: id, name: name, commonName: summary, email: nil,
            createdAt: Date(), notAfter: DERReader.certificateNotAfter(der),
            sha1Fingerprint: IdentityStore.sha1Hex(der), isImported: true
        )
        let add: [CFString: Any] = [
            kSecValueRef: secIdentity,
            kSecAttrLabel: identity.keychainLabel,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess || addStatus == errSecDuplicateItem else {
            throw CertificateError.keychain(addStatus)
        }
        lock.lock()
        cache.append(identity)
        save()
        lock.unlock()
        return identity
    }

    public func rename(_ identity: ClientIdentity, to name: String) {
        lock.lock()
        defer { lock.unlock() }
        guard let index = cache.firstIndex(where: { $0.id == identity.id }) else { return }
        cache[index].name = name
        save()
    }

    public func delete(_ identity: ClientIdentity) {
        if let sec = secIdentity(for: identity) {
            var cert: SecCertificate?
            var key: SecKey?
            SecIdentityCopyCertificate(sec, &cert)
            SecIdentityCopyPrivateKey(sec, &key)
            if let cert { SecItemDelete([kSecClass: kSecClassCertificate, kSecValueRef: cert] as CFDictionary) }
            if let key { SecItemDelete([kSecClass: kSecClassKey, kSecValueRef: key] as CFDictionary) }
        }
        SecItemDelete([kSecClass: kSecClassCertificate, kSecAttrLabel: identity.keychainLabel] as CFDictionary)
        SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: Data(identity.keychainLabel.utf8)] as CFDictionary)
        lock.lock()
        cache.removeAll { $0.id == identity.id }
        save()
        lock.unlock()
    }

    public func secIdentity(for identity: ClientIdentity) -> SecIdentity? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassIdentity,
            kSecAttrLabel: identity.keychainLabel,
            kSecReturnRef: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let result, CFGetTypeID(result) == SecIdentityGetTypeID() else { return nil }
        return (result as! SecIdentity)
    }

    public func certificateDER(for identity: ClientIdentity) -> Data? {
        guard let sec = secIdentity(for: identity) else { return nil }
        var cert: SecCertificate?
        SecIdentityCopyCertificate(sec, &cert)
        guard let cert else { return nil }
        return SecCertificateCopyData(cert) as Data
    }

    static func sha1Hex(_ data: Data) -> String {
        Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
#endif
