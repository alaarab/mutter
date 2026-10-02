# Mutter for iOS

The SwiftUI client connects directly to Mumble servers and uses libopus, Apple audio processing,
and WebRTC screen viewing and sharing. It also provides Live Activities, Dynamic Island, and App Intents.

Commands below run from the repository root. Shared fonts and themes live in `design/`.

## Build and install


Requirements: Xcode 26.6, iOS 17+ device or simulator, [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
brew install xcodegen
cd mutter
xcodegen generate
open Mutter.xcodeproj
```

Signing reads your Team ID from `Local.xcconfig`, which is gitignored so it stays out of this
public repo. Copy `Local.xcconfig.example` to `Local.xcconfig`, put your 10-character Team ID in
it, and re-run `xcodegen generate`. Setting the team in Xcode's Signing & Capabilities tab instead
works until the next regenerate, which throws it away.

Screen sharing uses a Broadcast Upload Extension (`MutterBroadcast`, bundle id
`com.alaarab.mutter.broadcast`) and the App Group `group.com.alaarab.mutter`, shared with the app.
With automatic signing, Xcode registers both the first time it provisions them. If it can't, create
the App Group in the Apple Developer portal and enable it for `com.alaarab.mutter` and
`com.alaarab.mutter.broadcast`, then build again.

Then build the `Mutter` scheme. The app, its widget and the broadcast extension share one version:
change `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `project.yml`.

For repeatable phone deployment, copy `Local.deploy.json.example` to the ignored
`Local.deploy.json`. Set the paired device identifier from `xcrun devicectl list devices`
and the paths to this Mac's existing build keychain and its owner-only password file.
Then run:

```bash
python3 scripts/deploy-phone.py
```

The command unlocks the build keychain, puts it first while signing, and restores the
previous keychain search order afterward. This avoids selecting duplicate signing keys
from a locked login keychain. It then verifies the signature, installs the update, and
launches Mutter. `--device` overrides the saved phone; optional `derived_data` and
`source_packages` paths let you reuse an existing build and Swift package cache.
Omit the keychain fields when using Xcode's ordinary interactive signing setup.

## TestFlight

TestFlight builds need an app record for `com.alaarab.mutter` in App Store Connect, and a Mac
that can sign for your team. Put an App Store Connect API key in `~/.config/ios-release.json`
(`key_id`, `issuer_id`, `key_path` pointing at the `.p8` file) so Xcode can create the App Group
and extension profiles without an Apple ID signed into Xcode. If `Local.deploy.json` names a
build keychain, the release uses it the same way the phone deploy does. Then run:

```bash
python3 scripts/release-ios.py --build-number 2            # signed archive and IPA
python3 scripts/release-ios.py --build-number 3 --upload   # upload to TestFlight
```

Use a build number higher than any already uploaded. The version comes from `MARKETING_VERSION`
in `project.yml`. Archives go under `~/Library/Developer/Xcode/Archives/mutter/`. Uploading only
sends the build to TestFlight; it does not submit it for App Review.

Git authentication is configured per checkout. If the Mac's default GitHub host uses
another repository's deploy key, use an SSH URL and select the appropriate account key
with local `core.sshCommand`. Keep machine paths and credentials out of committed files.

Build notes:

1. **Opus headers.** `Mutter/Audio/OpusShim/opus_shim.h` includes `<opus/opus.h>` with fallbacks.
   The shim exists because `opus_encoder_ctl` is variadic and Swift cannot call it. Opus-iOS
   1.9.0 retains quoted includes and an incomplete framework umbrella; only those two vendor
   packaging diagnostics are suppressed around its import. Warnings in app code stay enabled.
2. **Swift concurrency warnings.** The project currently uses Swift 5 language mode with minimal
   checking; moving to Swift 6 requires a separate concurrency pass.
3. **Keychain entitlement.** Certificates live in the keychain; the entitlements file is generated
   by XcodeGen from `project.yml`.
4. **App Intents metadata.** Extraction stays enabled for the app and widgets and is skipped
   for the broadcast extension and test targets, which define no intents. The scheme uses
   project-owned unit test bundles with the same Swift package test sources so this setting
   also applies to protocol and client tests. Compiler warnings stay enabled.


## Tests

- `swift test --package-path Packages/MumbleCore` runs the protocol and client package tests on macOS.
- The scheme's Test action runs those plus the UI tests. The chat keyboard tests connect to the
  fake server, so start `node web/test/fake-server.mjs 64740` on the Mac first; without it they skip.
- `node --test web/test/native.test.mjs` (macOS) compiles the app's audio playout, credential
  storage, reconnect, screen-signaling and ICE batching code into small probes. Run it after
  changing those files, including `Mutter/ScreenShare/ICECandidateBatcher.swift`.

## Source layout

- `Mutter/`: app state, SwiftUI screens, audio, and platform integration.
- `Packages/MumbleCore/`: portable protocol codecs and Apple network transport.
- `MutterWidgets/`: Live Activity and Dynamic Island extension.
- `MutterUITests/`: appearance and interaction regression tests.

The Xcode project is generated from `project.yml`. Keep signing and deployment settings in the
ignored local configuration files. See [feature coverage](features.md) for platform differences.
