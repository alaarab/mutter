import Foundation
import Compression
import MumbleClient
import MumbleProtocol

enum RTCSignal {
    static let dataId = "mutter/rtc"
    static let version: UInt8 = 1
    static let headerSize = 5
    static let fragmentSize = 990
    static let compressFrom = 160
    static let maxFragments = 255
    static let reassemblyTimeout: TimeInterval = 10
    static let deflateFlag: UInt8 = 1
}

enum SignalKind: String, Codable {
    case announce, stop, watch, offer, answer, ice, leave
}

struct SignalMessage: Codable {
    var kind: SignalKind
    var id: String
    var title: String?
    var width: Int?
    var height: Int?
    var audio: Bool?
    var sdp: String?
    var candidates: [ICECandidateInit]?

    enum CodingKeys: String, CodingKey {
        case kind = "t"
        case id
        case title
        case width = "w"
        case height = "h"
        case audio
        case sdp
        case candidates = "c"
    }

    static func watch(_ id: String) -> SignalMessage { SignalMessage(kind: .watch, id: id) }
    static func leave(_ id: String) -> SignalMessage { SignalMessage(kind: .leave, id: id) }
    static func answer(_ id: String, sdp: String) -> SignalMessage { SignalMessage(kind: .answer, id: id, sdp: sdp) }
}

struct ICECandidateInit: Codable {
    var candidate: String
    var sdpMid: String?
    var sdpMLineIndex: Int32?
}

enum SignalError: Error {
    case tooLarge
}

struct SignalFragmenter {
    private var nextMessageId: UInt8 = 0

    mutating func fragments(for message: SignalMessage) throws -> [Data] {
        var payload = try JSONEncoder().encode(message)
        var flags: UInt8 = 0
        if payload.count >= RTCSignal.compressFrom,
           let compressed = Deflate.compress(payload),
           compressed.count < payload.count {
            payload = compressed
            flags |= RTCSignal.deflateFlag
        }
        let count = max(1, (payload.count + RTCSignal.fragmentSize - 1) / RTCSignal.fragmentSize)
        guard count <= RTCSignal.maxFragments else { throw SignalError.tooLarge }
        let messageId = nextMessageId
        nextMessageId &+= 1
        return (0..<count).map { index in
            var fragment = Data([RTCSignal.version, messageId, UInt8(index), UInt8(count), flags])
            let start = index * RTCSignal.fragmentSize
            let end = min(payload.count, start + RTCSignal.fragmentSize)
            fragment.append(payload.subdata(in: start..<end))
            return fragment
        }
    }
}

final class SignalReassembler {
    private struct Key: Hashable {
        let sender: UInt32
        let messageId: UInt8
    }

    private struct Partial {
        var parts: [Int: Data]
        let count: Int
        let flags: UInt8
        let startedAt: Date
    }

    private var pending: [Key: Partial] = [:]

    func receive(from sender: UInt32, data: Data) -> SignalMessage? {
        guard data.count >= RTCSignal.headerSize, data[data.startIndex] == RTCSignal.version else { return nil }
        let now = Date()
        pending = pending.filter { now.timeIntervalSince($0.value.startedAt) < RTCSignal.reassemblyTimeout }
        let base = data.startIndex
        let key = Key(sender: sender, messageId: data[base + 1])
        let index = Int(data[base + 2])
        let count = Int(data[base + 3])
        let flags = data[base + 4]
        guard count >= 1, index < count else { return nil }
        var partial = pending[key] ?? Partial(parts: [:], count: count, flags: flags, startedAt: now)
        partial.parts[index] = data.subdata(in: (base + RTCSignal.headerSize)..<data.endIndex)
        if partial.parts.count < count {
            pending[key] = partial
            return nil
        }
        pending[key] = nil
        var payload = Data()
        for position in 0..<count {
            guard let part = partial.parts[position] else { return nil }
            payload.append(part)
        }
        if flags & RTCSignal.deflateFlag != 0 {
            guard let inflated = Deflate.decompress(payload) else { return nil }
            payload = inflated
        }
        return try? JSONDecoder().decode(SignalMessage.self, from: payload)
    }
}

enum Deflate {
    static func compress(_ data: Data) -> Data? {
        data.withUnsafeBytes { source -> Data? in
            guard let base = source.bindMemory(to: UInt8.self).baseAddress else { return nil }
            let capacity = data.count + 64
            let destination = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
            defer { destination.deallocate() }
            let written = compression_encode_buffer(destination, capacity, base, data.count, nil, COMPRESSION_ZLIB)
            return written > 0 ? Data(bytes: destination, count: written) : nil
        }
    }

    static func decompress(_ data: Data) -> Data? {
        var capacity = max(4096, data.count * 8)
        while capacity <= (1 << 22) {
            let output: Data? = data.withUnsafeBytes { source in
                guard let base = source.bindMemory(to: UInt8.self).baseAddress else { return nil }
                let destination = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
                defer { destination.deallocate() }
                let written = compression_decode_buffer(destination, capacity, base, data.count, nil, COMPRESSION_ZLIB)
                let fitted = written > 0 && written < capacity
                return fitted ? Data(bytes: destination, count: written) : nil
            }
            if let output { return output }
            capacity *= 4
        }
        return nil
    }
}

@MainActor
final class SignalSender {
    private static let burst = 12.0
    private static let ratePerSecond = 3.0
    private static let retryDelayNanoseconds: UInt64 = 350_000_000

    private let client: MumbleClient
    private var fragmenter = SignalFragmenter()
    private var tokens = SignalSender.burst
    private var lastRefill = Date()
    private var queue: [(receivers: [UInt32], data: Data)] = []
    private var drainTask: Task<Void, Never>?

    init(client: MumbleClient) {
        self.client = client
    }

    func send(_ message: SignalMessage, to receivers: [UInt32]) {
        guard !receivers.isEmpty, let fragments = try? fragmenter.fragments(for: message) else { return }
        for fragment in fragments {
            queue.append((receivers, fragment))
        }
        drain()
    }

    func reset() {
        queue.removeAll()
        drainTask?.cancel()
        drainTask = nil
        tokens = Self.burst
    }

    private func drain() {
        let now = Date()
        tokens = min(Self.burst, tokens + now.timeIntervalSince(lastRefill) * Self.ratePerSecond)
        lastRefill = now
        while tokens >= 1, !queue.isEmpty {
            let item = queue.removeFirst()
            client.sendPluginData(to: item.receivers, dataId: RTCSignal.dataId, data: item.data)
            tokens -= 1
        }
        guard !queue.isEmpty, drainTask == nil else { return }
        drainTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.retryDelayNanoseconds)
            guard let self, !Task.isCancelled else { return }
            self.drainTask = nil
            self.drain()
        }
    }
}
