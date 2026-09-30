import Foundation
import MumbleClient
import Darwin

@main struct ClientProbe {
    @MainActor static func main() async throws {
        setbuf(stdout, nil)
        let scenario = CommandLine.arguments[2]
        let client = MumbleClient()
        var options = ConnectionOptions(username: "NativeReview")
        options.autoReconnect = scenario != "no-retry" && scenario != "retry"
        client.connect(to: ServerEndpoint(host: "127.0.0.1", port: UInt16(CommandLine.arguments[1])!), options: options)
        let deadline = Date().addingTimeInterval(25)
        var last = ""
        var connections = 0
        var highestAttempt = 0
        var channelCountBeforeDrop = 0
        var sessionBeforeDrop: UInt32?
        var messageCountBeforeDrop = 0
        var retried = false
        var sawRosterKept = false
        while Date() < deadline {
            let state = client.session.state
            let label = String(describing: state)
            if label != last {
                last = label
                print("STATE \(label)")
                if case .reconnecting(let attempt) = state {
                    highestAttempt = max(highestAttempt, attempt)
                    if scenario == "roster" {
                        precondition(client.session.wasConnectedThisSession)
                        precondition(client.session.channels.count == channelCountBeforeDrop, "The channel tree stays on screen while reconnecting")
                        precondition(client.session.me != nil, "The user list stays on screen while reconnecting")
                        sawRosterKept = true
                    }
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
                    if connections == 1 {
                        channelCountBeforeDrop = client.session.channels.count
                        sessionBeforeDrop = client.session.mySession
                        messageCountBeforeDrop = client.session.messages.count
                        precondition(channelCountBeforeDrop > 0)
                    }
                    if connections == 2 && scenario == "roster" {
                        precondition(sawRosterKept, "The probe never saw the reconnecting state")
                        precondition(client.session.users.count == 1, "Stale users are replaced by the server's fresh roster")
                        precondition(client.session.me != nil)
                        if let old = sessionBeforeDrop, old != client.session.mySession {
                            precondition(client.session.users[old] == nil, "The old session is gone after the resync")
                        }
                        client.disconnect()
                        print("PASS roster kept and replaced")
                        return
                    }
                    if connections == 2 && scenario == "retry" {
                        precondition(retried)
                        precondition(client.session.messages.count >= messageCountBeforeDrop, "A manual retry keeps the chat")
                        precondition(client.session.lastError == nil)
                        client.disconnect()
                        print("PASS retry")
                        return
                    }
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
                if state == .disconnected && connections == 1 && scenario == "retry" && !retried {
                    precondition(client.session.wasConnectedThisSession)
                    precondition(client.session.lastError != nil)
                    precondition(client.session.channels.count == channelCountBeforeDrop, "A lost session keeps its channels on screen")
                    retried = true
                    client.retryConnection()
                    try await Task.sleep(nanoseconds: 25_000_000)
                    continue
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
