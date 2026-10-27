import Foundation

enum OpusError: Error {
    case createFailed(Int32)
    case encodeFailed(Int32)
    case decodeFailed(Int32)
}

final class OpusEncoderWrapper {
    static let sampleRate: Int32 = 48_000
    private var encoder: OpaquePointer
    private var output = [UInt8](repeating: 0, count: 4000)

    init(bitrate: Int32) throws {
        var status: Int32 = 0
        guard let created = opus_encoder_create(OpusEncoderWrapper.sampleRate, 1, OPUS_APPLICATION_VOIP, &status), status == OPUS_OK else {
            throw OpusError.createFailed(status)
        }
        encoder = created
        _ = opus_shim_set_signal_voice(encoder)
        _ = opus_shim_set_vbr(encoder, 1)
        _ = opus_shim_set_inband_fec(encoder, 1)
        _ = opus_shim_set_packet_loss(encoder, 10)
        _ = opus_shim_set_complexity(encoder, 8)
        setBitrate(bitrate)
    }

    deinit {
        opus_encoder_destroy(encoder)
    }

    func setBitrate(_ bitrate: Int32) {
        _ = opus_shim_set_bitrate(encoder, max(6000, min(510_000, bitrate)))
    }

    func reset() {
        _ = opus_shim_encoder_reset(encoder)
    }

    func encode(_ pcm: UnsafePointer<Float>, frameSize: Int) throws -> Data {
        let written = output.withUnsafeMutableBufferPointer { buffer -> Int32 in
            opus_encode_float(encoder, pcm, Int32(frameSize), buffer.baseAddress!, Int32(buffer.count))
        }
        guard written >= 0 else { throw OpusError.encodeFailed(written) }
        return Data(output[0..<Int(written)])
    }
}

final class OpusDecoderWrapper {
    static let maximumFrameSamples = 5760
    private var decoder: OpaquePointer

    init() throws {
        var status: Int32 = 0
        guard let created = opus_decoder_create(OpusEncoderWrapper.sampleRate, 1, &status), status == OPUS_OK else {
            throw OpusError.createFailed(status)
        }
        decoder = created
    }

    deinit {
        opus_decoder_destroy(decoder)
    }

    /// The duration of a packet at 48 kHz, or nil if it is not a valid Opus packet.
    static func samples(in packet: Data) -> Int? {
        let samples = packet.withUnsafeBytes { raw -> Int32 in
            guard let bytes = raw.bindMemory(to: UInt8.self).baseAddress else { return -1 }
            return opus_packet_get_nb_samples(bytes, Int32(raw.count), OpusEncoderWrapper.sampleRate)
        }
        return samples > 0 ? Int(samples) : nil
    }

    func reset() {
        _ = opus_shim_decoder_reset(decoder)
    }

    /// Decodes without allocating, so it is safe on the render thread. With no packet it conceals `samples`;
    /// with `fec` it rebuilds the `samples` before `packet` from the packet's in-band redundancy.
    /// Returns the samples written, or a negative Opus error.
    func decode(_ packet: UnsafeRawBufferPointer?, fec: Bool = false, samples: Int,
                into output: UnsafeMutablePointer<Float>, capacity: Int) -> Int {
        guard let packet, let bytes = packet.bindMemory(to: UInt8.self).baseAddress, !packet.isEmpty else {
            return Int(opus_decode_float(decoder, nil, 0, output, Int32(min(samples, capacity)), 0))
        }
        let frameSize = fec ? min(samples, capacity) : capacity
        return Int(opus_decode_float(decoder, bytes, Int32(packet.count), output, Int32(frameSize), fec ? 1 : 0))
    }
}
