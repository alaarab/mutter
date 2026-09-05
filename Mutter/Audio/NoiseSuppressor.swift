import Foundation
import Accelerate

final class NoiseSuppressor {
    enum Level: String, CaseIterable, Identifiable, Codable {
        case off, light, strong

        var id: String { rawValue }

        var title: String {
            switch self {
            case .off: return "Off"
            case .light: return "Light"
            case .strong: return "Strong"
            }
        }

        var gainFloor: Float {
            switch self {
            case .off: return 1
            case .light: return 0.316
            case .strong: return 0.08
            }
        }

        var overSubtraction: Float {
            switch self {
            case .off: return 1
            case .light: return 1.2
            case .strong: return 1.6
            }
        }
    }

    var level: Level = .strong

    private let frameSize = 1024
    private let hop = 512
    private let half = 512
    private let lowCutBin = 2
    private let warmupFrames = 8
    private let noiseFloor: Float = 1e-8

    private let forwardSetup: vDSP_DFT_Setup
    private let inverseSetup: vDSP_DFT_Setup
    private let window: [Float]

    private var inputQueue: [Float] = []
    private var overlap: [Float]
    private var outputQueue: [Float] = []

    private var noise: [Float]
    private var previousGain: [Float]
    private var previousPower: [Float]
    private var frameCount = 0

    private var packedReal: [Float]
    private var packedImaginary: [Float]
    private var spectrumReal: [Float]
    private var spectrumImaginary: [Float]
    private var gain: [Float]
    private var power: [Float]

    init?() {
        guard let forward = vDSP_DFT_zrop_CreateSetup(nil, vDSP_Length(frameSize), .FORWARD),
              let inverse = vDSP_DFT_zrop_CreateSetup(forward, vDSP_Length(frameSize), .INVERSE) else { return nil }
        forwardSetup = forward
        inverseSetup = inverse
        var sqrtHann = [Float](repeating: 0, count: frameSize)
        for index in 0..<frameSize {
            let hann = 0.5 - 0.5 * cos(2 * Float.pi * Float(index) / Float(frameSize))
            sqrtHann[index] = sqrt(hann)
        }
        window = sqrtHann
        overlap = [Float](repeating: 0, count: frameSize)
        noise = [Float](repeating: 1e-6, count: half + 1)
        previousGain = [Float](repeating: 1, count: half + 1)
        previousPower = [Float](repeating: 0, count: half + 1)
        packedReal = [Float](repeating: 0, count: half)
        packedImaginary = [Float](repeating: 0, count: half)
        spectrumReal = [Float](repeating: 0, count: half)
        spectrumImaginary = [Float](repeating: 0, count: half)
        gain = [Float](repeating: 1, count: half + 1)
        power = [Float](repeating: 0, count: half + 1)
    }

    deinit {
        vDSP_DFT_DestroySetup(forwardSetup)
        vDSP_DFT_DestroySetup(inverseSetup)
    }

    func process(_ input: [Float]) -> [Float] {
        if level == .off {
            if !inputQueue.isEmpty || !outputQueue.isEmpty { reset() }
            return input
        }
        inputQueue.append(contentsOf: input)
        while inputQueue.count >= frameSize {
            processFrame()
        }
        let output = outputQueue
        outputQueue.removeAll(keepingCapacity: true)
        return output
    }

    func reset() {
        inputQueue.removeAll(keepingCapacity: true)
        outputQueue.removeAll(keepingCapacity: true)
        for index in 0..<frameSize { overlap[index] = 0 }
        frameCount = 0
        for bin in 0...half {
            noise[bin] = 1e-6
            previousGain[bin] = 1
            previousPower[bin] = 0
        }
    }

    private func processFrame() {
        for index in 0..<half {
            packedReal[index] = inputQueue[2 * index] * window[2 * index]
            packedImaginary[index] = inputQueue[2 * index + 1] * window[2 * index + 1]
        }
        inputQueue.removeFirst(hop)

        vDSP_DFT_Execute(forwardSetup, packedReal, packedImaginary, &spectrumReal, &spectrumImaginary)

        power[0] = spectrumReal[0] * spectrumReal[0]
        power[half] = spectrumImaginary[0] * spectrumImaginary[0]
        for bin in 1..<half {
            power[bin] = spectrumReal[bin] * spectrumReal[bin] + spectrumImaginary[bin] * spectrumImaginary[bin]
        }

        frameCount += 1
        updateGains(warmingUp: frameCount <= warmupFrames)
        smoothGains()

        spectrumReal[0] *= gain[0]
        spectrumImaginary[0] *= gain[half]
        for bin in 1..<half {
            spectrumReal[bin] *= gain[bin]
            spectrumImaginary[bin] *= gain[bin]
        }

        vDSP_DFT_Execute(inverseSetup, spectrumReal, spectrumImaginary, &packedReal, &packedImaginary)

        let scale = 1 / Float(2 * frameSize)
        for index in 0..<half {
            overlap[2 * index] += packedReal[index] * scale * window[2 * index]
            overlap[2 * index + 1] += packedImaginary[index] * scale * window[2 * index + 1]
        }
        outputQueue.append(contentsOf: overlap[0..<hop])
        for index in 0..<(frameSize - hop) { overlap[index] = overlap[index + hop] }
        for index in (frameSize - hop)..<frameSize { overlap[index] = 0 }
    }

    private func updateGains(warmingUp: Bool) {
        let gainFloor = level.gainFloor
        let overSubtraction = level.overSubtraction
        for bin in 0...half {
            let binPower = power[bin]
            if warmingUp {
                noise[bin] = max(binPower, noiseFloor)
            } else {
                let posterior = binPower / max(noise[bin], 1e-10)
                let rate: Float = posterior < 3 ? 0.06 : 0.0025
                noise[bin] += rate * (binPower - noise[bin])
                noise[bin] = max(noise[bin], noiseFloor)
            }
            let noiseEstimate = noise[bin] * overSubtraction
            let instantaneous = max(binPower / noiseEstimate - 1, 0)
            let prior = 0.98 * (previousGain[bin] * previousGain[bin] * previousPower[bin] / noiseEstimate) + 0.02 * instantaneous
            var binGain = prior / (1 + prior)
            binGain = max(binGain, gainFloor)
            if bin < lowCutBin { binGain = 0 }
            gain[bin] = binGain
            previousGain[bin] = binGain
            previousPower[bin] = binPower
        }
    }

    private func smoothGains() {
        var previous = gain[0]
        for bin in 1..<half {
            let current = gain[bin]
            gain[bin] = 0.25 * previous + 0.5 * current + 0.25 * gain[bin + 1]
            previous = current
        }
    }
}
