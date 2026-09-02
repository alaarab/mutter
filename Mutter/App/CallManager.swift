import CallKit
import AVFoundation

/// Registers the Mumble session as a system call via CallKit. This is what keeps the app
/// alive in the background like a phone call, lets it coexist with other call apps
/// (starting a Teams call holds ours instead of killing it), and puts Mutter in the
/// system's call UI with a working mute button.
final class CallManager: NSObject, CXProviderDelegate {
    private let provider: CXProvider
    private let controller = CXCallController()
    private var currentCall: UUID?

    /// The user ended the call from the system UI (or another call app took over).
    var onEndFromSystem: (() -> Void)?
    /// Mute toggled from the system call UI.
    var onMuteFromSystem: ((Bool) -> Void)?
    /// Another call put ours on hold (true) or gave it back (false).
    var onHold: ((Bool) -> Void)?
    /// The system activated our audio session; a paused engine should restart now.
    var onAudioSessionActivated: (() -> Void)?

    override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = false
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    func reportCallStarted(serverName: String) {
        guard currentCall == nil else { return }
        let id = UUID()
        currentCall = id
        let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: serverName))
        controller.request(CXTransaction(action: action)) { [weak self] error in
            if error != nil {
                DispatchQueue.main.async { self?.currentCall = nil }
                DiagnosticsLog.shared.add("call", "CallKit start failed: \(error!.localizedDescription)")
            }
        }
    }

    func reportCallEnded() {
        guard let id = currentCall else { return }
        currentCall = nil
        controller.request(CXTransaction(action: CXEndCallAction(call: id))) { _ in }
    }

    /// Keeps the system call UI's mute state in sync with the app's.
    func setMuted(_ muted: Bool) {
        guard let id = currentCall else { return }
        controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) { _ in }
    }

    // MARK: - CXProviderDelegate (delegate queue is main)

    func providerDidReset(_ provider: CXProvider) {
        currentCall = nil
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        provider.reportOutgoingCall(with: action.callUUID, connectedAt: Date())
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if currentCall != nil {
            currentCall = nil
            DiagnosticsLog.shared.add("call", "ended from system UI")
            onEndFromSystem?()
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        onMuteFromSystem?(action.isMuted)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
        DiagnosticsLog.shared.add("call", action.isOnHold ? "held by another call" : "resumed from hold")
        onHold?(action.isOnHold)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        DiagnosticsLog.shared.add("call", "audio session activated by CallKit")
        onAudioSessionActivated?()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        DiagnosticsLog.shared.add("call", "audio session deactivated by CallKit")
    }
}
