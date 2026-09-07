# Mutter

A Mumble client for browser, iOS, Android, and Electron desktop. Voice, channels, chat, and screen
viewing share the same visual style and 11 light/dark themes across platforms.

Mutter uses the standard Mumble protocol: TLS control, encrypted UDP voice, Opus, and TCP fallback.
The native mobile apps connect directly. Browser and Electron share a web client and a local Node
bridge. Screen sharing uses Mutter's WebRTC extension alongside the Mumble connection.

## Choose a platform

| Platform | Run or build | Guide |
| --- | --- | --- |
| Browser | `node web/bridge/server.mjs` | [Browser](web/README.md) |
| iOS | `xcodegen generate`, then open `Mutter.xcodeproj` | [iOS](docs/ios.md) |
| Android | `python3 scripts/deploy-android.py --build-only` | [Android](android/README.md) |
| Electron | `cd desktop && npm ci && npm start` | [Desktop](desktop/README.md) |

Mobile deployment helpers install and launch development builds:

```sh
python3 scripts/deploy-phone.py
python3 scripts/deploy-android.py --device YOUR_ADB_SERIAL
```

The iOS helper reads ignored local signing configuration. Android installation requires an
authorized device or emulator. See each platform guide for its toolchain and signing setup.

## Repository

| Path | Responsibility |
| --- | --- |
| `design/` | Shared theme catalog and licensed fonts |
| `docs/brand/icon.svg` | Master mark used to generate platform icons |
| `web/` | Browser interface, JavaScript protocol, local bridge, and shared test server |
| `desktop/` | Electron shell, desktop capture picker, packaging, and global push to talk |
| `android/` | Kotlin/Compose app, direct transport, audio, storage, and device tests |
| `Mutter/` | SwiftUI app, audio, and iOS integration |
| `MutterWidgets/`, `MutterUITests/` | iOS extensions and UI checks |
| `Packages/MumbleCore/` | Swift protocol, transport, identities, and protocol tests |
| `scripts/` | Shared asset generation and device deployment |
| `.github/workflows/` | Build, palette, and release checks |

Shared assets belong in `design/`; individual platforms consume or generate their resources from
there. Protocol implementations stay platform-native and are checked against common wire formats
and interoperability scenarios. Platform capabilities and testing limits are in
[feature coverage](docs/features.md).

## Shared assets

```sh
node scripts/generate-themes.mjs
node scripts/generate-themes.mjs --check
swift scripts/make-appicon.swift
```

Edit `design/themes.json` for colors and `docs/brand/icon.svg` for the mark. The palette generator
writes the Swift, Kotlin asset, browser, and launch-color outputs; the icon script requires
`resvg`. Android generates its vector launcher resources during the Gradle build. Generated
outputs should be refreshed through these tools. See [the design guide](docs/design.md).

## Development checks

```sh
node scripts/generate-themes.mjs --check
swift test --package-path Packages/MumbleCore
node --test web/test/bridge.test.mjs web/test/peer-certificate.test.mjs
node --test desktop/test/persistence.test.mjs
cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

Browser integration checks require Chromium. Electron checks require a GUI session. Android
device checks use an emulator and the local protocol test server. Each platform guide lists
the full commands; [Android validation](android/VALIDATION.md) records tested configurations and
remaining hardware checks.
