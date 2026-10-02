import Foundation

struct ICECandidateInit: Codable, Hashable, Sendable {
    var candidate: String
    var sdpMid: String?
    var sdpMLineIndex: Int32?
}

// SDP carries the first candidates. Anything missing from that snapshot must
// follow it as trickle ICE, including TURN allocations that finish later.
@MainActor
final class ICECandidateBatcher {
    let scope = UUID().uuidString
    private var pending: [ICECandidateInit] = []
    private var seen: Set<ICECandidateInit> = []
    private var includedInSDP: Set<String> = []
    private var send: (([ICECandidateInit]) -> Void)?
    private var task: Task<Void, Never>?
    private var cancelled = false

    func add(_ candidate: ICECandidateInit) {
        guard !cancelled, !candidate.candidate.isEmpty,
              candidate.candidate.utf8.count <= 4096, seen.count < 256,
              seen.insert(candidate).inserted,
              !includedInSDP.contains(candidate.candidate) else { return }
        pending.append(candidate)
        schedule()
    }

    func activate(localSDP: String, send: @escaping ([ICECandidateInit]) -> Void) {
        guard !cancelled, self.send == nil else { return }
        includedInSDP = Set(localSDP.components(separatedBy: .newlines)
            .filter { $0.hasPrefix("a=candidate:") }.map { String($0.dropFirst(2)) })
        pending.removeAll { includedInSDP.contains($0.candidate) }
        self.send = send
        schedule()
    }

    func cancel() {
        cancelled = true
        task?.cancel()
        task = nil
        send = nil
        pending.removeAll()
        seen.removeAll()
        includedInSDP.removeAll()
    }

    private func schedule() {
        guard task == nil, send != nil, !pending.isEmpty else { return }
        task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard let self, !Task.isCancelled, !self.cancelled else { return }
            self.task = nil
            let candidates = self.pending
            self.pending.removeAll()
            self.send?(candidates)
        }
    }
}
