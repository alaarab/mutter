import XCTest
@testable import MumbleClient

final class CertificateTrustTests: XCTestCase {
    private var certificate: ServerCertificateInfo {
        ServerCertificateInfo(
            subjectSummary: "voice.example.org",
            sha256Fingerprint: Data([1, 2, 3]),
            sha1Fingerprint: Data(),
            notValidAfter: nil,
            derChain: []
        )
    }

    func testSystemTrustedRenewalAcceptsTheNewFingerprint() {
        XCTAssertNil(CertificateInspector.trustQuestion(
            for: certificate,
            expectedFingerprint: Data([9, 9, 9]),
            systemTrusted: true
        ))
    }

    func testUntrustedChangedCertificateStillAsks() {
        let expected = Data([9, 9, 9])
        guard let question = CertificateInspector.trustQuestion(
            for: certificate,
            expectedFingerprint: expected,
            systemTrusted: false
        ), case .changed(let previous, let actual) = question else {
            XCTFail("An untrusted changed certificate must ask before credentials are sent")
            return
        }
        XCTAssertEqual(previous, expected)
        XCTAssertEqual(actual, certificate)
    }

    func testUntrustedMatchingPinIsAccepted() {
        XCTAssertNil(CertificateInspector.trustQuestion(
            for: certificate,
            expectedFingerprint: certificate.sha256Fingerprint,
            systemTrusted: false
        ))
    }

    func testUntrustedFirstContactStillAsks() {
        guard let question = CertificateInspector.trustQuestion(
            for: certificate,
            expectedFingerprint: nil,
            systemTrusted: false
        ), case .firstContact(let actual) = question else {
            XCTFail("An untrusted first contact must ask before credentials are sent")
            return
        }
        XCTAssertEqual(actual, certificate)
    }
}
