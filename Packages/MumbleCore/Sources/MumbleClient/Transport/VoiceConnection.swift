#if canImport(Network)
import Foundation
import Network

/// UDP socket to the server's voice port (same port as the control channel).
final class VoiceConnection {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private var isCancelled = false
    private(set) var isReady = false
    private(set) var packetsSent: UInt32 = 0
    private(set) var bytesIn: UInt64 = 0
    private(set) var bytesOut: UInt64 = 0

    var onDatagram: ((Data) -> Void)?
    var onFailure: ((Error) -> Void)?

    init(endpoint: ServerEndpoint, queue: DispatchQueue) {
        self.queue = queue
        let params = NWParameters.udp
        params.serviceClass = .interactiveVoice
        let port = NWEndpoint.Port(rawValue: endpoint.port) ?? 64738
        connection = NWConnection(host: NWEndpoint.Host(endpoint.host), port: port, using: params)
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, !self.isCancelled else { return }
            switch state {
            case .ready:
                self.isReady = true
                self.receiveLoop()
            case .failed(let error):
                self.isReady = false
                self.onFailure?(error)
            case .cancelled:
                self.isReady = false
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    func send(_ data: Data) {
        guard isReady, !isCancelled else { return }
        packetsSent &+= 1
        bytesOut &+= UInt64(data.count)
        connection.send(content: data, completion: .contentProcessed { _ in })
    }

    func cancel() {
        guard !isCancelled else { return }
        isCancelled = true
        isReady = false
        connection.stateUpdateHandler = nil
        connection.cancel()
    }

    private func receiveLoop() {
        connection.receiveMessage { [weak self] data, _, _, error in
            guard let self, !self.isCancelled else { return }
            if let data, !data.isEmpty {
                self.bytesIn &+= UInt64(data.count)
                self.onDatagram?(data)
            }
            if let error {
                self.onFailure?(error)
                return
            }
            self.receiveLoop()
        }
    }
}
#endif
