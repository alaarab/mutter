import Foundation
import MediaPlayer

/// Headset and lock-screen media controls. The play/pause button on AirPods, car kits and
/// Bluetooth headsets toggles mute (or talk, in push-to-talk mode), and Now Playing shows
/// the server and channel so the session is visible on the lock screen even without a Live Activity.
@MainActor
final class RemoteCommands {
    var onToggle: (@MainActor () -> Void)?
    private var targets: [(MPRemoteCommand, Any)] = []

    func activate() {
        guard targets.isEmpty else { return }
        let center = MPRemoteCommandCenter.shared()
        for command in [center.togglePlayPauseCommand, center.playCommand, center.pauseCommand] {
            command.isEnabled = true
            let target = command.addTarget { [weak self] _ in
                Task { @MainActor in self?.onToggle?() }
                return .success
            }
            targets.append((command, target))
        }
        for command in [center.nextTrackCommand, center.previousTrackCommand, center.skipForwardCommand, center.skipBackwardCommand] {
            command.isEnabled = false
        }
    }

    func deactivate() {
        for (command, target) in targets { command.removeTarget(target) }
        targets = []
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    func setNowPlaying(server: String, channel: String, muted: Bool, speakers: [String]) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: channel.isEmpty ? server : "# \(channel)",
            MPMediaItemPropertyArtist: speakers.isEmpty ? server : "\(server) · \(speakers.joined(separator: ", "))",
            MPNowPlayingInfoPropertyIsLiveStream: true,
            MPNowPlayingInfoPropertyPlaybackRate: muted ? 0.0 : 1.0,
        ]
        info[MPMediaItemPropertyAlbumTitle] = muted ? "Muted" : "Live"
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
