#if canImport(Network)
import Foundation
import Network

public struct LANServer: Identifiable, Hashable, Sendable {
    public var id: String { name }
    public var name: String
    public var endpoint: ServerEndpoint?
}

public final class LANBrowser {
    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "mutter.lan-browser")
    private var resolving: [String: NWConnection] = [:]
    private var found: [String: LANServer] = [:]

    public var onUpdate: (([LANServer]) -> Void)?

    public init() {}

    public func start() {
        stop()
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjour(type: "_mumble._tcp", domain: nil), using: parameters)
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            self?.handle(results)
        }
        browser.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.publish() }
        }
        self.browser = browser
        browser.start(queue: queue)
    }

    public func stop() {
        browser?.cancel()
        browser = nil
        for (_, connection) in resolving { connection.cancel() }
        resolving = [:]
        found = [:]
    }

    private func handle(_ results: Set<NWBrowser.Result>) {
        var seen: Set<String> = []
        for result in results {
            guard case .service(let name, _, _, _) = result.endpoint else { continue }
            seen.insert(name)
            if found[name] == nil {
                found[name] = LANServer(name: name, endpoint: nil)
                resolve(name: name, endpoint: result.endpoint)
            }
        }
        for name in found.keys where !seen.contains(name) {
            found[name] = nil
            resolving[name]?.cancel()
            resolving[name] = nil
        }
        publish()
    }

    private func resolve(name: String, endpoint: NWEndpoint) {
        let connection = NWConnection(to: endpoint, using: .tcp)
        resolving[name] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self else { return }
            switch state {
            case .ready:
                if let remote = connection?.currentPath?.remoteEndpoint, case .hostPort(let host, let port) = remote {
                    self.found[name]?.endpoint = ServerEndpoint(host: Self.hostString(host), port: port.rawValue)
                }
                connection?.cancel()
                self.resolving[name] = nil
                self.publish()
            case .failed, .cancelled:
                self.resolving[name] = nil
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private static func hostString(_ host: NWEndpoint.Host) -> String {
        switch host {
        case .ipv4(let address): return "\(address)"
        case .ipv6(let address): return "\(address)"
        case .name(let name, _): return name
        @unknown default: return "\(host)"
        }
    }

    private func publish() {
        let list = found.values.sorted { $0.name < $1.name }
        DispatchQueue.main.async { [onUpdate] in onUpdate?(list) }
    }
}
#endif
