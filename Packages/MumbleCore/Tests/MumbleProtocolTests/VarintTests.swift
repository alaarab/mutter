import XCTest
@testable import MumbleProtocol

final class VarintTests: XCTestCase {
    private func roundTrip(_ value: Int64, expectedBytes: Int? = nil, file: StaticString = #filePath, line: UInt = #line) {
        let encoded = MumbleVarint.encoded(value)
        if let expectedBytes {
            XCTAssertEqual(encoded.count, expectedBytes, "byte count for \(value)", file: file, line: line)
        }
        var offset = 0
        let decoded = MumbleVarint.decode(encoded, offset: &offset)
        XCTAssertEqual(decoded, value, file: file, line: line)
        XCTAssertEqual(offset, encoded.count, file: file, line: line)
    }

    func testSmallPositive() {
        roundTrip(0, expectedBytes: 1)
        roundTrip(1, expectedBytes: 1)
        roundTrip(127, expectedBytes: 1)
        XCTAssertEqual([UInt8](MumbleVarint.encoded(0x45)), [0x45])
    }

    func testFourteenBit() {
        roundTrip(128, expectedBytes: 2)
        roundTrip(0x3FFF, expectedBytes: 2)
        XCTAssertEqual([UInt8](MumbleVarint.encoded(0x1234)), [0x80 | 0x12, 0x34])
    }

    func testTwentyOneBit() {
        roundTrip(0x4000, expectedBytes: 3)
        roundTrip(0x1FFFFF, expectedBytes: 3)
        XCTAssertEqual([UInt8](MumbleVarint.encoded(0x123456)), [0xC0 | 0x12, 0x34, 0x56])
    }

    func testTwentyEightBit() {
        roundTrip(0x200000, expectedBytes: 4)
        roundTrip(0xFFFFFFF, expectedBytes: 4)
    }

    func testThirtyTwoBit() {
        roundTrip(0x10000000, expectedBytes: 5)
        roundTrip(0xFFFFFFFF, expectedBytes: 5)
        XCTAssertEqual([UInt8](MumbleVarint.encoded(0xDEADBEEF)), [0xF0, 0xDE, 0xAD, 0xBE, 0xEF])
    }

    func testSixtyFourBit() {
        roundTrip(0x100000000, expectedBytes: 9)
        roundTrip(Int64.max, expectedBytes: 9)
    }

    func testNegatives() {
        XCTAssertEqual([UInt8](MumbleVarint.encoded(-1)), [0xFC])
        XCTAssertEqual([UInt8](MumbleVarint.encoded(-4)), [0xFF])
        for value: Int64 in [-1, -2, -3, -4] {
            roundTrip(value)
        }
        roundTrip(-5, expectedBytes: 2)
        roundTrip(-1000)
        roundTrip(-123456789)
    }

    func testTruncated() {
        var offset = 0
        XCTAssertNil(MumbleVarint.decode(Data([0x80]), offset: &offset))
        offset = 0
        XCTAssertNil(MumbleVarint.decode(Data([0xF4, 1, 2, 3]), offset: &offset))
        offset = 0
        XCTAssertNil(MumbleVarint.decode(Data(), offset: &offset))
    }

    func testSequentialDecode() {
        var encoded = Data()
        MumbleVarint.encode(5, into: &encoded)
        MumbleVarint.encode(300, into: &encoded)
        MumbleVarint.encode(70000, into: &encoded)
        var offset = 0
        XCTAssertEqual(MumbleVarint.decode(encoded, offset: &offset), 5)
        XCTAssertEqual(MumbleVarint.decode(encoded, offset: &offset), 300)
        XCTAssertEqual(MumbleVarint.decode(encoded, offset: &offset), 70000)
        XCTAssertEqual(offset, encoded.count)
    }
}
