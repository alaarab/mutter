import SwiftUI
import ReplayKit
import WebRTC

struct RTCVideoSurface: UIViewRepresentable {
    var track: RTCVideoTrack?

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView(frame: .zero)
        view.videoContentMode = .scaleAspectFit
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {
        if context.coordinator.track !== track {
            context.coordinator.track?.remove(view)
            track?.add(view)
            context.coordinator.track = track
        }
    }

    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) { coordinator.track?.remove(view) }
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var track: RTCVideoTrack? }
}

struct ShareBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let shares = model.screenShare.availableShares
        if let share = shares.first, model.screenShare.watching == nil {
            Button { model.screenShare.watch(share) } label: {
                HStack(spacing: 10) {
                    Image(systemName: "rectangle.on.rectangle.fill").foregroundStyle(Theme.speaking)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(model.session.users[share.sender]?.name ?? "Someone") is sharing")
                            .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        Text(share.width > 0 ? "\(share.title) · \(share.width)×\(share.height)" : share.title)
                            .font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    Spacer()
                    Text("Watch").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accent)
                    Image(systemName: "chevron.right").font(.icon(12, .semibold)).foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.speaking.opacity(0.12))
                .overlay(alignment: .bottom) { Divider().overlay(Theme.separator) }
            }
            .buttonStyle(.plain)
        }
    }
}

struct ScreenShareViewer: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let share = model.screenShare
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            RTCVideoSurface(track: share.videoTrack).ignoresSafeArea()
            if share.videoTrack == nil {
                VStack(spacing: 12) {
                    ProgressView().tint(.white)
                    Text(share.error ?? share.connectionState).font(.subheadline).foregroundStyle(.white.opacity(0.8))
                        .multilineTextAlignment(.center).padding(.horizontal, 32)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            HStack(spacing: 10) {
                Button {
                    share.stopWatching()
                    dismiss()
                } label: {
                    Image(systemName: "xmark").font(.icon(15, .bold)).foregroundStyle(.white)
                        .frame(width: 36, height: 36).background(.white.opacity(0.15), in: Circle())
                }
                if let current = share.watching {
                    Text(model.session.users[current.sender]?.name ?? current.title).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                }
                Spacer()
                HStack(spacing: 6) {
                    Circle().fill(share.connectionState == "Live" ? Theme.speaking : Theme.warning).frame(width: 7, height: 7)
                    Text(share.stats.summary.isEmpty ? share.connectionState : share.stats.summary)
                        .font(.caption.weight(.medium)).foregroundStyle(.white.opacity(0.9)).monospacedDigit()
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(.black.opacity(0.45), in: Capsule())
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
        }
        .statusBarHidden()
        .onChange(of: share.watching == nil) { _, ended in if ended { dismiss() } }
    }
}

struct BroadcastPickerLauncher: UIViewRepresentable {
    var request: Int

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
        picker.preferredExtension = BroadcastChannel.extensionBundleIdentifier
        picker.showsMicrophoneButton = false
        picker.isUserInteractionEnabled = false
        picker.alpha = 0
        return picker
    }

    func updateUIView(_ picker: RPSystemBroadcastPickerView, context: Context) {
        guard request != context.coordinator.handledRequest else { return }
        context.coordinator.handledRequest = request
        for case let button as UIButton in picker.subviews {
            button.sendActions(for: .allTouchEvents)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(handledRequest: request) }

    final class Coordinator {
        var handledRequest: Int
        init(handledRequest: Int) { self.handledRequest = handledRequest }
    }
}

struct OwnShareBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let sharer = model.screenSharer
        if let share = sharer.sharing {
            HStack(spacing: 10) {
                Image(systemName: "rectangle.on.rectangle.angled.fill").foregroundStyle(Theme.speaking)
                VStack(alignment: .leading, spacing: 1) {
                    Text("You're sharing your screen")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    Text(Self.viewerLine(share.viewers))
                        .font(.caption).foregroundStyle(Theme.muted)
                }
                Spacer()
                Button("Stop") { sharer.stop() }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.danger)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("stop-screen-share")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .background(Theme.speaking.opacity(0.12))
            .overlay(alignment: .bottom) { Divider().overlay(Theme.separator) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("own-screen-share")
        } else if let problem = sharer.problem {
            Text(problem)
                .font(.caption)
                .foregroundStyle(Theme.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
        }
    }

    static func viewerLine(_ viewers: Int) -> String {
        switch viewers {
        case 0: return "Nobody is watching yet"
        case 1: return "1 person watching"
        default: return "\(viewers) people watching"
        }
    }
}
