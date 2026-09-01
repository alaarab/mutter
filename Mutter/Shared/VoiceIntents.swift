import AppIntents

// These conform to LiveActivityIntent so the system runs them in the app process when
// tapped on the lock screen or in the Dynamic Island. They also work as plain App Intents
// for Shortcuts, Siri and the Action button.

struct ToggleMuteIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Toggle mute"
    static var description = IntentDescription("Mute or unmute your microphone in Mutter.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        await IntentBridge.shared.dispatch(.toggleMute)
        return .result()
    }
}

struct ToggleDeafenIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Toggle deafen"
    static var description = IntentDescription("Stop or resume hearing other people in Mutter.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        await IntentBridge.shared.dispatch(.toggleDeafen)
        return .result()
    }
}

struct ToggleTalkIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Push to talk"
    static var description = IntentDescription("Start or stop talking in Mutter. In push-to-talk mode this toggles the talk button; otherwise it toggles mute.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        await IntentBridge.shared.dispatch(.toggleTalk)
        return .result()
    }
}

struct DisconnectIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Disconnect"
    static var description = IntentDescription("Leave the current Mumble server.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult {
        await IntentBridge.shared.dispatch(.disconnect)
        return .result()
    }
}
