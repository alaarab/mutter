import SwiftUI

extension Bundle {
    var shortVersion: String? {
        infoDictionary?["CFBundleShortVersionString"] as? String
    }
}

@main
struct MutterApp: App {
    @State private var model = AppModel()

    init() {
        let large = UINavigationBarAppearance()
        large.configureWithTransparentBackground()
        if let display = UIFont(name: "BricolageDisplay-ExtraBold", size: 32) {
            large.largeTitleTextAttributes = [.font: display, .kern: -0.6]
        }
        if let title = UIFont(name: "BricolageDisplay-Bold", size: 17) {
            large.titleTextAttributes = [.font: title, .kern: -0.2]
        }
        UINavigationBar.appearance().standardAppearance = large
        UINavigationBar.appearance().scrollEdgeAppearance = large

        VoiceActivityController.endAllOnLaunch()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(model.settings.appearance.colorScheme)
                .tint(Theme.accent)
                .id(model.settings.theme)
                .onChange(of: model.settings.theme, initial: true) { _, style in
                    Theme.style = style
                }
        }
    }
}
