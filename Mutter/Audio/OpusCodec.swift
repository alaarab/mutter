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
    private var decoder: OpaquePointer
    private var scratch = [Float](repeating: 0, count: 5760)

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

    func reset() {
        _ = opus_shim_decoder_reset(decoder)
    }

    func decode(_ packet: Data?, plcSamples: Int = 960) throws -> [Float] {
        let samples: Int32 = scratch.withUnsafeMutableBufferPointer { output -> Int32 in
            if let packet, !packet.isEmpty {
                return packet.withUnsafeBytes { raw -> Int32 in
                    let bytes = raw.bindMemory(to: UInt8.self).baseAddress
                    return opus_decode_float(decoder, bytes, Int32(packet.count), output.baseAddress!, Int32(output.count), 0)
                }
            } else {
                return opus_decode_float(decoder, nil, 0, output.baseAddress!, Int32(plcSamples), 0)
            }
        }
        guard samples >= 0 else { throw OpusError.decodeFailed(samples) }
        return Array(scratch[0..<Int(samples)])
    }

    static func sampleCount(of packet: Data) -> Int {
        packet.withUnsafeBytes { raw -> Int in
            guard let bytes = raw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
            let count = opus_packet_get_nb_samples(bytes, Int32(packet.count), OpusEncoderWrapper.sampleRate)
            return count > 0 ? Int(count) : 0
        }
    }
}
