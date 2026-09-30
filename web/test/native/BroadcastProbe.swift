import Foundation

@main
struct BroadcastProbe {
    static func main() throws {
        let first = BroadcastFrame(orientation: 6, jpeg: Data((0..<70_000).map { UInt8($0 % 251) }))
        let second = BroadcastFrame(orientation: 1, jpeg: Data([0xFF, 0xD8, 0xFF, 0xD9]))
        let stream = BroadcastFrameCodec.encode(first) + BroadcastFrameCodec.encode(second)
        let reader = BroadcastFrameReader()
        var frames: [BroadcastFrame] = []
        var offset = 0
        for chunkSize in [3, 5, 9, 1000, 65_536, 4, 70_000] where offset < stream.count {
            let end = min(stream.count, offset + chunkSize)
            frames += try reader.append(stream.subdata(in: offset..<end))
            offset = end
        }
        if offset < stream.count { frames += try reader.append(stream.subdata(in: offset..<stream.count)) }
        precondition(frames == [first, second], "Frames split across reads reassemble in order")

        let corrupt = BroadcastFrameReader()
        do {
            _ = try corrupt.append(Data("JUNKJUNKJUNK".utf8))
            preconditionFailure("A stream without the frame marker is rejected")
        } catch BroadcastFrameReader.ReadError.badMagic {}

        var oversized = Data(BroadcastFrameCodec.magic)
        oversized.append(contentsOf: [0x7F, 0xFF, 0xFF, 0xFF, 1])
        do {
            _ = try BroadcastFrameReader().append(oversized)
            preconditionFailure("A frame larger than the limit is rejected before buffering it")
        } catch BroadcastFrameReader.ReadError.frameTooLarge {}

        precondition(BroadcastCaptureSize.fitted(width: 1170, height: 2532) == (590, 1280))
        precondition(BroadcastCaptureSize.fitted(width: 2532, height: 1170) == (1280, 590))
        precondition(BroadcastCaptureSize.fitted(width: 640, height: 360) == (640, 360))

        var limiter = ShareWatchLimiter()
        let start = Date(timeIntervalSince1970: 0)
        for _ in 0..<4 { precondition(limiter.allow(7, at: start)) }
        precondition(!limiter.allow(7, at: start), "A fifth watch in a burst is ignored")
        precondition(limiter.allow(8, at: start), "Each viewer has its own allowance")
        precondition(!limiter.allow(7, at: start.addingTimeInterval(1.9)))
        precondition(limiter.allow(7, at: start.addingTimeInterval(3.9)))
        limiter.forgetAll(except: [8])
        for _ in 0..<4 { precondition(limiter.allow(7, at: start.addingTimeInterval(4))) }

        print("PASS: broadcast frames reassemble across reads, reject junk and oversized frames; capture size and watch limits hold")
    }
}
