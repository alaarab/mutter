import XCTest
@testable import MumbleProtocol

final class FramingTests: XCTestCase {

    func testFrameHeader() {
        let d = ControlFraming.frame(type: 3, payload: Data([0xAA, 0xBB]))
        XCTAssertEqual([UInt8](d), [0x00, 0x03, 0x00, 0x00, 0x00, 0x02, 0xAA, 0xBB])
    }

    func testParserReassemblesSplitFrames() throws {
        let f1 = ControlFraming.frame(type: 3, payload: Data([1, 2, 3]))
        let f2 = ControlFraming.frame(type: 9, payload: Data(repeating: 7, count: 100))
        let all = f1 + f2
        var parser = ControlFrameParser()
        var frames: [ControlFrame] = []
        // Feed in awkward chunk sizes.
        var i = 0
        while i < all.count {
            let n = min(5, all.count - i)
            parser.append(all[i..<(i + n)])
            while let f = try parser.nextFrame() { frames.append(f) }
            i += n
        }
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames[0], ControlFrame(type: 3, payload: Data([1, 2, 3])))
        XCTAssertEqual(frames[1].type, 9)
        XCTAssertEqual(frames[1].payload.count, 100)
        XCTAssertEqual(parser.pendingBytes, 0)
    }

    func testEmptyPayload() throws {
        var parser = ControlFrameParser()
        parser.append(ControlFraming.frame(type: 15, payload: Data()))
        let f = try parser.nextFrame()
        XCTAssertEqual(f, ControlFrame(type: 15, payload: Data()))
    }

    func testOversizedPayloadThrows() {
        var parser = ControlFrameParser()
        parser.append(Data([0, 0, 0xFF, 0xFF, 0xFF, 0xFF]))
        XCTAssertThrowsError(try parser.nextFrame())
    }
}
