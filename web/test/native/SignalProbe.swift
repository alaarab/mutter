import Foundation

@main
struct SignalProbe {
    static func main() throws {
        var encoder = SignalFragmenter()
        let message = SignalMessage(kind: .offer, id: "demo", sdp: (0..<300).map { _ in UUID().uuidString }.joined())
        let parts = try encoder.fragments(for: message)
        precondition(parts.count > 1)
        let decoder = SignalReassembler()
        var result: SignalMessage?
        for part in parts.reversed() { result = decoder.receive(from: 1, data: part) ?? result }
        precondition(result?.sdp == message.sdp)

        let bad = SignalReassembler()
        precondition(bad.receive(from: 1, data: Data([1, 1, 0, 1, 0]) + Data(repeating: 0, count: 1000)) == nil)
        precondition(bad.receive(from: 1, data: Data([1, 1, 0, 1, 2, 123, 125])) == nil)
        precondition(bad.receive(from: 1, data: Data([1, 1, 0, 1, 1, 255])) == nil)
        precondition(bad.receive(from: 1, data: Data([1, 1, 0, 2, 0, 123])) == nil)
        precondition(bad.receive(from: 1, data: Data([1, 1, 1, 2, 1, 125])) == nil)

        let flooded = SignalReassembler()
        for sender in 0..<1000 {
            precondition(flooded.receive(from: UInt32(sender), data: Data([1, 1, 0, 2, 0, 123])) == nil)
        }
        let watch = try encoder.fragments(for: .watch("valid"))[0]
        precondition(flooded.receive(from: 1001, data: watch) == nil)
        _ = flooded.receive(from: 0, data: Data([1, 1, 1, 2, 0, 125]))
        precondition(flooded.receive(from: 1001, data: watch)?.id == "valid")

        let large = SignalMessage(kind: .offer, id: "large", sdp: String(repeating: "a", count: RTCSignal.maxPayload))
        do {
            _ = try encoder.fragments(for: large)
            preconditionFailure("Oversized outgoing message was accepted")
        } catch SignalError.tooLarge {}
        let payload = Deflate.compress(try JSONEncoder().encode(large))!
        precondition(Deflate.decompress(payload) == nil)
        print("PASS: native signal round-trip, malformed packets, memory budget, and decompression limits")
    }
}
