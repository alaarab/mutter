import SwiftUI

@main
struct MutterApp: App {
    @State private var model = AppModel()

    init() {
        // Serif display type for navigation titles, matching the server and channel names.
        let large = UINavigationBarAppearance()
        large.configureWithTransparentBackground()
        if let serif = UIFontDescriptor.preferredFontDescriptor(withTextStyle: .largeTitle).withDesign(.serif) {
            large.largeTitleTextAttributes = [.font: UIFont(descriptor: serif, size: 34)]
        }
        if let serifTitle = UIFontDescriptor.preferredFontDescriptor(withTextStyle: .headline).withDesign(.serif) {
            large.titleTextAttributes = [.font: UIFont(descriptor: serifTitle, size: 18)]
        }
        UINavigationBar.appearance().standardAppearance = large
        UINavigationBar.appearance().scrollEdgeAppearance = large

        // Clear any Live Activity left running by a previous launch that was killed mid-session.
        VoiceActivityController.endAllOnLaunch()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(model.settings.appearance.colorScheme)
                .tint(Theme.accent)
                // Theme.* are resolved statically, so swap the palette and rebuild the tree.
                .id(model.settings.theme)
                .onChange(of: model.settings.theme, initial: true) { _, style in
                    Theme.style = style
                }
        }
    }
}
