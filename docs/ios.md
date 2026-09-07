# Mutter for iOS

The SwiftUI client connects directly to Mumble servers and uses libopus, Apple audio processing,
and WebRTC screen viewing. It also provides Live Activities, Dynamic Island, and App Intents.

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

Then build the `Mutter` scheme. Run the package tests with `swift test` from `Packages/MumbleCore`
(macOS) or via the scheme's Test action.

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

Git authentication is configured per checkout. If the Mac's default GitHub host uses
another repository's deploy key, use an SSH URL and select the appropriate account key
with local `core.sshCommand`. Keep machine paths and credentials out of committed files.

Build notes:

1. **Opus headers.** `Mutter/Audio/OpusShim/opus_shim.h` includes `<opus/opus.h>` with fallbacks.
   If the OnBeep `Opus` xcframework lays out headers differently, adjust the include or swap the
   package in `project.yml` (sbooth/opus-binary-xcframework also works; it needs the ogg package).
   The shim exists because `opus_encoder_ctl` is variadic and Swift cannot call it.
2. **Swift concurrency warnings.** The project currently uses Swift 5 language mode with minimal
   checking; moving to Swift 6 requires a separate concurrency pass.
3. **Keychain entitlement.** Certificates live in the keychain; the entitlements file is generated
   by XcodeGen from `project.yml`.


## Source layout

- `Mutter/`: app state, SwiftUI screens, audio, and platform integration.
- `Packages/MumbleCore/`: portable protocol codecs and Apple network transport.
- `MutterWidgets/`: Live Activity and Dynamic Island extension.
- `MutterUITests/`: appearance and interaction regression tests.

The Xcode project is generated from `project.yml`. Keep signing and deployment settings in the
ignored local configuration files. See [feature coverage](features.md) for platform differences.
