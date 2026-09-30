import Foundation

enum BroadcastChannel {
    static let appGroup = "group.com.alaarab.mutter"
    static let socketName = "share.sock"
    static let extensionBundleIdentifier = "com.alaarab.mutter.broadcast"
    static let framesPerSecond = 15
    static let longestEdge = 1280

    static var socketURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent(socketName)
    }
}

struct BroadcastFrame: Equatable {
    var orientation: UInt8
    var jpeg: Data
}

enum BroadcastFrameCodec {
    static let magic: [UInt8] = Array("MTRF".utf8)
    static let headerSize = 9
    static let maximumPayloadSize = 8 * 1024 * 1024

    static func encode(_ frame: BroadcastFrame) -> Data {
        var data = Data(magic)
        var length = UInt32(frame.jpeg.count).bigEndian
        withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
        data.append(frame.orientation)
        data.append(frame.jpeg)
        return data
    }
}

final class BroadcastFrameReader {
    enum ReadError: Error, Equatable {
        case badMagic
        case frameTooLarge
    }

    private var buffer = Data()
    private var readOffset = 0

    func append(_ bytes: Data) throws -> [BroadcastFrame] {
        buffer.append(bytes)
        var frames: [BroadcastFrame] = []
        while buffer.count - readOffset >= BroadcastFrameCodec.headerSize {
            let start = buffer.startIndex + readOffset
            let magic = buffer[start..<(start + 4)]
            guard magic.elementsEqual(BroadcastFrameCodec.magic) else { throw ReadError.badMagic }
            let length = buffer[(start + 4)..<(start + 8)].reduce(0) { ($0 << 8) | Int($1) }
            guard length <= BroadcastFrameCodec.maximumPayloadSize else { throw ReadError.frameTooLarge }
            let frameEnd = readOffset + BroadcastFrameCodec.headerSize + length
            guard buffer.count >= frameEnd else { break }
            let orientation = buffer[start + 8]
            let payloadStart = start + BroadcastFrameCodec.headerSize
            frames.append(BroadcastFrame(orientation: orientation, jpeg: buffer.subdata(in: payloadStart..<(payloadStart + length))))
            readOffset = frameEnd
        }
        if readOffset > 0 {
            buffer.removeSubrange(buffer.startIndex..<(buffer.startIndex + readOffset))
            readOffset = 0
        }
        return frames
    }
}

enum BroadcastCaptureSize {
    static func fitted(width: Int, height: Int, longestEdge: Int = BroadcastChannel.longestEdge) -> (width: Int, height: Int) {
        let longest = max(width, height, 1)
        let limit = min(longest, longestEdge)
        func even(_ value: Int) -> Int { max(2, value / 2 * 2) }
        return (even(width * limit / longest), even(height * limit / longest))
    }
}

struct ShareWatchLimiter {
    private struct Bucket {
        var tokens: Double
        var refilledAt: Date
    }

    let burst: Double
    let ratePerSecond: Double
    private var buckets: [UInt32: Bucket] = [:]

    init(burst: Double = 4, ratePerSecond: Double = 0.5) {
        self.burst = burst
        self.ratePerSecond = ratePerSecond
    }

    mutating func allow(_ viewer: UInt32, at now: Date = Date()) -> Bool {
        var bucket = buckets[viewer] ?? Bucket(tokens: burst, refilledAt: now)
        let elapsed = max(0, now.timeIntervalSince(bucket.refilledAt))
        bucket.tokens = min(burst, bucket.tokens + elapsed * ratePerSecond)
        bucket.refilledAt = now
        let allowed = bucket.tokens >= 1
        if allowed { bucket.tokens -= 1 }
        buckets[viewer] = bucket
        return allowed
    }

    mutating func forgetAll(except present: Set<UInt32>) {
        buckets = buckets.filter { present.contains($0.key) }
    }

    mutating func reset() {
        buckets.removeAll()
    }
}
