import Foundation

public enum VoiceWireFormat: Sendable {
    case legacy
    case protobuf

    public init(serverVersion: ProtocolVersion) {
        self = serverVersion.usesProtobufUDP ? .protobuf : .legacy
    }
}

public struct VoiceTargetID: RawRepresentable, Hashable, Sendable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue = rawValue & 0x1F }
    public init(_ value: UInt8) { self.init(rawValue: value) }
    public static let normal = VoiceTargetID(0)
    public static let serverLoopback = VoiceTargetID(31)
}

public enum AudioContext: UInt8, Sendable {
    case normal = 0
    case shout = 1
    case whisper = 2
    case listener = 3
    case other = 255
}

public struct AudioPacket: Equatable, Sendable {
    public var senderSession: UInt32?
    public var target: VoiceTargetID = .normal
    public var context: AudioContext = .normal
    public var frameNumber: UInt64 = 0
    public var opusData: Data = Data()
    public var isTerminator: Bool = false
    public var positional: [Float] = []
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

public enum VoiceCodec {
    private static let legacyOpusType: UInt8 = 4 << 5
    private static let legacyPingHeader: UInt8 = 1 << 5
    private static let terminatorBit: Int64 = 0x2000

    public static func encodeAudio(_ packet: AudioPacket, format: VoiceWireFormat) -> Data {
        switch format {
        case .legacy:
            var data = Data(capacity: packet.opusData.count + 16)
            data.append(legacyOpusType | packet.target.rawValue)
            MumbleVarint.encode(Int64(packet.frameNumber), into: &data)
            var lenField = Int64(packet.opusData.count & 0x1FFF)
            if packet.isTerminator { lenField |= terminatorBit }
            MumbleVarint.encode(lenField, into: &data)
            data.append(packet.opusData)
            if packet.positional.count == 3 {
                for value in packet.positional {
                    var bits = value.bitPattern.littleEndian
                    withUnsafeBytes(of: &bits) { data.append(contentsOf: $0) }
                }
            }
            return data
        case .protobuf:
            var writer = ProtobufWriter()
            writer.uint32(1, UInt32(packet.target.rawValue))
            writer.uint32(3, packet.senderSession)
            writer.uint64(4, packet.frameNumber)
            writer.bytes(5, packet.opusData)
            writer.repeatedFloat(6, packet.positional)
            if packet.volumeAdjustment != 0 { writer.float(7, packet.volumeAdjustment) }
            if packet.isTerminator { writer.bool(16, true) }
            var data = Data(capacity: writer.data.count + 1)
            data.append(0)
            data.append(writer.data)
            return data
        }
    }

    public static func encodePing(_ ping: UDPPing, format: VoiceWireFormat) -> Data {
        switch format {
        case .legacy:
            var data = Data()
            data.append(legacyPingHeader)
            MumbleVarint.encode(Int64(bitPattern: ping.timestamp), into: &data)
            return data
        case .protobuf:
            var writer = ProtobufWriter()
            writer.uint64(1, ping.timestamp)
            if ping.requestExtendedInformation { writer.bool(2, true) }
            var data = Data()
            data.append(1)
            data.append(writer.data)
            return data
        }
    }

    public static func decode(_ data: Data, format: VoiceWireFormat) -> UDPPacket? {
        guard let first = data.first else { return nil }
        switch format {
        case .legacy:
            let type = first >> 5
            if type == 1 {
                var offset = 1
                guard let timestamp = MumbleVarint.decode(data, offset: &offset) else { return nil }
                return .ping(UDPPing(timestamp: UInt64(bitPattern: timestamp)))
            }
            guard type == 4 else { return nil }
            var packet = AudioPacket()
            packet.context = AudioContext(rawValue: first & 0x1F) ?? .other
            packet.target = VoiceTargetID(first & 0x1F)
            var offset = 1
            guard let session = MumbleVarint.decode(data, offset: &offset),
                  let seq = MumbleVarint.decode(data, offset: &offset),
                  let lenField = MumbleVarint.decode(data, offset: &offset) else { return nil }
            packet.senderSession = UInt32(truncatingIfNeeded: session)
            packet.frameNumber = UInt64(bitPattern: seq)
            packet.isTerminator = (lenField & terminatorBit) != 0
            let len = Int(lenField & 0x1FFF)
            let start = data.startIndex + offset
            guard len >= 0, start + len <= data.endIndex else { return nil }
            packet.opusData = Data(data[start..<(start + len)])
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
                packet.positional = floats
            }
            return .audio(packet)
        case .protobuf:
            let body = data.dropFirst()
            switch first {
            case 0:
                var packet = AudioPacket()
                var reader = ProtobufReader(Data(body))
                do {
                    try reader.forEachField { field in
                        switch field.number {
                        case 1: packet.target = VoiceTargetID(UInt8(truncatingIfNeeded: field.uint32Value))
                        case 2: packet.context = AudioContext(rawValue: UInt8(truncatingIfNeeded: field.uint32Value)) ?? .other
                        case 3: packet.senderSession = field.uint32Value
                        case 4: packet.frameNumber = field.uint64Value
                        case 5: packet.opusData = field.payload
                        case 6:
                            if field.wireType == .fixed32 {
                                packet.positional.append(field.floatValue)
                            } else {
                                var i = field.payload.startIndex
                                while i + 4 <= field.payload.endIndex {
                                    var bits: UInt32 = 0
                                    withUnsafeMutableBytes(of: &bits) { $0.copyBytes(from: field.payload[i..<(i + 4)]) }
                                    packet.positional.append(Float(bitPattern: UInt32(littleEndian: bits)))
                                    i += 4
                                }
                            }
                        case 7: packet.volumeAdjustment = field.floatValue
                        case 16: packet.isTerminator = field.boolValue
                        default: break
                        }
                    }
                } catch {
                    return nil
                }
                return .audio(packet)
            case 1:
                var ping = UDPPing(timestamp: 0)
                var reader = ProtobufReader(Data(body))
                do {
                    try reader.forEachField { field in
                        switch field.number {
                        case 1: ping.timestamp = field.uint64Value
                        case 2: ping.requestExtendedInformation = field.boolValue
                        case 3: ping.serverVersionV2 = field.uint64Value
                        case 4: ping.userCount = field.uint32Value
                        case 5: ping.maxUserCount = field.uint32Value
                        case 6: ping.maxBandwidthPerUser = field.uint32Value
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

public enum ServerProbe {
    public struct Response: Equatable, Sendable {
        public var version: ProtocolVersion
        public var identifier: UInt64
        public var users: UInt32
        public var maxUsers: UInt32
        public var bandwidth: UInt32
    }

    public static func request(identifier: UInt64) -> Data {
        var data = Data([0, 0, 0, 0])
        for shift in stride(from: 56, through: 0, by: -8) {
            data.append(UInt8((identifier >> UInt64(shift)) & 0xFF))
        }
        return data
    }

    public static func parse(_ data: Data) -> Response? {
        guard data.count >= 24 else { return nil }
        let bytes = [UInt8](data)
        func u32(_ i: Int) -> UInt32 {
            UInt32(bytes[i]) << 24 | UInt32(bytes[i + 1]) << 16 | UInt32(bytes[i + 2]) << 8 | UInt32(bytes[i + 3])
        }
        var ident: UInt64 = 0
        for i in 4..<12 { ident = (ident << 8) | UInt64(bytes[i]) }
        return Response(
            version: ProtocolVersion(v1: u32(0)),
            identifier: ident,
            users: u32(12),
            maxUsers: u32(16),
            bandwidth: u32(20)
        )
    }
}
