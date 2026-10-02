import Foundation

@main
struct ICECandidateProbe {
    @MainActor
    static func main() async throws {
        func candidate(_ name: String) -> ICECandidateInit {
            ICECandidateInit(candidate: "candidate:\(name) 1 udp 1 127.0.0.1 1234 typ host", sdpMid: "0", sdpMLineIndex: 0)
        }
        func pause() async throws { try await Task.sleep(nanoseconds: 250_000_000) }

        let early = candidate("early")
        let racing = candidate("not-in-sdp-snapshot")
        let late = candidate("late-relay")
        let batcher = ICECandidateBatcher()
        var batches: [[ICECandidateInit]] = []
        batcher.add(early)
        batcher.add(racing)
        try await pause()
        precondition(batches.isEmpty)
        batcher.activate(localSDP: "v=0\r\na=\(early.candidate)\r\n") { batches.append($0) }
        batcher.add(early) // A delegate callback may arrive after SDP was sent.
        batcher.add(late)
        batcher.add(late)
        try await pause()
        precondition(batches == [[racing, late]])

        batcher.add(candidate("cancelled"))
        batcher.cancel()
        batcher.add(candidate("closed-peer"))
        try await pause()
        precondition(batches.count == 1)

        let replacement = ICECandidateBatcher()
        precondition(replacement.scope != batcher.scope)
        replacement.activate(localSDP: "v=0\r\n") { batches.append($0) }
        replacement.add(late)
        try await pause()
        precondition(batches == [[racing, late], [late]])
        replacement.cancel()

        let bounded = ICECandidateBatcher()
        bounded.add(ICECandidateInit(candidate: String(repeating: "a", count: 4097)))
        for index in 0..<1000 { bounded.add(candidate("\(index)")) }
        bounded.activate(localSDP: "") { batches.append($0) }
        try await pause()
        precondition(batches.last?.count == 256)
        bounded.cancel()
        print("PASS: late ICE, SDP ordering, batching, deduplication, cancellation, replacement and memory limits")
    }
}
