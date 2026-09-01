#if canImport(Network)
import Foundation
import Network

public struct LANServer: Identifiable, Hashable, Sendable {
    public var id: String { name }
    public var name: String
    public var endpoint: ServerEndpoint?
}

/// Discovers Mumble servers advertising `_mumble._tcp` on the local network via Bonjour.
public final class LANBrowser {
    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "mutter.lan-browser")
    private var resolving: [String: NWConnection] = [:]
    private var found: [String: LANServer] = [:]

    public var onUpdate: (([LANServer]) -> Void)?

    public init() {}

    public func start() {
        stop()
        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjour(type: "_mumble._tcp", domain: nil), using: params)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            self?.handle(results)
        }
        b.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.publish() }
        }
        browser = b
        b.start(queue: queue)
    }

    public func stop() {
        browser?.cancel()
        browser = nil
        for (_, c) in resolving { c.cancel() }
        resolving = [:]
        found = [:]
    }

    private func handle(_ results: Set<NWBrowser.Result>) {
        var seen: Set<String> = []
        for r in results {
            guard case .service(let name, _, _, _) = r.endpoint else { continue }
            seen.insert(name)
            if found[name] == nil {
                found[name] = LANServer(name: name, endpoint: nil)
                resolve(name: name, endpoint: r.endpoint)
            }
        }
        for name in found.keys where !seen.contains(name) {
            found[name] = nil
            resolving[name]?.cancel()
            resolving[name] = nil
        }
        publish()
    }

    /// Bonjour endpoints have to be resolved to host:port before we can show or connect to them.
    private func resolve(name: String, endpoint: NWEndpoint) {
        let c = NWConnection(to: endpoint, using: .tcp)
        resolving[name] = c
        c.stateUpdateHandler = { [weak self, weak c] state in
            guard let self else { return }
            switch state {
            case .ready:
                if let remote = c?.currentPath?.remoteEndpoint, case .hostPort(let host, let port) = remote {
                    let hostString: String
                    switch host {
                    case .ipv4(let a): hostString = "\(a)"
                    case .ipv6(let a): hostString = "\(a)"
                    case .name(let n, _): hostString = n
                    @unknown default: hostString = "\(host)"
                    }
                    self.found[name]?.endpoint = ServerEndpoint(host: hostString, port: port.rawValue)
                }
                c?.cancel()
                self.resolving[name] = nil
                self.publish()
            case .failed, .cancelled:
                self.resolving[name] = nil
            default:
                break
            }
        }
        c.start(queue: queue)
    }

    private func publish() {
        let list = found.values.sorted { $0.name < $1.name }
        DispatchQueue.main.async { [onUpdate] in onUpdate?(list) }
    }
}
#endif
