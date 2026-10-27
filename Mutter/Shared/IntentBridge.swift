import Foundation

enum IntentAction: String, Sendable {
    case toggleMute
    case toggleDeafen
    case toggleTalk
    case disconnect
}

@MainActor
final class IntentBridge {
    static let shared = IntentBridge()
    var handler: (@MainActor (IntentAction) async -> Void)?

    func dispatch(_ action: IntentAction) async {
        await handler?(action)
    }
}
