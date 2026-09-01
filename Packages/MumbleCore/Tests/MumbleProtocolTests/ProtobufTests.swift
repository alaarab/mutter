import XCTest
@testable import MumbleProtocol

final class ProtobufTests: XCTestCase {

    func testVarintFieldEncoding() {
        var w = ProtobufWriter()
        w.uint32(1, 150)
        // Canonical protobuf example: field 1 varint 150 => 08 96 01
        XCTAssertEqual([UInt8](w.data), [0x08, 0x96, 0x01])
    }

    func testStringFieldEncoding() {
        var w = ProtobufWriter()
        w.string(2, "testing")
        XCTAssertEqual([UInt8](w.data), [0x12, 0x07] + Array("testing".utf8))
    }

    func testNegativeInt32IsTenBytes() {
        var w = ProtobufWriter()
        w.int32(1, -1)
        XCTAssertEqual(w.data.count, 11)
        var r = ProtobufReader(w.data)
        let f = try! r.next()!
        XCTAssertEqual(f.int32Value, -1)
    }

    func testFloatRoundTrip() {
        var w = ProtobufWriter()
        w.float(8, 12.5)
        var r = ProtobufReader(w.data)
        let f = try! r.next()!
        XCTAssertEqual(f.number, 8)
        XCTAssertEqual(f.wireType, .fixed32)
        XCTAssertEqual(f.floatValue, 12.5)
    }

    func testReaderSkipsUnknownFields() throws {
        var w = ProtobufWriter()
        w.uint32(1, 7)
        w.bytes(99, Data([1, 2, 3]))
        w.uint64(2, UInt64.max)
        var r = ProtobufReader(w.data)
        var seen: [Int] = []
        try r.forEachField { seen.append($0.number) }
        XCTAssertEqual(seen, [1, 99, 2])
    }

    func testTruncatedLengthDelimitedThrows() {
        var r = ProtobufReader(Data([0x12, 0x10, 0x01]))
        XCTAssertThrowsError(try r.next())
    }
}
