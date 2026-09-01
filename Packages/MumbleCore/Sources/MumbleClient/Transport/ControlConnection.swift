#if canImport(Network)
import Foundation
import Network
import Security
import CryptoKit
import MumbleProtocol

/// TLS control channel to a Mumble server, built on Network.framework.
/// All callbacks are delivered on the queue passed to `init`.
final class ControlConnection {
    enum Event {
        case ready
        case frame(ControlFrame)
        case failed(Error)
        case closed
    }

    /// Called during the TLS handshake with the server's certificate. The handler must call the
    /// completion exactly once; it may do so asynchronously (after asking the user).
    typealias VerifyHandler = (SecTrust, ServerCertificateInfo, @escaping (Bool) -> Void) -> Void

    private let connection: NWConnection
    private let queue: DispatchQueue
    private var parser = ControlFrameParser()
    private var isCancelled = false
    private(set) var bytesIn: UInt64 = 0
    private(set) var bytesOut: UInt64 = 0
    var onEvent: ((Event) -> Void)?

    init(endpoint: ServerEndpoint, identity: SecIdentity?, queue: DispatchQueue, verify: @escaping VerifyHandler) {
        self.queue = queue

        let tls = NWProtocolTLS.Options()
        let sec = tls.securityProtocolOptions
        sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv12)
        sec_protocol_options_set_tls_server_name(sec, endpoint.host)
        if let identity, let secIdentity = sec_identity_create(identity) {
            sec_protocol_options_set_local_identity(sec, secIdentity)
        }
        sec_protocol_options_set_verify_block(sec, { _, secTrust, complete in
            let trust = sec_trust_copy_ref(secTrust).takeRetainedValue()
            let info = CertificateInspector.info(from: trust)
            verify(trust, info) { ok in complete(ok) }
        }, queue)

        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = 15
        tcp.enableKeepalive = true
        tcp.keepaliveIdle = 20

        let params = NWParameters(tls: tls, tcp: tcp)
        params.serviceClass = .responsiveData

        let port = NWEndpoint.Port(rawValue: endpoint.port) ?? 64738
        connection = NWConnection(host: NWEndpoint.Host(endpoint.host), port: port, using: params)
    }

    var remoteEndpoint: NWEndpoint? { connection.currentPath?.remoteEndpoint }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, !self.isCancelled else { return }
            switch state {
            case .ready:
                self.onEvent?(.ready)
                self.receiveLoop()
            case .failed(let error):
                self.onEvent?(.failed(error))
            case .waiting(let error):
                // Waiting means no viable path yet (e.g. airplane mode). Treat prolonged waits as failure.
                self.onEvent?(.failed(error))
            case .cancelled:
                self.onEvent?(.closed)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    func send(_ data: Data) {
        guard !isCancelled else { return }
        bytesOut &+= UInt64(data.count)
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            if let error, let self, !self.isCancelled {
                self.onEvent?(.failed(error))
            }
        })
    }

    func cancel() {
        guard !isCancelled else { return }
        isCancelled = true
        connection.stateUpdateHandler = nil
        connection.cancel()
    }

    private func receiveLoop() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self] data, _, isComplete, error in
            guard let self, !self.isCancelled else { return }
            if let data, !data.isEmpty {
                self.bytesIn &+= UInt64(data.count)
                self.parser.append(data)
                do {
                    while let frame = try self.parser.nextFrame() {
                        self.onEvent?(.frame(frame))
                    }
                } catch {
                    self.onEvent?(.failed(error))
                    self.cancel()
                    return
                }
            }
            if let error {
                self.onEvent?(.failed(error))
                return
            }
            if isComplete {
                self.onEvent?(.closed)
                return
            }
            self.receiveLoop()
        }
    }
}

enum CertificateInspector {
    static func info(from trust: SecTrust) -> ServerCertificateInfo {
        let chain = (SecTrustCopyCertificateChain(trust) as? [SecCertificate]) ?? []
        let ders = chain.map { SecCertificateCopyData($0) as Data }
        let leaf = ders.first ?? Data()
        let sha256 = Data(SHA256.hash(data: leaf))
        let sha1 = Data(Insecure.SHA1.hash(data: leaf))
        let summary = chain.first.flatMap { SecCertificateCopySubjectSummary($0) as String? } ?? "Unknown"
        let notAfter = DERReader.certificateNotAfter(leaf)
        return ServerCertificateInfo(
            subjectSummary: summary,
            sha256Fingerprint: sha256,
            sha1Fingerprint: sha1,
            notValidAfter: notAfter,
            derChain: ders
        )
    }

    /// True when the system trust store (or a user-installed profile) already trusts this chain.
    static func isSystemTrusted(_ trust: SecTrust) -> Bool {
        var error: CFError?
        return SecTrustEvaluateWithError(trust, &error)
    }
}
#endif
