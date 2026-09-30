import Foundation
import MumbleClient
import Darwin

@main struct ClientProbe {
    @MainActor static func main() async throws {
        setbuf(stdout, nil)
        let scenario = CommandLine.arguments[2]
        let client = MumbleClient()
        var options = ConnectionOptions(username: "NativeReview")
        options.autoReconnect = scenario != "no-retry"
        client.connect(to: ServerEndpoint(host: "127.0.0.1", port: UInt16(CommandLine.arguments[1])!), options: options)
        let deadline = Date().addingTimeInterval(25)
        var last = ""
        var connections = 0
        var highestAttempt = 0
        while Date() < deadline {
            let state = client.session.state
            let label = String(describing: state)
            if label != last {
                last = label
                print("STATE \(label)")
                if case .reconnecting(let attempt) = state {
                    highestAttempt = max(highestAttempt, attempt)
                    if scenario == "cancel" {
                        client.disconnect()
                        try await Task.sleep(nanoseconds: 3_000_000_000)
                        precondition(client.session.state == .disconnected)
                        print("PASS cancellation")
                        return
                    }
                }
                if state == .connected {
                    connections += 1
                    if connections == 2 {
                        if scenario == "mute" {
                            precondition(highestAttempt >= 1)
                            try await waitUntilSelfMuted(client)
                            client.disconnect()
                            print("PASS mute restored")
                            return
                        }
                        precondition(highestAttempt >= 2)
                        if scenario == "username" { precondition(client.session.me?.name == "NativeReview2") }
                        client.disconnect()
                        print("PASS recovery")
                        return
                    }
                    if scenario == "mute" {
                        client.setSelfMute(true)
                        try await waitUntilSelfMuted(client)
                    }
                    print("CONNECTED")
                }
                if state == .disconnected && connections == 1 {
                    precondition(scenario == "no-retry", "Reconnect stopped before the server recovered")
                    precondition(highestAttempt == 0)
                    print("PASS no retry")
                    return
                }
            }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        fatalError("Timed out waiting for native reconnect")
    }

    @MainActor static func waitUntilSelfMuted(_ client: MumbleClient) async throws {
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if client.session.me?.isSelfMuted == true { return }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        fatalError("The server never saw this client as self-muted")
    }
}
