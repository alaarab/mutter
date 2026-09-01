import AppIntents
import Foundation

enum MutterIntentError: Error, CustomLocalizedStringResourceConvertible {
    case appNotRunning
    case serverNotFound

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .appNotRunning: return "Open Mutter first."
        case .serverNotFound: return "That server isn't saved in Mutter."
        }
    }
}

struct ServerEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Mumble server"
    static var defaultQuery = ServerQuery()

    let id: String
    let name: String
    let host: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(host)")
    }
}

struct ServerQuery: EntityQuery {
    @MainActor
    private func all() -> [ServerEntity] {
        let store = AppModel.shared?.servers ?? ServerStore()
        return store.servers.map { ServerEntity(id: $0.id.uuidString, name: $0.displayName, host: $0.endpoint.displayString) }
    }

    func entities(for identifiers: [String]) async throws -> [ServerEntity] {
        await all().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [ServerEntity] {
        await all()
    }
}

struct ConnectToServerIntent: AppIntent {
    static var title: LocalizedStringResource = "Connect to server"
    static var description = IntentDescription("Connect to a saved Mumble server.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Server")
    var server: ServerEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Connect to \(\.$server)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let model = AppModel.shared else { throw MutterIntentError.appNotRunning }
        guard let saved = model.servers.servers.first(where: { $0.id.uuidString == server.id }) else {
            throw MutterIntentError.serverNotFound
        }
        model.connect(saved)
        return .result()
    }
}

struct MutterShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ConnectToServerIntent(),
            phrases: ["Connect to \(\.$server) in \(.applicationName)", "Join \(\.$server) in \(.applicationName)"],
            shortTitle: "Connect",
            systemImageName: "bolt.fill"
        )
        AppShortcut(
            intent: ToggleMuteIntent(),
            phrases: ["Toggle mute in \(.applicationName)", "Mute me in \(.applicationName)", "Unmute me in \(.applicationName)"],
            shortTitle: "Toggle mute",
            systemImageName: "mic.slash.fill"
        )
        AppShortcut(
            intent: ToggleTalkIntent(),
            phrases: ["Push to talk in \(.applicationName)", "Talk in \(.applicationName)"],
            shortTitle: "Push to talk",
            systemImageName: "hand.tap.fill"
        )
        AppShortcut(
            intent: ToggleDeafenIntent(),
            phrases: ["Toggle deafen in \(.applicationName)"],
            shortTitle: "Toggle deafen",
            systemImageName: "speaker.slash.fill"
        )
        AppShortcut(
            intent: DisconnectIntent(),
            phrases: ["Disconnect \(.applicationName)", "Leave the server in \(.applicationName)"],
            shortTitle: "Disconnect",
            systemImageName: "phone.down.fill"
        )
    }
}
