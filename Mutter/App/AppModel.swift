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

/// Composition root: wires the Mumble client, the audio engine, saved servers and settings.
@MainActor
@Observable
final class AppModel {
    let settings = AppSettings()
    let servers = ServerStore()
    let client: MumbleClient
    let audio = AudioEngine()

    private(set) var identities: [ClientIdentity] = IdentityStore.shared.identities
    private(set) var activeServer: SavedServer?
    var trustPrompt: TrustPrompt?
    var toast: SessionNotice?
    var pendingChatScope: MessageScope?
    /// Channel IDs the user collapsed in the tree, per server.
    var collapsedChannels: [UUID: Set<UInt32>] = [:]

    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var lastNoticeCount = 0
    @ObservationIgnored private var lastMessageCount = 0

    var session: ServerSession { client.session }

    init() {
        client = MumbleClient()
        client.voiceSink = audio

        client.certificateTrust = { [weak self] question in
            await withCheckedContinuation { continuation in
                Task { @MainActor in
                    guard let self else { continuation.resume(returning: false); return }
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
        audio.onEncodedPacket = { [weak self] data, frames, terminator in
            self?.client.sendAudio(opus: data, frameCount: frames, isTerminator: terminator)
        }
        audio.onTransmitChanged = { [weak self] on in
            guard let self else { return }
            self.client.setTransmitting(on)
            if self.settings.hapticsOnTransmit && self.settings.transmitMode == .voiceActivity {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }
        applyAudioSettings()
    }

    // MARK: - Connecting

    func connect(_ server: SavedServer) {
        var s = server
        if s.username.isEmpty { s.username = settings.defaultUsername.isEmpty ? "Mutter" : settings.defaultUsername }
        activeServer = s
        var options = ConnectionOptions(username: s.username, password: servers.password(for: s))
        options.tokens = s.tokens
        options.expectedFingerprint = s.certificateFingerprint
        options.osVersion = UIDevice.current.systemVersion
        options.clientRelease = "Mutter \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1")"
        if let identityID = s.identityID ?? settings.defaultIdentityID,
           let identity = identities.first(where: { $0.id == identityID }) {
            options.identity = IdentityStore.shared.secIdentity(for: identity)
        }
        collapsedChannels[s.id] = collapsedChannels[s.id] ?? []
        lastNoticeCount = 0
        lastMessageCount = 0
        client.connect(to: s.endpoint, options: options)
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
    }

    /// Called by the root view whenever the session state changes.
    func sessionStateDidChange(_ state: ConnectionState) {
        switch state {
        case .connected:
            if let server = activeServer { servers.markConnected(server.id) }
            applyAudioSettings()
            audio.start()
            UIApplication.shared.isIdleTimerDisabled = settings.keepScreenAwake
        case .disconnected:
            audio.stop()
            UIApplication.shared.isIdleTimerDisabled = false
        default:
            break
        }
    }

    func applyAudioSettings() {
        audio.transmitMode = settings.transmitMode
        audio.vadThresholdDb = settings.vadThresholdDb
        audio.bitrate = Int32(settings.bitrate)
        audio.frameMilliseconds = settings.frameMilliseconds
        audio.useSpeaker = settings.speakerphone
    }

    // MARK: - Voice controls

    var isMuted: Bool { session.me?.isSelfMuted ?? false }
    var isDeafened: Bool { session.me?.isSelfDeafened ?? false }

    func toggleMute() {
        let next = !isMuted
        client.setSelfMute(next)
        audio.isMuted = next
        if !next { audio.isDeafened = false }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    func toggleDeafen() {
        let next = !isDeafened
        client.setSelfDeaf(next)
        audio.isDeafened = next
        if next { audio.isMuted = true }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
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
        UISelectionFeedbackGenerator().selectionChanged()
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

    // MARK: - Identities

    func reloadIdentities() {
        identities = IdentityStore.shared.identities
    }

    // MARK: - Notices, toasts, notifications

    /// Called by the root view when the session's notice list grows.
    func noticesDidChange(scenePhase: ScenePhase) {
        let notices = session.notices
        guard notices.count > lastNoticeCount else { lastNoticeCount = notices.count; return }
        let fresh = notices[lastNoticeCount...]
        lastNoticeCount = notices.count
        for notice in fresh {
            switch notice {
            case .textMessage(let m):
                if scenePhase != .active && settings.notifyOnMessage {
                    postNotification(title: m.senderName, body: HTMLText.plainText(m.html))
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
