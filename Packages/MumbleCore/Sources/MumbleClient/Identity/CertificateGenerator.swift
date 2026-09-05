#if canImport(Security)
import Foundation
import Security

public enum CertificateError: Error, LocalizedError {
    case keyGeneration(String)
    case signing(String)
    case encoding
    case keychain(OSStatus)
    case importFailed(OSStatus)
    case notFound

    public var errorDescription: String? {
        switch self {
        case .keyGeneration(let reason): return "Couldn't create a key: \(reason)"
        case .signing(let reason): return "Couldn't sign the certificate: \(reason)"
        case .encoding: return "Couldn't encode the certificate."
        case .keychain(let status): return "Keychain error \(status)."
        case .importFailed(let status):
            if status == errSecAuthFailed { return "Wrong password for that certificate file." }
            return "Couldn't import the certificate (error \(status))."
        case .notFound: return "Certificate not found."
        }
    }
}

public enum CertificateGenerator {
    public struct Result {
        public let certificate: SecCertificate
        public let privateKey: SecKey
        public let der: Data
    }

    public static func makeSelfSigned(commonName: String, email: String?, keyTag: String, validYears: Int = 20) throws -> Result {
        let tag = Data(keyTag.utf8)
        var error: Unmanaged<CFError>?
        let attrs: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeRSA,
            kSecAttrKeySizeInBits: 2048,
            kSecPrivateKeyAttrs: [
                kSecAttrIsPermanent: true,
                kSecAttrApplicationTag: tag,
                kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ] as [CFString: Any],
        ]
        guard let privateKey = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
            throw CertificateError.keyGeneration(error?.takeRetainedValue().localizedDescription ?? "unknown")
        }
        guard let publicKey = SecKeyCopyPublicKey(privateKey),
              let pkcs1 = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw CertificateError.keyGeneration("no public key")
        }

        let now = Date()
        let notBefore = now.addingTimeInterval(-60)
        let notAfter = Calendar(identifier: .gregorian).date(byAdding: .year, value: validYears, to: now) ?? now.addingTimeInterval(86400 * 365 * 20)

        var serialBytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, serialBytes.count, &serialBytes)
        serialBytes[0] &= 0x7F

        let sha256WithRSA = DER.sequence([DER.oid("1.2.840.113549.1.1.11"), DER.null])
        let rsaEncryption = DER.sequence([DER.oid("1.2.840.113549.1.1.1"), DER.null])

        var nameParts: [Data] = [DER.attribute(oid: "2.5.4.3", value: DER.utf8String(commonName))]
        if let email, !email.isEmpty {
            nameParts.append(DER.attribute(oid: "1.2.840.113549.1.9.1", value: DER.ia5String(email)))
        }
        let name = DER.sequence(nameParts)

        let spki = DER.sequence([rsaEncryption, DER.bitString(pkcs1)])

        let basicConstraints = DER.sequence([
            DER.oid("2.5.29.19"),
            DER.boolean(true),
            DER.octetString(DER.sequence([])),
        ])
        let keyUsage = DER.sequence([
            DER.oid("2.5.29.15"),
            DER.boolean(true),
            DER.octetString(DER.bitString(Data([0xA0]), unusedBits: 5)),
        ])
        let extKeyUsage = DER.sequence([
            DER.oid("2.5.29.37"),
            DER.octetString(DER.sequence([DER.oid("1.3.6.1.5.5.7.3.2"), DER.oid("1.3.6.1.5.5.7.3.4")])),
        ])
        let extensions = DER.explicit(3, DER.sequence([basicConstraints, keyUsage, extKeyUsage]))

        let tbs = DER.sequence([
            DER.explicit(0, DER.integer(2)),
            DER.integer(unsigned: Data(serialBytes)),
            sha256WithRSA,
            name,
            DER.sequence([DER.time(notBefore), DER.time(notAfter)]),
            name,
            spki,
            extensions,
        ])

        guard let signature = SecKeyCreateSignature(privateKey, .rsaSignatureMessagePKCS1v15SHA256, tbs as CFData, &error) as Data? else {
            throw CertificateError.signing(error?.takeRetainedValue().localizedDescription ?? "unknown")
        }

        let der = DER.sequence([tbs, sha256WithRSA, DER.bitString(signature)])
        guard let cert = SecCertificateCreateWithData(nil, der as CFData) else {
            throw CertificateError.encoding
        }
        return Result(certificate: cert, privateKey: privateKey, der: der)
    }
}
#endif
