# Mutter docs

[Read the published docs](https://alaarab.github.io/mutter/).

Start with the guide for the app you want to run: desktop, Mac, iOS, Android, or web.

## Run an app

| Platform | Guide |
| --- | --- |
| Browser | [Local bridge, browser support, and tests](../web/README.md) |
| iPhone | [Xcode setup, signing, and phone deployment](ios.md) |
| Android | [Build an APK, install it, and run tests](../android/README.md) |
| Electron | [Desktop builds, packaging, and global push to talk](../desktop/README.md) |

## Understand the app

- [Feature coverage](features.md): what each client supports and where they differ.
- [Phone layout](phone-layout.md): channels, chat, call controls, and settings.
- [Design system](design.md): themes, fonts, color roles, and motion.
- [Mumble protocol](protocol.md): connections, messages, and voice transport.
- [Screen sharing](screen-share.md): Mutter’s WebRTC extension.
- [TURN setup](turn.md): helping video connect when a direct connection is blocked.
- [Publishing the docs](publishing.md): preview the site and keep GitHub Pages up to date.

## Find the code

| Path | What lives there |
| --- | --- |
| `web/` | Browser interface, JavaScript protocol, local bridge, and shared test server |
| `desktop/` | Electron shell, capture picker integration, packaging, and global push to talk |
| `android/` | Kotlin/Compose app, transport, audio, storage, and device tests |
| `Mutter/` | SwiftUI app, audio, and iOS integration |
| `MutterWidgets/`, `MutterUITests/` | Live Activities and iOS UI tests |
| `Packages/MumbleCore/` | Swift protocol, transport, identities, and package tests |
| `design/` | Shared theme catalog and licensed fonts |
| `scripts/` | Asset generation and device deployment helpers |
| `.github/workflows/` | Build checks and desktop release packaging |

The platform guides include their test commands. For an interface change, also check the
generated palettes and check the running apps.
