# Mutter for Android

Native Kotlin and Jetpack Compose client for Android 10 and newer. It connects directly to
Mumble servers; a desktop computer, web bridge, or hosted backend is not required.

## Build and install

Open this directory in Android Studio, or use JDK 21 and an Android SDK with platform 37.
The checked-in Gradle wrapper pins the Android plugin’s supported Gradle 9.6 line. Set `ANDROID_HOME` to your SDK,
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

Builds are debug-only until a release signing key is set up. Debug builds are debuggable, so
anyone with `run-as` access to the app on the phone (for example over USB debugging) can use
its Keystore key to decrypt the stored server passwords, tokens and certificates.

## Included

- TLS connections that accept certificates the system trusts for the host and pin the rest per
  host and port, with first-contact and changed-certificate prompts for self-signed servers,
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
- WebRTC screen viewing and screen sharing compatible with the other Mutter clients. Share
  screen in the call options menu asks Android for screen-capture consent, then shares the
  whole screen (up to 1280 pixels on the longest side, 30 fps, no audio) with people in your
  channel. Stop it from the banner, the call notification, or the system's cast indicator.
- All 11 shared themes in light, dark, and system appearance, miniature theme previews,
  shared typography and motion, and an adaptive/monochrome launcher icon from `docs/brand/icon.svg`.
- The shared phone layout: Channels, Chat, and Server tabs; an indented channel tree; circular
  avatars; the same call dock, grouped settings, and profiles as iPhone. Keyboard Send, large text,
  and short-window adaptations keep controls usable. See [the phone layout guide](../docs/phone-layout.md).

Server passwords, access tokens, pins and certificate files are encrypted with a device-bound
Android Keystore key. Backup and device transfer exclude this data. Signing keys and local
SDK paths are ignored by Git. The app never transmits login credentials before the server
certificate is trusted. If the saved data can't be decrypted, Mutter keeps the unreadable copy,
starts fresh, and says so. Audio processing availability depends on the device; Bluetooth and physical microphone
quality still need testing on real Android hardware.

## Validation

Run unit tests, lint, and app/device-test builds with JDK 21 and the Android SDK. Kotlin
and lint warnings fail the build. `lint.xml` documents the single, version-specific Gradle update exception:
Gradle 9.8 triggers a deprecated API call inside AGP 9.4.1, so the wrapper stays on 9.6.1.

Android 17 requires Nearby devices permission for LAN servers, discovery and direct local
screen sharing. Connecting requests it alongside the existing optional permissions; the
local directory also provides an explicit permission button. Public internet connections
remain available when local access is denied. `LocalNetworkPermissionTest` exercises the
system prompt on a fresh install (or after revoking Nearby devices before instrumentation).

```bash
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest --warning-mode=fail
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

Run the integration suite on one emulator at a time; its fault-injection server is shared.
For local Linux UI checks, `emulator -gpu host -no-window` needs a working X11 `DISPLAY`.
Host GPU rendering avoids System UI hangs observed with software rendering on this test host.
Tests use the emulator's `10.0.2.2` host address and ports 64740–64746. They cover actual TLS
consent, both voice formats, encrypted UDP and TCP voice, chat, channel changes, background
connections, automatic reconnect, notification controls, UDP interruption and recovery, changed
certificates, password rejection, channel edits, all theme variants, server-edit recreation,
encrypted storage tamper recovery, PKCS#12 import, and platform Opus capture/encoding/decoding.
A physical test device can use
`-Pandroid.testInstrumentationRunnerArguments.mumbleHost=YOUR_MAC_ADDRESS` if the test
servers are explicitly configured to listen on that interface.

Unit tests use upstream OCB2 vectors and cover varints, framing, malformed input, replay and
reordered packets, and fragmented screen-share signals. Reports live under `app/build/reports/`.

The optional desktop-to-Android video test starts its own server and browser sharer:

```bash
CHROME=/path/to/chromium node android/test-share.mjs
```

It asserts that the Android viewer decodes real 640×360 video frames. The reverse check has
Android share a synthetic 640×360 screen and a desktop client watch it:

```bash
CHROME=/path/to/chromium node android/test-phone-share.mjs
```

Both instrumentation tests are skipped in the ordinary suite unless these helpers provide the
sharing-server argument. Real screen capture needs the system consent dialog, so check it by
hand on a device.

The shared palette generator writes Android's `assets/themes.json` and launch colors alongside
Swift and browser outputs. Fonts are read from `design/fonts`; Gradle
generates Android launcher resources from the master SVG on every relevant rebuild.
