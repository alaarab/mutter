import Foundation
import SwiftUI
import Observation

enum Appearance: String, CaseIterable, Identifiable, Codable {
    case system, light, dark
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: return "Match system"
        case .light: return "Paper"
        case .dark: return "Ink"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

enum HeadsetAction: String, CaseIterable, Identifiable, Codable {
    case toggleMute, toggleTalk, nothing
    var id: String { rawValue }
    var title: String {
        switch self {
        case .toggleMute: return "Toggle mute"
        case .toggleTalk: return "Push to talk (toggle)"
        case .nothing: return "Do nothing"
        }
    }
}

enum PushToTalkStyle: String, CaseIterable, Identifiable, Codable {
    case hold, toggle
    var id: String { rawValue }
    var title: String { self == .hold ? "Hold to talk" : "Tap to toggle" }
}

/// User preferences, persisted in UserDefaults.
@Observable
final class AppSettings {
    @ObservationIgnored private let defaults: UserDefaults

    var transmitMode: TransmitMode { didSet { defaults.set(transmitMode.rawValue, forKey: "transmitMode") } }
    var vadThresholdDb: Float { didSet { defaults.set(vadThresholdDb, forKey: "vadThresholdDb") } }
    var bitrate: Int { didSet { defaults.set(bitrate, forKey: "bitrate") } }
    var frameMilliseconds: Int { didSet { defaults.set(frameMilliseconds, forKey: "frameMilliseconds") } }
    var pushToTalkStyle: PushToTalkStyle { didSet { defaults.set(pushToTalkStyle.rawValue, forKey: "pushToTalkStyle") } }
    var speakerphone: Bool { didSet { defaults.set(speakerphone, forKey: "speakerphone") } }
    var appearance: Appearance { didSet { defaults.set(appearance.rawValue, forKey: "appearance") } }
    var defaultUsername: String { didSet { defaults.set(defaultUsername, forKey: "defaultUsername") } }
    var notifyOnMessage: Bool { didSet { defaults.set(notifyOnMessage, forKey: "notifyOnMessage") } }
    var showPresenceNotices: Bool { didSet { defaults.set(showPresenceNotices, forKey: "showPresenceNotices") } }
    var keepScreenAwake: Bool { didSet { defaults.set(keepScreenAwake, forKey: "keepScreenAwake") } }
    var hapticsOnTransmit: Bool { didSet { defaults.set(hapticsOnTransmit, forKey: "hapticsOnTransmit") } }
    var defaultIdentityID: UUID? { didSet { defaults.set(defaultIdentityID?.uuidString, forKey: "defaultIdentityID") } }
    var hasSeenWelcome: Bool { didSet { defaults.set(hasSeenWelcome, forKey: "hasSeenWelcome") } }
    var hideEmptyChannels: Bool { didSet { defaults.set(hideEmptyChannels, forKey: "hideEmptyChannels") } }
    var headsetButtonAction: HeadsetAction { didSet { defaults.set(headsetButtonAction.rawValue, forKey: "headsetButtonAction") } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        transmitMode = TransmitMode(rawValue: defaults.string(forKey: "transmitMode") ?? "") ?? .voiceActivity
        vadThresholdDb = defaults.object(forKey: "vadThresholdDb") as? Float ?? -38
        bitrate = defaults.object(forKey: "bitrate") as? Int ?? 40_000
        frameMilliseconds = defaults.object(forKey: "frameMilliseconds") as? Int ?? 20
        pushToTalkStyle = PushToTalkStyle(rawValue: defaults.string(forKey: "pushToTalkStyle") ?? "") ?? .hold
        speakerphone = defaults.object(forKey: "speakerphone") as? Bool ?? true
        appearance = Appearance(rawValue: defaults.string(forKey: "appearance") ?? "") ?? .system
        defaultUsername = defaults.string(forKey: "defaultUsername") ?? ""
        notifyOnMessage = defaults.object(forKey: "notifyOnMessage") as? Bool ?? true
        showPresenceNotices = defaults.object(forKey: "showPresenceNotices") as? Bool ?? true
        keepScreenAwake = defaults.object(forKey: "keepScreenAwake") as? Bool ?? false
        hapticsOnTransmit = defaults.object(forKey: "hapticsOnTransmit") as? Bool ?? true
        defaultIdentityID = defaults.string(forKey: "defaultIdentityID").flatMap(UUID.init(uuidString:))
        hasSeenWelcome = defaults.bool(forKey: "hasSeenWelcome")
        hideEmptyChannels = defaults.bool(forKey: "hideEmptyChannels")
        headsetButtonAction = HeadsetAction(rawValue: defaults.string(forKey: "headsetButtonAction") ?? "") ?? .toggleMute
    }
}
