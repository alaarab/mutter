import Foundation
import Accelerate

/// Streaming spectral noise suppressor for the microphone path.
///
/// Classic single-channel approach: 1024-point frames at 48 kHz with 50% overlap and sqrt-Hann
/// analysis/synthesis windows, a per-bin noise estimate that adapts quickly to noise-like frames
/// and slowly during speech, a decision-directed a-priori SNR (Ephraim–Malah) and a Wiener gain
/// with a floor to avoid "musical noise". Bins below ~90 Hz are dropped outright, which doubles as
/// the high-pass filter for rumble and handling noise.
///
/// It removes stationary noise (hiss, fans, hum, air conditioning) well. Combined with Apple's
/// voice processing and Voice Isolation it covers most of what Discord's suppression does.
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
        /// Minimum gain applied to a noisy bin. -10 dB for light, -22 dB for strong.
        var gainFloor: Float {
            switch self {
            case .off: return 1
            case .light: return 0.316
            case .strong: return 0.08
            }
        }
        /// Noise over-estimation factor: stronger settings assume a bit more noise.
        var overSubtraction: Float {
            switch self {
            case .off: return 1
            case .light: return 1.2
            case .strong: return 1.6
            }
        }
    }

    var level: Level = .strong

    private let n = 1024
    private let hop = 512
    private let half = 512
    private let forward: vDSP_DFT_Setup
    private let inverse: vDSP_DFT_Setup
    private let window: [Float]
    private let lowCutBin = 2 // bins 0 and 1 (< 94 Hz) are removed

    private var inFIFO: [Float] = []
    private var overlap: [Float]
    private var outFIFO: [Float] = []

    private var noise: [Float]
    private var prevGain: [Float]
    private var prevPower: [Float]
    private var frameCount = 0

    // Scratch buffers
    private var re: [Float]
    private var im: [Float]
    private var xr: [Float]
    private var xi: [Float]
    private var gain: [Float]
    private var power: [Float]

    init?() {
        guard let f = vDSP_DFT_zrop_CreateSetup(nil, vDSP_Length(n), .FORWARD),
              let i = vDSP_DFT_zrop_CreateSetup(f, vDSP_Length(n), .INVERSE) else { return nil }
        forward = f
        inverse = i
        var w = [Float](repeating: 0, count: n)
        for k in 0..<n {
            let hann = 0.5 - 0.5 * cos(2 * Float.pi * Float(k) / Float(n))
            w[k] = sqrt(hann)
        }
        window = w
        overlap = [Float](repeating: 0, count: n)
        noise = [Float](repeating: 1e-6, count: half + 1)
        prevGain = [Float](repeating: 1, count: half + 1)
        prevPower = [Float](repeating: 0, count: half + 1)
        re = [Float](repeating: 0, count: half)
        im = [Float](repeating: 0, count: half)
        xr = [Float](repeating: 0, count: half)
        xi = [Float](repeating: 0, count: half)
        gain = [Float](repeating: 1, count: half + 1)
        power = [Float](repeating: 0, count: half + 1)
    }

    deinit {
        vDSP_DFT_DestroySetup(forward)
        vDSP_DFT_DestroySetup(inverse)
    }

    /// Feed samples in, get processed samples out (same rate, ~10 ms behind).
    func process(_ input: [Float]) -> [Float] {
        if level == .off {
            // Keep the pipeline latency-free when disabled.
            if !inFIFO.isEmpty || !outFIFO.isEmpty { reset() }
            return input
        }
        inFIFO.append(contentsOf: input)
        while inFIFO.count >= n {
            processFrame()
        }
        let out = outFIFO
        outFIFO.removeAll(keepingCapacity: true)
        return out
    }

    func reset() {
        inFIFO.removeAll(keepingCapacity: true)
        outFIFO.removeAll(keepingCapacity: true)
        for k in 0..<n { overlap[k] = 0 }
        frameCount = 0
        for k in 0...half { noise[k] = 1e-6; prevGain[k] = 1; prevPower[k] = 0 }
    }

    private func processFrame() {
        // Window and pack even/odd samples for the real-to-complex DFT.
        for k in 0..<half {
            re[k] = inFIFO[2 * k] * window[2 * k]
            im[k] = inFIFO[2 * k + 1] * window[2 * k + 1]
        }
        inFIFO.removeFirst(hop)

        vDSP_DFT_Execute(forward, re, im, &xr, &xi)

        // Power spectrum. Bin 0 (DC) lives in xr[0], bin n/2 (Nyquist) in xi[0].
        power[0] = xr[0] * xr[0]
        power[half] = xi[0] * xi[0]
        for k in 1..<half { power[k] = xr[k] * xr[k] + xi[k] * xi[k] }

        frameCount += 1
        let floor = level.gainFloor
        let over = level.overSubtraction
        let warmingUp = frameCount <= 8

        for k in 0...half {
            let p = power[k]
            if warmingUp {
                noise[k] = max(p, 1e-8)
            } else {
                // Fast adaptation when the bin looks like noise, slow during speech.
                let post = p / max(noise[k], 1e-10)
                let rate: Float = post < 3 ? 0.06 : 0.0025
                noise[k] += rate * (p - noise[k])
                noise[k] = max(noise[k], 1e-8)
            }
            let nEst = noise[k] * over
            let posterior = p / nEst
            let instantaneous = max(posterior - 1, 0)
            let prior = 0.98 * (prevGain[k] * prevGain[k] * prevPower[k] / nEst) + 0.02 * instantaneous
            var g = prior / (1 + prior)
            g = max(g, floor)
            if k < lowCutBin { g = 0 }
            gain[k] = g
            prevGain[k] = g
            prevPower[k] = p
        }

        // Light smoothing across bins reduces isolated tonal artifacts.
        var prev = gain[0]
        for k in 1..<half {
            let cur = gain[k]
            gain[k] = 0.25 * prev + 0.5 * cur + 0.25 * gain[k + 1]
            prev = cur
        }

        xr[0] *= gain[0]
        xi[0] *= gain[half]
        for k in 1..<half {
            xr[k] *= gain[k]
            xi[k] *= gain[k]
        }

        vDSP_DFT_Execute(inverse, xr, xi, &re, &im)

        // Unpack, scale (vDSP real DFT round trip gains 2N), window, overlap-add.
        let scale = 1 / Float(2 * n)
        for k in 0..<half {
            overlap[2 * k] += re[k] * scale * window[2 * k]
            overlap[2 * k + 1] += im[k] * scale * window[2 * k + 1]
        }
        outFIFO.append(contentsOf: overlap[0..<hop])
        for k in 0..<(n - hop) { overlap[k] = overlap[k + hop] }
        for k in (n - hop)..<n { overlap[k] = 0 }
    }
}
