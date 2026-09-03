import SwiftUI
import MumbleClient

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var model = model
        Group {
            if model.activeServer != nil && model.session.state.isActive && !model.isSessionMinimized {
                SessionView()
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                HomeView()
                    .transition(.opacity)
            }
        }
        .animation(.snappy, value: model.session.state.isActive)
        .animation(.snappy, value: model.isSessionMinimized)
        .background(Theme.background.ignoresSafeArea())
        .sheet(item: $model.trustPrompt) { prompt in
            CertificateTrustSheet(prompt: prompt)
                .interactiveDismissDisabled()
        }
        .onChange(of: model.session.state) { _, state in
            model.sessionStateDidChange(state)
        }
        .onChange(of: scenePhase) { _, phase in
            DiagnosticsLog.shared.add("app", "scene → \(phase)")
            switch phase {
            case .background: model.setBackgrounded(true)
            case .active: model.setBackgrounded(false)
            default: break
            }
        }
        .onChange(of: model.session.notices.count) { _, _ in
            model.noticesDidChange(scenePhase: scenePhase)
        }
    }
}
