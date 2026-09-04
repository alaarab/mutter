import Foundation
import Observation
import MumbleClient
import MumbleProtocol

/// Typing indicator over the plugin channel — docs/extensions.md, byte for byte with Mutter Web.
/// data = [state] for a DM, [state][channelId uint32 BE] for channel typing.
@MainActor
@Observable
final class TypingIndicatorModel {
    static let dataId = "mutter/typing"
    private static let repeatEvery: TimeInterval = 3
    private static let idleAfter: TimeInterval = 5
    private static let forgetAfter: TimeInterval = 6

    struct Typer { let session: UInt32; let channelId: UInt32?; var lastSeen: Date }
    private(set) var typers: [UInt32: Typer] = [:]

    @ObservationIgnored private let client: MumbleClient
    @ObservationIgnored private var activeScope: MessageScope?
    @ObservationIgnored private var lastStartAt: Date?
    @ObservationIgnored private var announcedTo: Set<UInt32> = []
    @ObservationIgnored private var idleTask: Task<Void, Never>?
    @ObservationIgnored private var sweep: Timer?

    init(client: MumbleClient) {
        self.client = client
        sweep = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.expire() }
        }
    }

    /// People currently typing where the chat is looking.
    func typers(in scope: MessageScope) -> [User] {
        let session = client.session
        let matching: [UInt32]
        switch scope {
        case .channel(let id), .tree(let id): matching = typers.values.filter { $0.channelId == id }.map(\.session)
        case .user(let id): matching = typers.values.filter { $0.channelId == nil && $0.session == id }.map(\.session)
        case .system: matching = []
        }
        return matching.compactMap { session.users[$0] }.sorted { $0.name < $1.name }
    }

    // MARK: - Sending

    func draftChanged(_ text: String, scope: MessageScope) {
        guard client.session.isConnected else { return }
        if text.isEmpty { stop(); return }
        if let active = activeScope, active != scope { sendStop() }
        activeScope = scope
        let now = Date()
        if lastStartAt.map({ now.timeIntervalSince($0) >= Self.repeatEvery }) ?? true {
            sendStart(scope); lastStartAt = now
        }
        idleTask?.cancel()
        idleTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.idleAfter * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.stop()
        }
    }

    func sent() { stop() }

    func stop() {
        idleTask?.cancel(); idleTask = nil
        guard activeScope != nil else { return }
        sendStop()
        activeScope = nil; lastStartAt = nil
    }

    func reset() {
        idleTask?.cancel(); idleTask = nil
        typers.removeAll(); announcedTo.removeAll(); activeScope = nil; lastStartAt = nil
    }

    private func receivers(for scope: MessageScope) -> [UInt32] {
        let s = client.session
        switch scope {
        case .channel(let id), .tree(let id): return s.users(in: id).map(\.session).filter { $0 != s.mySession }
        case .user(let id): return [id]
        case .system: return []
        }
    }

    private func payload(state: UInt8, scope: MessageScope) -> Data {
        var d = Data([state])
        if case .channel(let id) = scope { d.append(contentsOf: withUnsafeBytes(of: id.bigEndian, Array.init)) }
        if case .tree(let id) = scope { d.append(contentsOf: withUnsafeBytes(of: id.bigEndian, Array.init)) }
        return d
    }

    private func sendStart(_ scope: MessageScope) {
        let to = receivers(for: scope)
        guard !to.isEmpty else { return }
        client.sendPluginData(to: to, dataId: Self.dataId, data: payload(state: 1, scope: scope))
        announcedTo.formUnion(to)
    }

    private func sendStop() {
        guard let scope = activeScope else { return }
        // Everyone a start went to, minus anyone who has since left.
        let to = announcedTo.filter { client.session.users[$0] != nil }
        announcedTo.removeAll()
        guard !to.isEmpty else { return }
        client.sendPluginData(to: Array(to), dataId: Self.dataId, data: payload(state: 0, scope: scope))
    }

    // MARK: - Receiving

    func handle(_ p: PluginDataTransmissionMessage) {
        guard p.dataId == Self.dataId, let from = p.senderSession, from != client.session.mySession else { return }
        let bytes = [UInt8](p.data)
        guard let state = bytes.first, state == 0 || state == 1 else { return }
        var channelId: UInt32? = nil
        if bytes.count >= 5 {
            channelId = UInt32(bytes[1]) << 24 | UInt32(bytes[2]) << 16 | UInt32(bytes[3]) << 8 | UInt32(bytes[4])
        }
        if state == 1 { typers[from] = Typer(session: from, channelId: channelId, lastSeen: Date()) }
        else { typers[from] = nil }
    }

    private func expire() {
        let cutoff = Date().addingTimeInterval(-Self.forgetAfter)
        let stale = typers.filter { $0.value.lastSeen < cutoff }.map(\.key)
        for s in stale { typers[s] = nil }
    }
}
