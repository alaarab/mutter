import Foundation
import os
import MumbleProtocol

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
    private let lock = OSAllocatedUnfairLock()
    private var fadeIn = 0
    private let rampSamples = 96

    private let prebufferSamples: Int
    private let capacity: Int

    init(session: UInt32, prebufferMs: Int = 40) throws {
        self.session = session
        decoder = try OpusDecoderWrapper()
        prebufferSamples = 48 * prebufferMs
        capacity = 48_000
        ring = [Float](repeating: 0, count: capacity)
    }

    var isIdle: Bool {
        synchronized { available == 0 && Date().timeIntervalSince(lastPacketAt) > 1.0 }
    }

    private func synchronized<Result>(_ body: () -> Result) -> Result {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func push(_ packet: AudioPacket) {
        let expected = lastFrameNumber
        let missing = packet.frameNumber > expected && expected != 0 ? Int(packet.frameNumber - expected) : 0
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
        synchronized { lastPacketAt = Date() }
    }

    private var lastPacketSamples: Int?

    private func write(_ pcm: [Float]) {
        synchronized {
            for sample in pcm {
                if available == capacity {
                    readIndex = (readIndex + 1) % capacity
                    available -= 1
                }
                ring[writeIndex] = sample
                writeIndex = (writeIndex + 1) % capacity
                available += 1
            }
            if !started && available >= prebufferSamples {
                started = true
                fadeIn = rampSamples
            }
        }
    }

    @discardableResult
    func mix(into out: UnsafeMutablePointer<Float>, frames: Int, masterGain: Float) -> Int {
        synchronized { () -> Int in
            guard started else { return 0 }
            let count = min(frames, available)
            if count == 0 {
                started = false
                return 0
            }
            let gain = volume * masterGain
            let draining = count < frames || available - count < 48
            let rampOut = draining ? min(count, rampSamples) : 0
            for index in 0..<count {
                var sampleGain = gain
                if fadeIn > 0 {
                    sampleGain *= Float(rampSamples - fadeIn) / Float(rampSamples)
                    fadeIn -= 1
                }
                if rampOut > 0 && index >= count - rampOut {
                    sampleGain *= Float(count - index) / Float(rampOut)
                }
                out[index] += ring[readIndex] * sampleGain
                readIndex = (readIndex + 1) % capacity
            }
            available -= count
            if count < frames { started = false }
            return count
        }
    }

    func reset() {
        synchronized {
            readIndex = 0
            writeIndex = 0
            available = 0
            started = false
            fadeIn = 0
        }
        decoder.reset()
        lastFrameNumber = 0
    }
}
