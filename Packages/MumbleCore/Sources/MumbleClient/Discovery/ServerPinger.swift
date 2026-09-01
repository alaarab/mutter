#if canImport(Network)
import Foundation
import Network
import MumbleProtocol

public struct ServerPingResult: Hashable, Sendable {
    public var version: ProtocolVersion
    public var users: UInt32
    public var maxUsers: UInt32
    public var bandwidth: UInt32
    public var latencyMs: Double
}

/// Sends the unencrypted UDP probe that Mumble servers answer with user counts and version.
/// Used by the server list so favourites show live occupancy and latency.
public enum ServerPinger {

    public static func ping(_ endpoint: ServerEndpoint, timeout: TimeInterval = 2.5) async -> ServerPingResult? {
        await withCheckedContinuation { continuation in
            let queue = DispatchQueue(label: "mutter.ping.\(endpoint.host)")
            let port = NWEndpoint.Port(rawValue: endpoint.port) ?? 64738
            let params = NWParameters.udp
            let connection = NWConnection(host: NWEndpoint.Host(endpoint.host), port: port, using: params)
            let ident = UInt64.random(in: 1...UInt64.max)
            var finished = false
            var sentAt = DispatchTime.now()

            func finish(_ result: ServerPingResult?) {
                guard !finished else { return }
                finished = true
                connection.cancel()
                continuation.resume(returning: result)
            }

            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    sentAt = DispatchTime.now()
                    connection.send(content: ServerProbe.request(identifier: ident), completion: .contentProcessed { _ in })
                    connection.receiveMessage { data, _, _, _ in
                        guard let data, let resp = ServerProbe.parse(data), resp.identifier == ident else {
                            finish(nil)
                            return
                        }
                        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - sentAt.uptimeNanoseconds) / 1_000_000
                        finish(ServerPingResult(
                            version: resp.version,
                            users: resp.users,
                            maxUsers: resp.maxUsers,
                            bandwidth: resp.bandwidth,
                            latencyMs: elapsed
                        ))
                    }
                case .failed, .cancelled:
                    finish(nil)
                default:
                    break
                }
            }
            queue.asyncAfter(deadline: .now() + timeout) { finish(nil) }
            connection.start(queue: queue)
        }
    }
}
#endif
