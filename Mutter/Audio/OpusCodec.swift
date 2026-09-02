import Foundation

enum OpusError: Error {
    case createFailed(Int32)
    case encodeFailed(Int32)
    case decodeFailed(Int32)
}

/// Opus encoder tuned for Mumble voice: 48 kHz mono, VOIP application, VBR, in-band FEC.
final class OpusEncoderWrapper {
    static let sampleRate: Int32 = 48_000
    private var encoder: OpaquePointer
    private var output = [UInt8](repeating: 0, count: 4000)

    init(bitrate: Int32) throws {
        var err: Int32 = 0
        guard let enc = opus_encoder_create(OpusEncoderWrapper.sampleRate, 1, OPUS_APPLICATION_VOIP, &err), err == OPUS_OK else {
            throw OpusError.createFailed(err)
        }
        encoder = enc
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

    /// Encodes exactly `frameSize` float samples (must be 120, 240, 480, 960, 1920 or 2880).
    func encode(_ pcm: UnsafePointer<Float>, frameSize: Int) throws -> Data {
        let n = output.withUnsafeMutableBufferPointer { buf -> Int32 in
            opus_encode_float(encoder, pcm, Int32(frameSize), buf.baseAddress!, Int32(buf.count))
        }
        guard n >= 0 else { throw OpusError.encodeFailed(n) }
        return Data(output[0..<Int(n)])
    }
}

/// Opus decoder for one remote user.
final class OpusDecoderWrapper {
    private var decoder: OpaquePointer
    /// Maximum decodable frame: 120 ms at 48 kHz.
    private var scratch = [Float](repeating: 0, count: 5760)

    init() throws {
        var err: Int32 = 0
        guard let dec = opus_decoder_create(OpusEncoderWrapper.sampleRate, 1, &err), err == OPUS_OK else {
            throw OpusError.createFailed(err)
        }
        decoder = dec
    }

    deinit {
        opus_decoder_destroy(decoder)
    }

    func reset() {
        _ = opus_shim_decoder_reset(decoder)
    }

    /// Decodes one packet into float samples. Pass nil to run packet-loss concealment for `plcSamples` samples.
    func decode(_ packet: Data?, plcSamples: Int = 960) throws -> [Float] {
        let n: Int32 = scratch.withUnsafeMutableBufferPointer { out -> Int32 in
            if let packet, !packet.isEmpty {
                return packet.withUnsafeBytes { raw -> Int32 in
                    let p = raw.bindMemory(to: UInt8.self).baseAddress
                    return opus_decode_float(decoder, p, Int32(packet.count), out.baseAddress!, Int32(out.count), 0)
                }
            } else {
                return opus_decode_float(decoder, nil, 0, out.baseAddress!, Int32(plcSamples), 0)
            }
        }
        guard n >= 0 else { throw OpusError.decodeFailed(n) }
        return Array(scratch[0..<Int(n)])
    }

    /// Number of samples the packet would decode to, without decoding.
    static func sampleCount(of packet: Data) -> Int {
        packet.withUnsafeBytes { raw -> Int in
            guard let p = raw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            let n = opus_packet_get_nb_samples(p, Int32(packet.count), OpusEncoderWrapper.sampleRate)
            return n > 0 ? Int(n) : 0
        }
    }
}
