# Mutter for Android

Native Kotlin and Jetpack Compose client for Android 10 and newer. It connects directly to
Mumble servers; a desktop computer, web bridge, or hosted backend is not required.

## Build and install

Open this directory in Android Studio, or use JDK 21 and an Android SDK with platform 36.
The checked-in Gradle wrapper pins the build tool version. Set `ANDROID_HOME` to your SDK,
or set `sdk.dir` in the ignored `local.properties` file.

From the repository root:

```bash
node scripts/generate-themes.mjs --check
python3 scripts/deploy-android.py --build-only
python3 scripts/deploy-android.py --device YOUR_ADB_SERIAL
```

The helper detects the Homebrew JDK on this Mac. Elsewhere, set `JAVA_HOME` to JDK 21.
Enable USB debugging and authorize the Mac on the phone before installing. With exactly
one connected device, `--device` is optional. Installing an update preserves app data.

APKs appear in `app/build/outputs/apk/debug/`. Use `app-arm64-v8a-debug.apk` for current
Android phones, or the universal APK for other supported devices. These are development
builds signed with the local Android debug key; store distribution requires a release key.
Keep that key across releases so future builds can update existing installs.

## Included

- TLS connections with explicit first-contact and changed-certificate prompts, saved pins,
  generated RSA identities, PKCS#12 import, per-server identity selection, and access tokens.
- Opus microphone capture and playback, encrypted OCB2 UDP, TCP fallback and UDP recovery,
  Mumble 1.2–1.5 wire formats, reconnect, push to talk, voice activity, open mic, and whisper.
- Android foreground call service, notification mute/deafen/disconnect actions, headset
  media controls, speaker/headset routing, and platform echo cancellation/noise suppression.
- Saved servers, favorites, recent ordering, occupancy/latency probes, the public directory,
  and local network discovery.
- Channel navigation/search, user lists, channel creation and editing, listeners, local
  mute/volume, permission-gated moderation, and registered-user management.
- Channel and direct chat, formatted text/links, inline attached images, photo attachments
  resized to server limits, unread counts, and direct-message notifications.
- WebRTC screen viewing compatible with the other Mutter clients. Screen broadcasting and
  share audio are not included.
- All 11 shared themes in light, dark, and system appearance, miniature theme previews,
  shared typography and motion, and an adaptive/monochrome launcher icon from `docs/brand/icon.svg`.
- Adaptive call controls and people cards, speaking/mute indicators, grouped settings and profiles,
  and a chat composer with keyboard Send support and layouts for small or landscape windows.

Server passwords, access tokens, pins and certificate files are encrypted with a device-bound
Android Keystore key. Backup and device transfer exclude this data. Signing keys and local
SDK paths are ignored by Git. The app never transmits login credentials before certificate
consent. Audio processing availability depends on the device; Bluetooth and physical microphone
quality still need testing on real Android hardware.

## Validation

[Validation results and device scenarios](VALIDATION.md) record tested Android versions, layout
checks, permission recovery, and the remaining physical-device work.

```bash
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

For emulator integration tests, start the shared protocol test servers from the repository
root, then run the instrumentation suite in another terminal:

```bash
node android/test-server.mjs
```

In another terminal:

```bash
cd android
./gradlew connectedDebugAndroidTest
```

Tests use the emulator's `10.0.2.2` host address and ports 64740–64746. They cover actual TLS
consent, both voice formats, encrypted UDP and TCP voice, chat, channel changes, background
connections, automatic reconnect, notification controls, UDP interruption and recovery, changed
certificates, password rejection, channel edits, all theme variants, server-edit recreation,
encrypted storage tamper detection, PKCS#12 import, and platform Opus capture/encoding/decoding.
A physical test device can use
`-Pandroid.testInstrumentationRunnerArguments.mumbleHost=YOUR_MAC_ADDRESS` if the test
servers are explicitly configured to listen on that interface.

Unit tests use upstream OCB2 vectors and cover varints, framing, malformed input, replay and
reordered packets, and fragmented screen-share signals. Reports live under `app/build/reports/`.

The optional desktop-to-Android video test starts its own server and browser sharer:

```bash
CHROME=/path/to/chromium node android/test-share.mjs
```

It asserts that the Android viewer decodes real 640×360 video frames. Its instrumentation
test is skipped in the ordinary suite unless this helper provides the sharing-server argument.

The shared palette generator writes Android's `assets/themes.json` and launch colors alongside
Swift and browser outputs. Fonts are read from `design/fonts`; Gradle
generates Android launcher resources from the master SVG on every relevant rebuild.
