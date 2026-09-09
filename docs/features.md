# Feature coverage

Mutter has four clients: browser, iOS, Android, and Electron. Implementation coverage describes
available code; it is separate from validation on particular browsers, OS versions, and devices.

## Shared capabilities

All four clients provide saved servers, Mumble connections, encrypted voice with TCP fallback,
push to talk, voice activation, mute/deafen, channel navigation, chat, images, certificate trust,
reconnect, and Mutter screen viewing. All use the same 11 themes, light/dark appearance, fonts,
brand mark, and semantic color roles.

The browser and Electron share one interface and protocol implementation. iOS and Android use
native interfaces and independent protocol implementations that speak the same wire formats.

## Platform differences

| Area | Browser | iOS | Android | Electron |
| --- | --- | --- | --- | --- |
| Mumble transport | Local Node bridge | Direct TLS/UDP | Direct TLS/UDP | Bundled Node bridge |
| Audio codec | WebCodecs Opus | libopus | Android MediaCodec Opus | Chromium WebCodecs Opus |
| Audio processing | Browser processing, RNNoise or spectral suppression | Apple processing, spectral suppression, adaptive gate | Device-provided echo cancellation, noise suppression, gain control | Chromium processing, RNNoise or spectral suppression |
| Background controls | Browser-dependent | Live Activities, Now Playing, App Intents | Foreground call notification and media controls | Desktop shell and global push to talk |
| Screen/camera broadcasting | Supported browser capture | Viewer | Viewer | Desktop picker and camera capture |
| Screen-share audio | Browser capture capabilities | Not implemented | Not implemented | Windows loopback capture; OS-dependent elsewhere |
| LAN discovery | Not implemented | Bonjour | Android NSD | Not implemented |
| Password and identity storage | Session-only passwords; bridge identity | Apple Keychain | Android Keystore encryption | OS-encrypted passwords; bridge identity |
| Installation | Local bridge, optional browser app shortcut | Signed iOS app | Signed Android APK | Windows, macOS, Linux packages |

Voice in the browser requires Chromium features used by the client; see the
[browser guide](../web/README.md). Native audio processing and Bluetooth routing depend on the
device. The Android development build supports Android 10+; its [build guide](../android/README.md#validation)
includes device and protocol test commands.

## Platform guides

- [Browser features and tests](../web/README.md)
- [iOS build and integration](ios.md)
- [Android features and tests](../android/README.md)
- [Electron features and packaging](../desktop/README.md)
- [Screen-sharing wire protocol](screen-share.md)

## Remaining work

Full ACL/group and ban-list editors, positional audio, recording, and server-defined context
actions are not implemented across the clients. Mobile screen broadcasting and share audio need
dedicated platform work. Android real-device audio quality, accessory routing, OEM power
management, and release signing remain separate from emulator and protocol validation.
