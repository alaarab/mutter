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

struct AudioPreferences: Hashable {
    var transmitMode: TransmitMode
    var vadThresholdDb: Float
    var bitrate: Int
    var frameMilliseconds: Int
    var audioRoute: AudioRoute
    var mixWithOthers: Bool
    var noiseSuppression: NoiseSuppressor.Level
    var autoSensitivity: Bool
    var voiceProcessing: Bool
}

struct TurnPreferences: Hashable {
    var url: String
    var username: String
    var password: String
}

private extension UserDefaults {
    func value<Value>(_ key: String, default fallback: Value) -> Value {
        object(forKey: key) as? Value ?? fallback
    }

    func rawValue<Value: RawRepresentable>(_ key: String, default fallback: Value) -> Value where Value.RawValue == String {
        string(forKey: key).flatMap(Value.init(rawValue:)) ?? fallback
    }
}

@Observable
final class AppSettings {
    @ObservationIgnored private let defaults: UserDefaults

    var transmitMode: TransmitMode { didSet { defaults.set(transmitMode.rawValue, forKey: "transmitMode") } }
    var vadThresholdDb: Float { didSet { defaults.set(vadThresholdDb, forKey: "vadThresholdDb") } }
    var bitrate: Int { didSet { defaults.set(bitrate, forKey: "bitrate") } }
    var frameMilliseconds: Int { didSet { defaults.set(frameMilliseconds, forKey: "frameMilliseconds") } }
    var pushToTalkStyle: PushToTalkStyle { didSet { defaults.set(pushToTalkStyle.rawValue, forKey: "pushToTalkStyle") } }
    var audioRoute: AudioRoute { didSet { defaults.set(audioRoute.rawValue, forKey: "audioRoute") } }
    var mixWithOthers: Bool { didSet { defaults.set(mixWithOthers, forKey: "mixWithOthers") } }
    var turnURL: String { didSet { defaults.set(turnURL, forKey: "turnURL") } }
    var turnUsername: String { didSet { defaults.set(turnUsername, forKey: "turnUsername") } }
    var turnPassword: String { didSet { defaults.set(turnPassword, forKey: "turnPassword") } }
    var appearance: Appearance { didSet { defaults.set(appearance.rawValue, forKey: "appearance") } }
    var theme: ThemeStyle { didSet { defaults.set(theme.rawValue, forKey: "theme") } }
    var defaultUsername: String { didSet { defaults.set(defaultUsername, forKey: "defaultUsername") } }
    var notifyOnMessage: Bool { didSet { defaults.set(notifyOnMessage, forKey: "notifyOnMessage") } }
    var showPresenceNotices: Bool { didSet { defaults.set(showPresenceNotices, forKey: "showPresenceNotices") } }
    var keepScreenAwake: Bool { didSet { defaults.set(keepScreenAwake, forKey: "keepScreenAwake") } }
    var hapticsOnTransmit: Bool { didSet { defaults.set(hapticsOnTransmit, forKey: "hapticsOnTransmit") } }
    var defaultIdentityID: UUID? { didSet { defaults.set(defaultIdentityID?.uuidString, forKey: "defaultIdentityID") } }
    var hasSeenWelcome: Bool { didSet { defaults.set(hasSeenWelcome, forKey: "hasSeenWelcome") } }
    var hideEmptyChannels: Bool { didSet { defaults.set(hideEmptyChannels, forKey: "hideEmptyChannels") } }
    var noiseSuppression: NoiseSuppressor.Level { didSet { defaults.set(noiseSuppression.rawValue, forKey: "noiseSuppression") } }
    var voiceProcessing: Bool { didSet { defaults.set(voiceProcessing, forKey: "voiceProcessing") } }
    var autoSensitivity: Bool { didSet { defaults.set(autoSensitivity, forKey: "autoSensitivity") } }
    var headsetButtonAction: HeadsetAction { didSet { defaults.set(headsetButtonAction.rawValue, forKey: "headsetButtonAction") } }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        transmitMode = defaults.rawValue("transmitMode", default: .voiceActivity)
        vadThresholdDb = defaults.value("vadThresholdDb", default: -38)
        bitrate = defaults.value("bitrate", default: 40_000)
        frameMilliseconds = defaults.value("frameMilliseconds", default: 20)
        pushToTalkStyle = defaults.rawValue("pushToTalkStyle", default: .hold)
        audioRoute = AudioRoute(rawValue: defaults.string(forKey: "audioRoute") ?? "")
            ?? (defaults.value("speakerphone", default: true) ? .speaker : .earpiece)
        mixWithOthers = defaults.value("mixWithOthers", default: true)
        turnURL = defaults.string(forKey: "turnURL") ?? ""
        turnUsername = defaults.string(forKey: "turnUsername") ?? ""
        turnPassword = defaults.string(forKey: "turnPassword") ?? ""
        appearance = defaults.rawValue("appearance", default: .system)
        theme = defaults.rawValue("theme", default: .midnight)
        defaultUsername = defaults.string(forKey: "defaultUsername") ?? ""
        notifyOnMessage = defaults.value("notifyOnMessage", default: true)
        showPresenceNotices = defaults.value("showPresenceNotices", default: true)
        keepScreenAwake = defaults.value("keepScreenAwake", default: false)
        hapticsOnTransmit = defaults.value("hapticsOnTransmit", default: true)
        defaultIdentityID = defaults.string(forKey: "defaultIdentityID").flatMap(UUID.init(uuidString:))
        hasSeenWelcome = defaults.value("hasSeenWelcome", default: false)
        hideEmptyChannels = defaults.value("hideEmptyChannels", default: false)
        noiseSuppression = defaults.rawValue("noiseSuppression", default: .strong)
        voiceProcessing = defaults.value("voiceProcessing", default: true)
        autoSensitivity = defaults.value("autoSensitivity", default: true)
        headsetButtonAction = defaults.rawValue("headsetButtonAction", default: .toggleMute)
        Theme.style = theme
    }

    var audioPreferences: AudioPreferences {
        AudioPreferences(
            transmitMode: transmitMode,
            vadThresholdDb: vadThresholdDb,
            bitrate: bitrate,
            frameMilliseconds: frameMilliseconds,
            audioRoute: audioRoute,
            mixWithOthers: mixWithOthers,
            noiseSuppression: noiseSuppression,
            autoSensitivity: autoSensitivity,
            voiceProcessing: voiceProcessing
        )
    }

    var turnPreferences: TurnPreferences {
        TurnPreferences(url: turnURL, username: turnUsername, password: turnPassword)
    }
}
