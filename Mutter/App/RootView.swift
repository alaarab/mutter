import SwiftUI
import MumbleClient

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model
        Group {
            if model.activeServer != nil && model.session.state.isActive {
                SessionView()
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                HomeView()
                    .transition(.opacity)
            }
        }
        .animation(.snappy, value: model.session.state.isActive)
        .background(Theme.background.ignoresSafeArea())
        .sheet(item: $model.trustPrompt) { prompt in
            CertificateTrustSheet(prompt: prompt)
                .interactiveDismissDisabled()
        }
        .onChange(of: model.session.state) { _, state in
            model.sessionStateDidChange(state)
        }
        .onChange(of: model.session.notices.count) { _, _ in
            model.noticesDidChange(scenePhase: scenePhase)
        }
    }
}
