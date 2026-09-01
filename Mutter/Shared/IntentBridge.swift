import Foundation

/// Actions the lock screen, Action button, Siri and headset buttons can trigger.
enum IntentAction: String, Sendable {
    case toggleMute
    case toggleDeafen
    case toggleTalk
    case disconnect
}

/// Live Activity intents run inside the app process; this is how they reach the app model
/// without the widget extension needing to know about it.
@MainActor
final class IntentBridge {
    static let shared = IntentBridge()
    var handler: (@MainActor (IntentAction) -> Void)?

    func dispatch(_ action: IntentAction) {
        handler?(action)
    }
}
