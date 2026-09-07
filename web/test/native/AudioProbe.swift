import Foundation
import MumbleProtocol



final class OpusDecoderWrapper {
    static var packetSamples = 960
    static var concealed: [Int] = []
    init() throws {}
    func decode(_ data: Data?, plcSamples: Int = 960) throws -> [Float] {
        if data == nil { Self.concealed.append(plcSamples) }
        return [Float](repeating: 0.1, count: data == nil ? plcSamples : Self.packetSamples)
    }
    func reset() {}
}

@main struct AudioProbe {
    static func main() throws {
        for milliseconds in [10, 20, 40, 60] {
            for lost in 1...3 {
                OpusDecoderWrapper.packetSamples = milliseconds * 48
                OpusDecoderWrapper.concealed = []
                let stream = try UserStream(session: 1, prebufferMs: 0)
                var packet = AudioPacket()
                packet.opusData = Data([1])
                stream.push(packet)
                packet.frameNumber = UInt64((lost + 1) * milliseconds / 10)
                stream.push(packet)
                precondition(OpusDecoderWrapper.concealed == Array(repeating: milliseconds * 48, count: lost))
                var output = [Float](repeating: 0, count: 48_000)
                let played = output.withUnsafeMutableBufferPointer {
                    stream.mix(into: $0.baseAddress!, frames: $0.count, masterGain: 1)
                }
                precondition(played == (lost + 2) * milliseconds * 48, "Concealment changed the playback duration")
                packet.frameNumber = UInt64.max
                stream.push(packet)
            }
        }
        OpusDecoderWrapper.packetSamples = 960
        OpusDecoderWrapper.concealed = []
        let stream = try UserStream(session: 1)
        var packet = AudioPacket()
        packet.opusData = Data([1])
        stream.push(packet)
        packet.frameNumber = 3
        stream.push(packet)
        precondition(OpusDecoderWrapper.concealed == [480])
        print("PASS: loss concealment preserves duration for 10, 20, 40, and 60 ms packets")
    }
}
