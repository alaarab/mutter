import ReplayKit
import CoreImage
import ImageIO

final class SampleHandler: RPBroadcastSampleHandler {
    private let sendQueue = DispatchQueue(label: "com.alaarab.mutter.broadcast-send")
    private let imageContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()
    private let jpegQuality: Float = 0.6
    private var socketDescriptor: Int32 = -1
    private var closedSource: DispatchSourceRead?
    private var lastFrameAt: CFTimeInterval = 0
    private let sendingLock = NSLock()
    private var isSending = false
    private var hasFinished = false

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard let url = BroadcastChannel.socketURL, connect(to: url.path) else {
            finish(because: "Open Mutter and join a server before sharing your screen.")
            return
        }
        watchForClose()
    }

    override func broadcastFinished() {
        sendQueue.sync { closeSocket() }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }
        let now = CACurrentMediaTime()
        guard now - lastFrameAt >= 1 / Double(BroadcastChannel.framesPerSecond) else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let orientation = (CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber)?.uint8Value
            ?? UInt8(CGImagePropertyOrientation.up.rawValue)
        guard claimSendingSlot() else { return }
        guard let jpeg = encode(pixelBuffer) else {
            releaseSendingSlot()
            return
        }
        lastFrameAt = now
        let data = BroadcastFrameCodec.encode(BroadcastFrame(orientation: orientation, jpeg: jpeg))
        sendQueue.async {
            self.write(data)
            self.releaseSendingSlot()
        }
    }

    private func claimSendingSlot() -> Bool {
        sendingLock.lock()
        defer { sendingLock.unlock() }
        guard !isSending else { return false }
        isSending = true
        return true
    }

    private func releaseSendingSlot() {
        sendingLock.lock()
        isSending = false
        sendingLock.unlock()
    }

    private func encode(_ pixelBuffer: CVPixelBuffer) -> Data? {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let size = BroadcastCaptureSize.fitted(width: CVPixelBufferGetWidth(pixelBuffer), height: CVPixelBufferGetHeight(pixelBuffer))
        let scale = CGFloat(size.width) / CGFloat(max(1, CVPixelBufferGetWidth(pixelBuffer)))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let options = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): jpegQuality]
        return imageContext.jpegRepresentation(of: scaled, colorSpace: colorSpace, options: options)
    }

    private func connect(to path: String) -> Bool {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return false }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8)
        guard pathBytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            close(descriptor)
            return false
        }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: pathBytes)
            buffer[pathBytes.count] = 0
        }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            close(descriptor)
            return false
        }
        var noSignal: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        socketDescriptor = descriptor
        return true
    }

    private func watchForClose() {
        let descriptor = socketDescriptor
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: sendQueue)
        source.setEventHandler { [weak self] in
            var byte: UInt8 = 0
            if read(descriptor, &byte, 1) <= 0 {
                self?.closeSocket()
                self?.finish(because: "You stopped sharing your screen in Mutter.")
            }
        }
        closedSource = source
        source.resume()
    }

    private func write(_ data: Data) {
        guard socketDescriptor >= 0 else { return }
        let succeeded = data.withUnsafeBytes { buffer -> Bool in
            guard let base = buffer.baseAddress else { return false }
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(socketDescriptor, base + offset, buffer.count - offset)
                if written <= 0 {
                    if written < 0 && errno == EINTR { continue }
                    return false
                }
                offset += written
            }
            return true
        }
        if !succeeded {
            closeSocket()
            finish(because: "Mutter stopped receiving your screen.")
        }
    }

    private func closeSocket() {
        closedSource?.cancel()
        closedSource = nil
        if socketDescriptor >= 0 {
            close(socketDescriptor)
            socketDescriptor = -1
        }
    }

    private func finish(because reason: String) {
        sendingLock.lock()
        let alreadyFinished = hasFinished
        hasFinished = true
        sendingLock.unlock()
        guard !alreadyFinished else { return }
        finishBroadcastWithError(NSError(domain: "com.alaarab.mutter.broadcast", code: 1, userInfo: [NSLocalizedDescriptionKey: reason]))
    }
}
