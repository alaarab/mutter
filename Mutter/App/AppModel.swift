import Foundation
import SwiftUI
import Observation
import UserNotifications
import MumbleProtocol
import MumbleClient

struct TrustPrompt: Identifiable {
    let id = UUID()
    let question: CertificateTrustQuestion
    let respond: (Bool) -> Void
}

@MainActor
@Observable
final class AppModel {
    static weak var shared: AppModel?

    let settings = AppSettings()
    let servers = ServerStore()
    let client: MumbleClient
    let audio = AudioEngine()
    let screenShare: ScreenShareModel

    private(set) var identities: [ClientIdentity] = IdentityStore.shared.identities
    private(set) var activeServer: SavedServer?
    var isSessionMinimized = false
    private(set) var whisperTarget: WhisperTarget?
    var isWhisperMode = false { didSet { syncTransmitTarget() } }
    private(set) var isWhisperHeld = false

    @ObservationIgnored private let liveActivity = VoiceActivityController()
    @ObservationIgnored private let remote = RemoteCommands()
    @ObservationIgnored private var presenceTimer: Timer?
    var trustPrompt: TrustPrompt?
    var toast: SessionNotice?
    var pendingChatScope: MessageScope?
    var collapsedChannels: [UUID: Set<UInt32>] = [:]

    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var lastNoticeCount = 0

    var session: ServerSession { client.session }

    init() {
        client = MumbleClient()
        screenShare = ScreenShareModel(client: client)
        client.voiceSink = audio
        AppModel.shared = self
        client.onPluginData = { [weak self] plugin in
            guard plugin.dataId == RTCSignal.dataId else { return }
            self?.screenShare.handle(plugin)
        }

        client.certificateTrust = { [weak self] question in
            await withCheckedContinuation { continuation in
                Task { @MainActor in
                    guard let self else {
                        continuation.resume(returning: false)
                        return
                    }
                    self.trustPrompt = TrustPrompt(question: question) { ok in
                        self.trustPrompt = nil
                        continuation.resume(returning: ok)
                    }
                }
            }
        }
        client.didAcceptCertificate = { [weak self] endpoint, info in
            Task { @MainActor in
                self?.servers.setFingerprint(info.sha256Fingerprint, for: endpoint)
            }
        }
        let client = self.client
        audio.onEncodedPacket = { data, frames, terminator, target in
            client.sendAudio(opus: data, frameCount: frames, isTerminator: terminator, target: target)
        }
        audio.onTransmitChanged = { [weak self] on in
            Task { @MainActor in
                guard let self else { return }
                self.client.setTransmitting(on)
                if self.settings.hapticsOnTransmit && self.settings.transmitMode == .voiceActivity {
                    Haptics.impact(.light)
                }
                self.refreshPresence()
            }
        }
        IntentBridge.shared.handler = { [weak self] action in
            guard let self else { return }
            switch action {
            case .toggleMute: self.toggleMute()
            case .toggleDeafen: self.toggleDeafen()
            case .toggleTalk: self.toggleTalk()
            case .disconnect: self.disconnect()
            }
        }
        remote.onToggle = { [weak self] in
            guard let self else { return }
            switch self.settings.headsetButtonAction {
            case .toggleMute: self.toggleMute()
            case .toggleTalk: self.toggleTalk()
            case .nothing: break
            }
        }
        applyAudioSettings()
    }

    func connect(_ server: SavedServer) {
        var target = server
        if target.username.isEmpty { target.username = settings.defaultUsername.isEmpty ? "Mutter" : settings.defaultUsername }
        activeServer = target
        var options = ConnectionOptions(username: target.username, password: servers.password(for: target))
        options.tokens = target.tokens
        options.expectedFingerprint = target.certificateFingerprint
        options.osVersion = UIDevice.current.systemVersion
        options.clientRelease = "Mutter \(Bundle.main.shortVersion ?? "0.1")"
        if let identityID = target.identityID ?? settings.defaultIdentityID,
           let identity = identities.first(where: { $0.id == identityID }) {
            options.identity = IdentityStore.shared.secIdentity(for: identity)
        }
        collapsedChannels[target.id] = collapsedChannels[target.id] ?? []
        isSessionMinimized = false
        lastNoticeCount = 0
        client.connect(to: target.endpoint, options: options)
        requestNotificationPermission()
    }

    func quickConnect(host: String, port: UInt16, username: String) {
        let server = SavedServer(name: "", host: host, port: port, username: username, isFavorite: false)
        servers.upsert(server)
        connect(server)
    }

    func disconnect() {
        client.disconnect()
        audio.stop()
        activeServer = nil
        whisperTarget = nil
        isWhisperMode = false
        stopPresence()
    }

    func sessionStateDidChange(_ state: ConnectionState) {
        DiagnosticsLog.shared.add("connection", "state → \(state)\(session.lastError.map { " (\($0))" } ?? "")")
        switch state {
        case .connected:
            if let server = activeServer { servers.markConnected(server.id) }
            applyAudioSettings()
            applyShareSettings()
            audio.start()
            UIApplication.shared.isIdleTimerDisabled = settings.keepScreenAwake
            if let target = whisperTarget { client.setVoiceTarget(VoiceTargetID(1), entries: target.entries) }
            startPresence()
        case .disconnected:
            audio.stop()
            screenShare.reset()
            UIApplication.shared.isIdleTimerDisabled = false
            stopPresence()
        default:
            break
        }
    }

    func setBackgrounded(_ backgrounded: Bool) {
        guard session.state.isActive, !backgrounded else { return }
        audio.ensureRunning()
    }

    func applyShareSettings() {
        let url = settings.turnURL.trimmingCharacters(in: .whitespaces)
        screenShare.turnServer = url.isEmpty ? nil : (url: url, username: settings.turnUsername, password: settings.turnPassword)
    }

    func applyAudioSettings() {
        audio.transmitMode = settings.transmitMode
        audio.vadThresholdDb = settings.vadThresholdDb
        audio.bitrate = Int32(settings.bitrate)
        audio.frameMilliseconds = settings.frameMilliseconds
        audio.route = settings.audioRoute
        audio.mixWithOthers = settings.mixWithOthers
        audio.noiseSuppression = settings.noiseSuppression
        audio.autoSensitivity = settings.autoSensitivity
        audio.useVoiceProcessing = settings.voiceProcessing
    }

    var isMuted: Bool { session.me?.isSelfMuted ?? false }
    var isDeafened: Bool { session.me?.isSelfDeafened ?? false }

    func toggleMute() {
        let next = !isMuted
        client.setSelfMute(next)
        audio.isMuted = next
        if !next { audio.isDeafened = false }
        Haptics.impact(.medium)
    }

    func toggleDeafen() {
        let next = !isDeafened
        client.setSelfDeaf(next)
        audio.isDeafened = next
        if next { audio.isMuted = true }
        Haptics.impact(.medium)
    }

    func toggleTalk() {
        if settings.transmitMode == .pushToTalk {
            audio.isPushToTalkPressed.toggle()
            Haptics.impact(.rigid)
        } else {
            toggleMute()
        }
        refreshPresence()
    }

    func setWhisperTarget(_ target: WhisperTarget?) {
        whisperTarget = target
        if let target {
            client.setVoiceTarget(VoiceTargetID(1), entries: target.entries)
        } else {
            isWhisperMode = false
            isWhisperHeld = false
        }
        syncTransmitTarget()
    }

    func setWhisperHeld(_ held: Bool) {
        guard whisperTarget != nil, !isMuted else { return }
        isWhisperHeld = held
        syncTransmitTarget()
        if settings.transmitMode == .pushToTalk {
            audio.isPushToTalkPressed = held
        }
    }

    private func syncTransmitTarget() {
        let whisper = whisperTarget != nil && (isWhisperMode || isWhisperHeld)
        audio.transmitTarget = whisper ? VoiceTargetID(1) : .normal
    }

    var isWhisperingNow: Bool { audio.transmitTarget != .normal }

    private func startPresence() {
        remote.activate()
        liveActivity.start(serverName: activeServer?.displayName ?? session.endpoint?.displayString ?? "Mutter", state: presenceState())
        presenceTimer?.invalidate()
        presenceTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshPresence() }
        }
        refreshPresence()
    }

    private func stopPresence() {
        presenceTimer?.invalidate()
        presenceTimer = nil
        liveActivity.end()
        remote.deactivate()
    }

    private func presenceState() -> VoiceActivityAttributes.ContentState {
        VoiceActivityAttributes.ContentState(
            channelName: session.myChannel?.name ?? "",
            speakers: Array(session.talkingUsers.filter { $0.session != session.mySession }.map { $0.name }.prefix(4)),
            isMuted: isMuted,
            isDeafened: isDeafened,
            isTransmitting: audio.isTransmitting,
            onlineCount: session.users.count,
            isPushToTalk: settings.transmitMode == .pushToTalk,
            isWhispering: isWhisperingNow
        )
    }

    func refreshPresence() {
        guard session.isConnected else { return }
        let state = presenceState()
        liveActivity.update(state)
        remote.setNowPlaying(
            server: activeServer?.displayName ?? "Mutter",
            channel: state.channelName,
            muted: state.isMuted,
            speakers: state.speakers
        )
    }

    func setLocalMute(_ user: User, muted: Bool) {
        client.setLocalMute(session: user.session, muted: muted)
    }

    func setLocalVolume(_ user: User, volume: Float) {
        client.setLocalVolume(session: user.session, volume: volume)
        audio.setVolume(volume, for: user.session)
    }

    func join(_ channel: Channel) {
        client.join(channel: channel.id)
        Haptics.selection()
    }

    func toggleCollapsed(_ channelID: UInt32) {
        guard let id = activeServer?.id else { return }
        var set = collapsedChannels[id] ?? []
        if set.contains(channelID) { set.remove(channelID) } else { set.insert(channelID) }
        collapsedChannels[id] = set
    }

    func isCollapsed(_ channelID: UInt32) -> Bool {
        guard let id = activeServer?.id else { return false }
        return collapsedChannels[id]?.contains(channelID) ?? false
    }

    func reloadIdentities() {
        identities = IdentityStore.shared.identities
    }

    func noticesDidChange(scenePhase: ScenePhase) {
        let notices = session.notices
        guard notices.count > lastNoticeCount else {
            lastNoticeCount = notices.count
            return
        }
        let fresh = notices[lastNoticeCount...]
        lastNoticeCount = notices.count
        for notice in fresh {
            switch notice {
            case .textMessage(let message):
                if scenePhase != .active && settings.notifyOnMessage {
                    postNotification(title: message.senderName, body: HTMLText.plainText(message.html))
                }
            case .userJoined, .userLeft, .userMoved:
                if settings.showPresenceNotices { showToast(notice) }
            case .permissionDenied, .info, .disconnected:
                showToast(notice)
            case .connected:
                break
            }
        }
    }

    private func showToast(_ notice: SessionNotice) {
        toast = notice
        toastTask?.cancel()
        toastTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            if !Task.isCancelled { toast = nil }
        }
    }

    private func requestNotificationPermission() {
        guard settings.notifyOnMessage else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    private func postNotification(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
