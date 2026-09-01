import Foundation

/// Which UDP wire format a peer speaks. Decided by the *server's* announced version:
/// servers 1.5.0 and newer use protobuf, older ones use the legacy header-byte format.
public enum VoiceWireFormat: Sendable {
    case legacy
    case protobuf

    public init(serverVersion: ProtocolVersion) {
        self = serverVersion.usesProtobufUDP ? .protobuf : .legacy
    }
}

/// Voice target used on outgoing packets. 0 = normal talking in the current channel,
/// 1...30 = whisper/shout targets registered via VoiceTarget, 31 = server loopback.
public struct VoiceTargetID: RawRepresentable, Hashable, Sendable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue = rawValue & 0x1F }
    public init(_ v: UInt8) { self.init(rawValue: v) }
    public static let normal = VoiceTargetID(0)
    public static let serverLoopback = VoiceTargetID(31)
}

/// Audio context on incoming packets (why the server sent us this audio).
public enum AudioContext: UInt8, Sendable {
    case normal = 0
    case shout = 1
    case whisper = 2
    case listener = 3
    case other = 255
}

public struct AudioPacket: Equatable, Sendable {
    /// Present on packets received from the server.
    public var senderSession: UInt32?
    /// Outgoing: the voice target. Incoming legacy packets carry the context in the same bits.
    public var target: VoiceTargetID = .normal
    /// Incoming: the audio context.
    public var context: AudioContext = .normal
    public var frameNumber: UInt64 = 0
    public var opusData: Data = Data()
    public var isTerminator: Bool = false
    public var positional: [Float] = []
    /// Server-applied gain (protobuf only). 0 means unset.
    public var volumeAdjustment: Float = 0

    public init() {}
}

public struct UDPPing: Equatable, Sendable {
    public var timestamp: UInt64 = 0
    public var requestExtendedInformation: Bool = false
    public var serverVersionV2: UInt64?
    public var userCount: UInt32?
    public var maxUserCount: UInt32?
    public var maxBandwidthPerUser: UInt32?

    public init(timestamp: UInt64) { self.timestamp = timestamp }
}

public enum UDPPacket: Equatable, Sendable {
    case audio(AudioPacket)
    case ping(UDPPing)
}

/// Encodes and decodes UDP voice/ping packets in either wire format.
public enum VoiceCodec {

    // MARK: Legacy format

    private static let legacyOpusType: UInt8 = 4 << 5
    private static let legacyPingHeader: UInt8 = 1 << 5
    private static let terminatorBit: Int64 = 0x2000

    /// Encodes an outgoing (client to server) audio packet.
    public static func encodeAudio(_ packet: AudioPacket, format: VoiceWireFormat) -> Data {
        switch format {
        case .legacy:
            var d = Data(capacity: packet.opusData.count + 16)
            d.append(legacyOpusType | packet.target.rawValue)
            MumbleVarint.encode(Int64(packet.frameNumber), into: &d)
            var lenField = Int64(packet.opusData.count & 0x1FFF)
            if packet.isTerminator { lenField |= terminatorBit }
            MumbleVarint.encode(lenField, into: &d)
            d.append(packet.opusData)
            if packet.positional.count == 3 {
                for f in packet.positional {
                    var bits = f.bitPattern.littleEndian
                    withUnsafeBytes(of: &bits) { d.append(contentsOf: $0) }
                }
            }
            return d
        case .protobuf:
            var w = ProtobufWriter()
            w.uint32(1, UInt32(packet.target.rawValue))
            w.uint32(3, packet.senderSession)
            w.uint64(4, packet.frameNumber)
            w.bytes(5, packet.opusData)
            w.repeatedFloat(6, packet.positional)
            if packet.volumeAdjustment != 0 { w.float(7, packet.volumeAdjustment) }
            if packet.isTerminator { w.bool(16, true) }
            var d = Data(capacity: w.data.count + 1)
            d.append(0) // UDPMessageType.Audio
            d.append(w.data)
            return d
        }
    }

    public static func encodePing(_ ping: UDPPing, format: VoiceWireFormat) -> Data {
        switch format {
        case .legacy:
            var d = Data()
            d.append(legacyPingHeader)
            MumbleVarint.encode(Int64(bitPattern: ping.timestamp), into: &d)
            return d
        case .protobuf:
            var w = ProtobufWriter()
            w.uint64(1, ping.timestamp)
            if ping.requestExtendedInformation { w.bool(2, true) }
            var d = Data()
            d.append(1) // UDPMessageType.Ping
            d.append(w.data)
            return d
        }
    }

    /// Decodes a packet received from the server (already decrypted, or straight from a UDPTunnel).
    public static func decode(_ data: Data, format: VoiceWireFormat) -> UDPPacket? {
        guard let first = data.first else { return nil }
        switch format {
        case .legacy:
            let type = first >> 5
            if type == 1 {
                var off = 1
                guard let ts = MumbleVarint.decode(data, offset: &off) else { return nil }
                return .ping(UDPPing(timestamp: UInt64(bitPattern: ts)))
            }
            guard type == 4 else { return nil } // Only Opus is supported; CELT/Speex are long dead.
            var p = AudioPacket()
            p.context = AudioContext(rawValue: first & 0x1F) ?? .other
            p.target = VoiceTargetID(first & 0x1F)
            var off = 1
            guard let session = MumbleVarint.decode(data, offset: &off),
                  let seq = MumbleVarint.decode(data, offset: &off),
                  let lenField = MumbleVarint.decode(data, offset: &off) else { return nil }
            p.senderSession = UInt32(truncatingIfNeeded: session)
            p.frameNumber = UInt64(bitPattern: seq)
            p.isTerminator = (lenField & terminatorBit) != 0
            let len = Int(lenField & 0x1FFF)
            let start = data.startIndex + off
            guard len >= 0, start + len <= data.endIndex else { return nil }
            p.opusData = Data(data[start..<(start + len)])
            let rest = data.endIndex - (start + len)
            if rest >= 12 {
                var floats: [Float] = []
                var idx = start + len
                for _ in 0..<3 {
                    let slice = data[idx..<(idx + 4)]
                    var bits: UInt32 = 0
                    withUnsafeMutableBytes(of: &bits) { $0.copyBytes(from: slice) }
                    floats.append(Float(bitPattern: UInt32(littleEndian: bits)))
                    idx += 4
                }
                p.positional = floats
            }
            return .audio(p)
        case .protobuf:
            let body = data.dropFirst()
            switch first {
            case 0:
                var p = AudioPacket()
                var r = ProtobufReader(Data(body))
                do {
                    try r.forEachField { f in
                        switch f.number {
                        case 1: p.target = VoiceTargetID(UInt8(truncatingIfNeeded: f.uint32Value))
                        case 2: p.context = AudioContext(rawValue: UInt8(truncatingIfNeeded: f.uint32Value)) ?? .other
                        case 3: p.senderSession = f.uint32Value
                        case 4: p.frameNumber = f.uint64Value
                        case 5: p.opusData = f.payload
                        case 6:
                            if f.wireType == .fixed32 {
                                p.positional.append(f.floatValue)
                            } else {
                                // packed floats
                                var i = f.payload.startIndex
                                while i + 4 <= f.payload.endIndex {
                                    var bits: UInt32 = 0
                                    withUnsafeMutableBytes(of: &bits) { $0.copyBytes(from: f.payload[i..<(i + 4)]) }
                                    p.positional.append(Float(bitPattern: UInt32(littleEndian: bits)))
                                    i += 4
                                }
                            }
                        case 7: p.volumeAdjustment = f.floatValue
                        case 16: p.isTerminator = f.boolValue
                        default: break
                        }
                    }
                } catch {
                    return nil
                }
                return .audio(p)
            case 1:
                var ping = UDPPing(timestamp: 0)
                var r = ProtobufReader(Data(body))
                do {
                    try r.forEachField { f in
                        switch f.number {
                        case 1: ping.timestamp = f.uint64Value
                        case 2: ping.requestExtendedInformation = f.boolValue
                        case 3: ping.serverVersionV2 = f.uint64Value
                        case 4: ping.userCount = f.uint32Value
                        case 5: ping.maxUserCount = f.uint32Value
                        case 6: ping.maxBandwidthPerUser = f.uint32Value
                        default: break
                        }
                    }
                } catch {
                    return nil
                }
                return .ping(ping)
            default:
                return nil
            }
        }
    }
}

/// The unencrypted "extended ping" used by server browsers. Works against every server version.
/// Request: 4 zero bytes + 8-byte identifier. Response: version (4), identifier (8), users (4),
/// max users (4), allowed bandwidth (4). All big-endian.
public enum ServerProbe {
    public struct Response: Equatable, Sendable {
        public var version: ProtocolVersion
        public var identifier: UInt64
        public var users: UInt32
        public var maxUsers: UInt32
        public var bandwidth: UInt32
    }

    public static func request(identifier: UInt64) -> Data {
        var d = Data([0, 0, 0, 0])
        for shift in stride(from: 56, through: 0, by: -8) {
            d.append(UInt8((identifier >> UInt64(shift)) & 0xFF))
        }
        return d
    }

    public static func parse(_ data: Data) -> Response? {
        guard data.count >= 24 else { return nil }
        let b = [UInt8](data)
        func u32(_ i: Int) -> UInt32 {
            UInt32(b[i]) << 24 | UInt32(b[i + 1]) << 16 | UInt32(b[i + 2]) << 8 | UInt32(b[i + 3])
        }
        var ident: UInt64 = 0
        for i in 4..<12 { ident = (ident << 8) | UInt64(b[i]) }
        return Response(
            version: ProtocolVersion(v1: u32(0)),
            identifier: ident,
            users: u32(12),
            maxUsers: u32(16),
            bandwidth: u32(20)
        )
    }
}
