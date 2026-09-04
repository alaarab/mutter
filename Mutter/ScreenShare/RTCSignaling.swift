import Foundation
import Compression
import MumbleClient
import MumbleProtocol

// Screen-share signaling over Mumble's plugin-data channel. Byte-for-byte the format in
// docs/screen-share.md, which Mutter Web implements in web/src/rtcsignal.js:
//
//   dataId "mutter/rtc"; data = [version=1][msgId][index][count][flags] + fragment (≤990 bytes)
//   flags bit 0: payload is raw deflate. Payload is the UTF-8 JSON of one SignalMessage.
//
// The server caps each message at 1000 bytes and rate-limits per client (burst 15, then 4/s,
// dropping silently), so sends go through a token bucket that stays under that.

enum RTCSignal {
    static let dataId = "mutter/rtc"
    static let version: UInt8 = 1
    static let fragmentSize = 990
    static let compressFrom = 160
    static let reassemblyTimeout: TimeInterval = 10
}

/// One signaling message. `t` selects the kind; the other fields are used per kind.
struct SignalMessage: Codable {
    var t: String
    var id: String
    var title: String?
    var w: Int?
    var h: Int?
    var audio: Bool?
    var sdp: String?
    var c: [ICECandidateInit]?

    static func watch(_ id: String) -> SignalMessage { SignalMessage(t: "watch", id: id) }
    static func leave(_ id: String) -> SignalMessage { SignalMessage(t: "leave", id: id) }
    static func answer(_ id: String, sdp: String) -> SignalMessage { SignalMessage(t: "answer", id: id, sdp: sdp) }
}

struct ICECandidateInit: Codable {
    var candidate: String
    var sdpMid: String?
    var sdpMLineIndex: Int32?
}

// MARK: - Fragmentation

struct SignalFragmenter {
    private var nextMsgId: UInt8 = 0

    mutating func fragments(for message: SignalMessage) throws -> [Data] {
        var payload = try JSONEncoder().encode(message)
        var flags: UInt8 = 0
        if payload.count >= RTCSignal.compressFrom, let z = Deflate.compress(payload), z.count < payload.count {
            payload = z
            flags |= 1
        }
        let count = max(1, (payload.count + RTCSignal.fragmentSize - 1) / RTCSignal.fragmentSize)
        guard count <= 255 else { throw SignalError.tooLarge }
        let id = nextMsgId
        nextMsgId &+= 1
        return (0..<count).map { i in
            var d = Data([RTCSignal.version, id, UInt8(i), UInt8(count), flags])
            let lo = i * RTCSignal.fragmentSize
            d.append(payload.subdata(in: lo..<min(payload.count, lo + RTCSignal.fragmentSize)))
            return d
        }
    }
}

enum SignalError: Error { case tooLarge }

final class SignalReassembler {
    private struct Key: Hashable { let sender: UInt32; let msgId: UInt8 }
    private struct Partial { var parts: [Int: Data]; let count: Int; let flags: UInt8; let started: Date }
    private var pending: [Key: Partial] = [:]

    /// Feed one plugin-data payload; returns the message once every fragment has arrived.
    func receive(from sender: UInt32, data: Data) -> SignalMessage? {
        guard data.count >= 5, data[data.startIndex] == RTCSignal.version else { return nil }
        let now = Date()
        pending = pending.filter { now.timeIntervalSince($0.value.started) < RTCSignal.reassemblyTimeout }
        let b = data.startIndex
        let key = Key(sender: sender, msgId: data[b + 1])
        let index = Int(data[b + 2]), count = Int(data[b + 3]), flags = data[b + 4]
        guard count >= 1, index < count else { return nil }
        var partial = pending[key] ?? Partial(parts: [:], count: count, flags: flags, started: now)
        partial.parts[index] = data.subdata(in: (b + 5)..<data.endIndex)
        if partial.parts.count < count { pending[key] = partial; return nil }
        pending[key] = nil
        var payload = Data()
        for i in 0..<count { guard let part = partial.parts[i] else { return nil }; payload.append(part) }
        if flags & 1 != 0 {
            guard let inflated = Deflate.decompress(payload) else { return nil }
            payload = inflated
        }
        return try? JSONDecoder().decode(SignalMessage.self, from: payload)
    }
}

/// Raw deflate (RFC 1951). On Apple platforms COMPRESSION_ZLIB is exactly that — no zlib header.
enum Deflate {
    static func compress(_ data: Data) -> Data? {
        data.withUnsafeBytes { src -> Data? in
            guard let base = src.bindMemory(to: UInt8.self).baseAddress else { return nil }
            let cap = data.count + 64
            let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: cap)
            defer { dst.deallocate() }
            let n = compression_encode_buffer(dst, cap, base, data.count, nil, COMPRESSION_ZLIB)
            return n > 0 ? Data(bytes: dst, count: n) : nil
        }
    }

    static func decompress(_ data: Data) -> Data? {
        var cap = max(4096, data.count * 8)
        while cap <= (1 << 22) {
            let out: Data? = data.withUnsafeBytes { src in
                guard let base = src.bindMemory(to: UInt8.self).baseAddress else { return nil }
                let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: cap)
                defer { dst.deallocate() }
                let n = compression_decode_buffer(dst, cap, base, data.count, nil, COMPRESSION_ZLIB)
                return (n > 0 && n < cap) ? Data(bytes: dst, count: n) : nil   // n == cap: buffer too small
            }
            if let out { return out }
            cap *= 4
        }
        return nil
    }
}

// MARK: - Rate-limited sending

/// Feeds fragments to the client under the server's leaky bucket (we use burst 12, 3/s — a
/// little inside its 15 / 4/s) so nothing is ever dropped without us knowing.
@MainActor
final class SignalSender {
    private let client: MumbleClient
    private var fragmenter = SignalFragmenter()
    private var tokens = 12.0
    private var lastRefill = Date()
    private var queue: [(receivers: [UInt32], data: Data)] = []
    private var drainTask: Task<Void, Never>?

    init(client: MumbleClient) { self.client = client }

    func send(_ message: SignalMessage, to receivers: [UInt32]) {
        guard !receivers.isEmpty, let frags = try? fragmenter.fragments(for: message) else { return }
        for f in frags { queue.append((receivers, f)) }
        drain()
    }

    func reset() { queue.removeAll(); drainTask?.cancel(); drainTask = nil; tokens = 12 }

    private func drain() {
        let now = Date()
        tokens = min(12, tokens + now.timeIntervalSince(lastRefill) * 3)
        lastRefill = now
        while tokens >= 1, !queue.isEmpty {
            let item = queue.removeFirst()
            client.sendPluginData(to: item.receivers, dataId: RTCSignal.dataId, data: item.data)
            tokens -= 1
        }
        guard !queue.isEmpty, drainTask == nil else { return }
        drainTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard let self, !Task.isCancelled else { return }
            self.drainTask = nil
            self.drain()
        }
    }
}
