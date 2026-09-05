import XCTest
@testable import MumbleProtocol

final class ProtobufTests: XCTestCase {
    func testVarintFieldEncoding() {
        var writer = ProtobufWriter()
        writer.uint32(1, 150)
        XCTAssertEqual([UInt8](writer.data), [0x08, 0x96, 0x01])
    }

    func testStringFieldEncoding() {
        var writer = ProtobufWriter()
        writer.string(2, "testing")
        XCTAssertEqual([UInt8](writer.data), [0x12, 0x07] + Array("testing".utf8))
    }

    func testNegativeInt32IsTenBytes() {
        var writer = ProtobufWriter()
        writer.int32(1, -1)
        XCTAssertEqual(writer.data.count, 11)
        var reader = ProtobufReader(writer.data)
        let field = try! reader.next()!
        XCTAssertEqual(field.int32Value, -1)
    }

    func testFloatRoundTrip() {
        var writer = ProtobufWriter()
        writer.float(8, 12.5)
        var reader = ProtobufReader(writer.data)
        let field = try! reader.next()!
        XCTAssertEqual(field.number, 8)
        XCTAssertEqual(field.wireType, .fixed32)
        XCTAssertEqual(field.floatValue, 12.5)
    }

    func testReaderSkipsUnknownFields() throws {
        var writer = ProtobufWriter()
        writer.uint32(1, 7)
        writer.bytes(99, Data([1, 2, 3]))
        writer.uint64(2, UInt64.max)
        var reader = ProtobufReader(writer.data)
        var seen: [Int] = []
        try reader.forEachField { seen.append($0.number) }
        XCTAssertEqual(seen, [1, 99, 2])
    }

    func testTruncatedLengthDelimitedThrows() {
        var reader = ProtobufReader(Data([0x12, 0x10, 0x01]))
        XCTAssertThrowsError(try reader.next())
    }
}
