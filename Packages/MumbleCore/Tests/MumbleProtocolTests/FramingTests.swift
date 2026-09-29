import XCTest
@testable import MumbleProtocol

final class FramingTests: XCTestCase {
    func testFrameHeader() {
        let framed = ControlFraming.frame(type: 3, payload: Data([0xAA, 0xBB]))
        XCTAssertEqual([UInt8](framed), [0x00, 0x03, 0x00, 0x00, 0x00, 0x02, 0xAA, 0xBB])
    }

    func testParserReassemblesSplitFrames() throws {
        let first = ControlFraming.frame(type: 3, payload: Data([1, 2, 3]))
        let second = ControlFraming.frame(type: 9, payload: Data(repeating: 7, count: 100))
        let stream = first + second
        var parser = ControlFrameParser()
        var frames: [ControlFrame] = []
        var offset = 0
        while offset < stream.count {
            let chunk = min(5, stream.count - offset)
            parser.append(stream[offset..<(offset + chunk)])
            while let frame = try parser.nextFrame() {
                frames.append(frame)
            }
            offset += chunk
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
        let frame = try parser.nextFrame()
        XCTAssertEqual(frame, ControlFrame(type: 15, payload: Data()))
    }

    func testOversizedPayloadThrows() {
        var parser = ControlFrameParser()
        parser.append(Data([0, 0, 0xFF, 0xFF, 0xFF, 0xFF]))
        XCTAssertThrowsError(try parser.nextFrame())
    }

    func testManyFramesFromOneReadKeepTheirOrderAndPartialTail() throws {
        var stream = Data()
        for index in 0..<2_000 {
            stream.append(ControlFraming.frame(type: 1, payload: Data([UInt8(index % 256), UInt8(index / 256)])))
        }
        let tail = ControlFraming.frame(type: 7, payload: Data(repeating: 9, count: 50))
        var parser = ControlFrameParser()
        parser.append(stream + tail.prefix(20))
        var parsed: [ControlFrame] = []
        while let frame = try parser.nextFrame() {
            parsed.append(frame)
        }
        XCTAssertEqual(parsed.count, 2_000)
        XCTAssertEqual(parsed[1_234].payload, Data([UInt8(1_234 % 256), UInt8(1_234 / 256)]))
        XCTAssertEqual(parser.pendingBytes, 20)
        parser.append(tail.dropFirst(20))
        XCTAssertEqual(try parser.nextFrame(), ControlFrame(type: 7, payload: Data(repeating: 9, count: 50)))
        XCTAssertEqual(parser.pendingBytes, 0)
    }
}
