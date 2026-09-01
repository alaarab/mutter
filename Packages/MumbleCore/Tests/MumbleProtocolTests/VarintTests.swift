import XCTest
@testable import MumbleProtocol

final class VarintTests: XCTestCase {

    private func roundTrip(_ v: Int64, expectedBytes: Int? = nil, file: StaticString = #filePath, line: UInt = #line) {
        let d = MumbleVarint.encoded(v)
        if let expectedBytes { XCTAssertEqual(d.count, expectedBytes, "byte count for \(v)", file: file, line: line) }
        var off = 0
        let decoded = MumbleVarint.decode(d, offset: &off)
        XCTAssertEqual(decoded, v, file: file, line: line)
        XCTAssertEqual(off, d.count, file: file, line: line)
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
        roundTrip(-1); roundTrip(-2); roundTrip(-3); roundTrip(-4)
        roundTrip(-5, expectedBytes: 2)
        roundTrip(-1000)
        roundTrip(-123456789)
    }

    func testTruncated() {
        var off = 0
        XCTAssertNil(MumbleVarint.decode(Data([0x80]), offset: &off))
        off = 0
        XCTAssertNil(MumbleVarint.decode(Data([0xF4, 1, 2, 3]), offset: &off))
        off = 0
        XCTAssertNil(MumbleVarint.decode(Data(), offset: &off))
    }

    func testSequentialDecode() {
        var d = Data()
        MumbleVarint.encode(5, into: &d)
        MumbleVarint.encode(300, into: &d)
        MumbleVarint.encode(70000, into: &d)
        var off = 0
        XCTAssertEqual(MumbleVarint.decode(d, offset: &off), 5)
        XCTAssertEqual(MumbleVarint.decode(d, offset: &off), 300)
        XCTAssertEqual(MumbleVarint.decode(d, offset: &off), 70000)
        XCTAssertEqual(off, d.count)
    }
}
