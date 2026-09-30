import Foundation
import CoreVideo
import CoreGraphics
import ImageIO
import WebRTC

final class BroadcastReceiver {
    var onConnect: (() -> Void)?
    var onDisconnect: (() -> Void)?
    var onFrame: ((RTCVideoFrame) -> Void)?

    private let queue = DispatchQueue(label: "com.alaarab.mutter.broadcast-receiver")
    private var listeningDescriptor: Int32 = -1
    private var clientDescriptor: Int32 = -1
    private var listenSource: DispatchSourceRead?
    private var clientSource: DispatchSourceRead?
    private var reader = BroadcastFrameReader()
    private var pixelBufferPool: CVPixelBufferPool?
    private var poolWidth = 0
    private var poolHeight = 0
    private let readChunkSize = 64 * 1024

    var isAvailable: Bool { BroadcastChannel.socketURL != nil }

    func start() -> Bool {
        guard let url = BroadcastChannel.socketURL else { return false }
        return queue.sync { listen(at: url.path) }
    }

    func stop() {
        queue.sync {
            closeClient(notify: false)
            listenSource?.cancel()
            listenSource = nil
            if let url = BroadcastChannel.socketURL { unlink(url.path) }
        }
    }

    func disconnectClient() {
        queue.async { self.closeClient(notify: true) }
    }

    private func listen(at path: String) -> Bool {
        if listenSource != nil { return true }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        unlink(path)
        guard var address = Self.address(for: path) else {
            close(descriptor)
            return false
        }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, Darwin.listen(descriptor, 1) == 0 else {
            close(descriptor)
            return false
        }
        _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
        listeningDescriptor = descriptor
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        source.setEventHandler { [weak self] in self?.acceptClient() }
        source.setCancelHandler { close(descriptor) }
        listenSource = source
        source.resume()
        return true
    }

    private static func address(for path: String) -> sockaddr_un? {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard pathBytes.count < capacity else { return nil }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: pathBytes)
            buffer[pathBytes.count] = 0
        }
        return address
    }

    private func acceptClient() {
        let descriptor = accept(listeningDescriptor, nil, nil)
        guard descriptor >= 0 else { return }
        guard clientDescriptor < 0 else {
            close(descriptor)
            return
        }
        var noSignal: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        clientDescriptor = descriptor
        reader = BroadcastFrameReader()
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        source.setEventHandler { [weak self] in self?.readClient() }
        source.setCancelHandler { close(descriptor) }
        clientSource = source
        source.resume()
        onConnect?()
    }

    private func readClient() {
        var chunk = [UInt8](repeating: 0, count: readChunkSize)
        let count = read(clientDescriptor, &chunk, chunk.count)
        guard count > 0 else {
            if count == 0 || (errno != EAGAIN && errno != EINTR) { closeClient(notify: true) }
            return
        }
        do {
            let frames = try reader.append(Data(chunk[0..<count]))
            if let newest = frames.last { deliver(newest) }
        } catch {
            closeClient(notify: true)
        }
    }

    private func closeClient(notify: Bool) {
        guard clientDescriptor >= 0 else { return }
        clientSource?.cancel()
        clientSource = nil
        clientDescriptor = -1
        if notify { onDisconnect?() }
    }

    private func deliver(_ frame: BroadcastFrame) {
        guard let source = CGImageSourceCreateWithData(frame.jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              let pixelBuffer = pixelBuffer(for: image) else { return }
        let buffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let timestamp = Int64(DispatchTime.now().uptimeNanoseconds)
        onFrame?(RTCVideoFrame(buffer: buffer, rotation: Self.rotation(for: frame.orientation), timeStampNs: timestamp))
    }

    private func pixelBuffer(for image: CGImage) -> CVPixelBuffer? {
        let width = image.width
        let height = image.height
        if pixelBufferPool == nil || width != poolWidth || height != poolHeight {
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
                kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
            ]
            var pool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool)
            pixelBufferPool = pool
            poolWidth = width
            poolHeight = height
        }
        guard let pool = pixelBufferPool else { return nil }
        var created: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &created) == kCVReturnSuccess, let pixelBuffer = created else { return nil }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let context = CGContext(
            data: CVPixelBufferGetBaseAddress(pixelBuffer),
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer),
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return pixelBuffer
    }

    static func rotation(for orientation: UInt8) -> RTCVideoRotation {
        switch CGImagePropertyOrientation(rawValue: UInt32(orientation)) {
        case .down, .downMirrored: return ._180
        case .left, .leftMirrored: return ._90
        case .right, .rightMirrored: return ._270
        default: return ._0
        }
    }
}
