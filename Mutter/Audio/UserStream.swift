import Foundation
import os
import MumbleProtocol

/// One speaker's playout. Packets go into a JitterBuffer on the network thread; the render thread pulls
/// decisions from it and decodes in playout order, so concealment and FEC happen exactly when audio is due.
final class UserStream {
    let session: UInt32
    var volume: Float = 1.0

    private let lock = OSAllocatedUnfairLock()
    private var jitter = JitterBuffer()
    private var lastPacketAt = Date()

    // Owned by the render thread.
    private let decoder: OpusDecoderWrapper
    private var payload: [UInt8]
    private var pcm: [Float]
    private var pcmRead = 0
    private var pcmCount = 0
    private var lastWasQuiet = false
    private let ramp: [Float]

    // Owned by the diagnostics reader.
    private var pendingStatistics = JitterBuffer.Statistics()
    private var lastReportAt: TimeInterval = -.infinity

    // About -46 dBFS: background hiss after noise suppression, where a dropped or stretched frame is inaudible.
    private static let quietRMS: Float = 0.005
    private static let reportInterval: TimeInterval = 5

    init(session: UInt32) throws {
        self.session = session
        decoder = try OpusDecoderWrapper()
        payload = [UInt8](repeating: 0, count: jitter.maximumPayloadBytes)
        pcm = [Float](repeating: 0, count: OpusDecoderWrapper.maximumFrameSamples)
        ramp = (0..<JitterBuffer.rampSamples).map { index in
            let phase = Float(index + 1) / Float(JitterBuffer.rampSamples)
            return 0.5 - 0.5 * cos(Float.pi * phase)
        }
    }

    var isIdle: Bool {
        synchronized { jitter.isIdle && Date().timeIntervalSince(lastPacketAt) > 1.0 }
    }

    private func synchronized<Result>(_ body: () -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func push(_ packet: AudioPacket) {
        let samples = packet.opusData.isEmpty ? 0 : OpusDecoderWrapper.samples(in: packet.opusData)
        guard let samples else { return }
        synchronized {
            lastPacketAt = Date()
            packet.opusData.withUnsafeBytes { bytes in
                jitter.insert(frame: packet.frameNumber, samples: samples, payload: bytes, isTerminator: packet.isTerminator)
            }
        }
    }

    @discardableResult
    func mix(into out: UnsafeMutablePointer<Float>, frames: Int, masterGain: Float) -> Int {
        let gain = volume * masterGain
        var written = 0
        while written < frames {
            if pcmRead == pcmCount, !decodeNextStep() { break }
            let count = min(frames - written, pcmCount - pcmRead)
            pcm.withUnsafeBufferPointer { decoded in
                for index in 0..<count { out[written + index] += decoded[pcmRead + index] * gain }
            }
            pcmRead += count
            written += count
        }
        if written < frames {
            synchronized { jitter.idle(samples: frames - written) }
        }
        return written
    }

    /// Takes the next decision from the jitter buffer and decodes it into `pcm` with its gain ramp applied.
    private func decodeNextStep() -> Bool {
        pcmRead = 0
        pcmCount = 0
        let taken = synchronized { () -> (step: JitterBuffer.Step, length: Int)? in
            guard let step = jitter.next(quiet: lastWasQuiet) else { return nil }
            var length = 0
            switch step.action {
            case .play(let slot), .recover(let slot):
                length = jitter.withPayload(slot: slot) { bytes in
                    payload.withUnsafeMutableBytes { $0.copyMemory(from: bytes) }
                    return bytes.count
                }
            case .conceal:
                break
            }
            return (step, length)
        }
        guard let taken else { return false }
        let step = taken.step
        if step.resetsDecoder { decoder.reset() }

        var decoded = pcm.withUnsafeMutableBufferPointer { output in
            payload.withUnsafeBytes { bytes -> Int in
                let packet = UnsafeRawBufferPointer(rebasing: bytes[0..<taken.length])
                switch step.action {
                case .play:
                    return decoder.decode(packet, samples: step.samples, into: output.baseAddress!, capacity: output.count)
                case .recover:
                    return decoder.decode(packet, fec: true, samples: step.samples, into: output.baseAddress!, capacity: output.count)
                case .conceal:
                    return decoder.decode(nil, samples: step.samples, into: output.baseAddress!, capacity: output.count)
                }
            }
        }
        if decoded < 0 {
            // Keep time even if a packet is corrupt; the silence is ramped like everything else.
            decoded = min(step.samples, pcm.count)
            for index in 0..<decoded { pcm[index] = 0 }
        }

        pcm.withUnsafeMutableBufferPointer { output in
            if case .conceal = step.action {} else {
                var energy: Float = 0
                for index in 0..<decoded { energy += output[index] * output[index] }
                lastWasQuiet = decoded > 0 && (energy / Float(decoded)).squareRoot() < Self.quietRMS
            }
            let delta = step.gainTo - step.gainFrom
            let rampLength = delta == 0 ? 0 : min(decoded, ramp.count)
            for index in 0..<rampLength { output[index] *= step.gainFrom + delta * ramp[index] }
            if step.gainTo != 1 {
                for index in rampLength..<decoded { output[index] *= step.gainTo }
            }
        }
        pcmCount = decoded
        return true
    }

    /// Called off the render thread about once a second. Returns a log line when something went wrong, at most
    /// once per `reportInterval`, carrying counts over in between so nothing is lost.
    func diagnosticsSummary(now: TimeInterval) -> String? {
        let latest = synchronized { jitter.takeStatistics() }
        var pending = pendingStatistics
        pending.underruns += latest.underruns
        pending.concealedFrames += latest.concealedFrames
        pending.recovered += latest.recovered
        pending.late += latest.late
        pending.duplicates += latest.duplicates
        pending.reordered += latest.reordered
        pending.trims += latest.trims
        pending.drops += latest.drops
        pending.stretches += latest.stretches
        pending.targetSamples = latest.targetSamples
        if let low = latest.lowestBufferedSamples {
            pending.lowestBufferedSamples = min(pending.lowestBufferedSamples ?? low, low)
        }
        pendingStatistics = pending
        guard pending.hasEvents, now - lastReportAt >= Self.reportInterval else { return nil }
        lastReportAt = now
        pendingStatistics = JitterBuffer.Statistics()

        let counts = [("underruns", pending.underruns), ("plc 10ms", pending.concealedFrames), ("fec", pending.recovered),
                      ("late", pending.late), ("dup", pending.duplicates), ("reordered", pending.reordered),
                      ("trims", pending.trims), ("quiet drops", pending.drops), ("stretches", pending.stretches)]
        var parts = counts.filter { $0.1 > 0 }.map { "\($0.0) \($0.1)" }
        parts.append("target \(pending.targetSamples / 48) ms")
        if let low = pending.lowestBufferedSamples { parts.append("low \(low / 48) ms") }
        return "playout session \(session): " + parts.joined(separator: ", ")
    }
}
