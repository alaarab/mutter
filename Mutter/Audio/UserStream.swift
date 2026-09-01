import Foundation
import os
import MumbleProtocol

/// Decoded audio for one remote speaker with a small jitter buffer.
///
/// Packets are decoded as they arrive (on the network queue) into a PCM ring; the render
/// thread drains it. Playback for a stream starts once `prebufferSamples` have accumulated,
/// and gaps are filled with Opus packet-loss concealment while the stream is considered live.
final class UserStream {
    let session: UInt32
    var volume: Float = 1.0

    private let decoder: OpusDecoderWrapper
    private var ring: [Float]
    private var readIndex = 0
    private var writeIndex = 0
    private var available = 0
    private var started = false
    private var lastFrameNumber: UInt64 = 0
    private var lastPacketAt = Date()
    private var lock = os_unfair_lock()
    /// Ramp applied at stream start so the first samples don't click.
    private var fadeIn = 0
    private let rampSamples = 96

    private let prebufferSamples: Int
    private let capacity: Int

    init(session: UInt32, prebufferMs: Int = 40) throws {
        self.session = session
        decoder = try OpusDecoderWrapper()
        prebufferSamples = 48 * prebufferMs
        capacity = 48_000 // one second
        ring = [Float](repeating: 0, count: capacity)
    }

    var isIdle: Bool {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        return available == 0 && Date().timeIntervalSince(lastPacketAt) > 1.0
    }

    // MARK: Network side

    func push(_ packet: AudioPacket) {
        let expected = lastFrameNumber
        let missing = packet.frameNumber > expected && expected != 0 ? Int(packet.frameNumber - expected) : 0
        // Conceal small gaps (up to 3 packets); beyond that just resync.
        if missing > 0 && missing <= 3, let samplesPerPacket = lastPacketSamples {
            for _ in 0..<missing {
                if let plc = try? decoder.decode(nil, plcSamples: samplesPerPacket) { write(plc) }
            }
        }
        if !packet.opusData.isEmpty, let pcm = try? decoder.decode(packet.opusData) {
            lastPacketSamples = pcm.count
            write(pcm)
            lastFrameNumber = packet.frameNumber + UInt64(max(1, pcm.count / 480))
        }
        if packet.isTerminator {
            lastFrameNumber = 0
            decoder.reset()
        }
        os_unfair_lock_lock(&lock)
        lastPacketAt = Date()
        os_unfair_lock_unlock(&lock)
    }

    private var lastPacketSamples: Int?

    private func write(_ pcm: [Float]) {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        for s in pcm {
            if available == capacity {
                // Overrun: drop the oldest sample.
                readIndex = (readIndex + 1) % capacity
                available -= 1
            }
            ring[writeIndex] = s
            writeIndex = (writeIndex + 1) % capacity
            available += 1
        }
        if !started && available >= prebufferSamples {
            started = true
            fadeIn = rampSamples
        }
    }

    // MARK: Render side

    /// Mixes up to `frames` samples into `out`, scaled by `volume` and `masterGain`. Returns samples mixed.
    @discardableResult
    func mix(into out: UnsafeMutablePointer<Float>, frames: Int, masterGain: Float) -> Int {
        os_unfair_lock_lock(&lock)
        defer { os_unfair_lock_unlock(&lock) }
        guard started else { return 0 }
        let n = min(frames, available)
        if n == 0 {
            // Underrun: wait for the buffer to refill before resuming.
            started = false
            return 0
        }
        let gain = volume * masterGain
        // If this call drains the buffer, fade the tail out so the coming silence doesn't click.
        let draining = n < frames || available - n < 48
        let rampOut = draining ? min(n, rampSamples) : 0
        for i in 0..<n {
            var g = gain
            if fadeIn > 0 {
                g *= Float(rampSamples - fadeIn) / Float(rampSamples)
                fadeIn -= 1
            }
            if rampOut > 0 && i >= n - rampOut {
                g *= Float(n - i) / Float(rampOut)
            }
            out[i] += ring[readIndex] * g
            readIndex = (readIndex + 1) % capacity
        }
        available -= n
        if n < frames { started = false }
        return n
    }

    func reset() {
        os_unfair_lock_lock(&lock)
        readIndex = 0
        writeIndex = 0
        available = 0
        started = false
        fadeIn = 0
        os_unfair_lock_unlock(&lock)
        decoder.reset()
        lastFrameNumber = 0
    }
}
