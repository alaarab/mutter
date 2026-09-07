# Android validation

Validation uses ARM64 Android emulators on this Mac. Network integration tests connect over real
TLS and encrypted UDP to the repository's controlled Mumble-compatible test server. They do not
certify behavior against every public server, phone manufacturer, or accessory.

## Tested configurations

| Configuration | Result |
| --- | --- |
| Android 10 / API 29, ARM64 | 18 device scenarios passed, plus denied-permission recovery |
| Android 11 / API 30, ARM64 | 18 device scenarios passed, plus denied-permission connection/chat |
| Android 16 / API 36, ARM64 | 18 device scenarios passed, plus denied-permission recovery |
| Android 16, 360×640 dp, 150% text | Server editor validation and recreation passed |
| Android 16, 640×360 dp, 150% text | Server editor validation and recreation passed |
| Android 10 and 16, live WebRTC video | Decoded desktop/browser video frames |

Results are from September 6, 2026. Runs exposed and fixed a saved-server duplication bug after
activity recreation, microphone permission recovery during calls, and cramped home actions at
large text sizes. Test selectors were also corrected to scroll lazy content into view before
interacting. Required scenarios passed across the original and targeted follow-up runs.

## Coverage

- 13 JVM tests: protobuf, bounded control framing, both voice formats, Mumble varints, upstream
  OCB2 vectors, replay/reordering, and fragmented screen-share signaling.
- 18 device tests: connection and certificate consent, legacy voice, encrypted UDP/TCP, live UDP
  failure and recovery, repeated dropped connections, mute/deafen preservation, chat, channel
  edits, notification controls, activity recreation, all 22 theme variants, encrypted storage,
  corruption rejection, PKCS#12 import, platform Opus, and microphone push-to-talk gating.
- A separate permission test starts with microphone/notification/Bluetooth access denied,
  checks chat, grants microphone access during the call, and verifies capture without reconnecting.
- A separate WebRTC interoperability test receives and decodes live 640×360 video from the shared
  browser/Electron client.

## Reproduce

Set `JAVA_HOME` to JDK 21 and `ANDROID_HOME` to the SDK. Start a fresh review emulator, then run
from the repository root:

```sh
node android/test-server.mjs
```

In another terminal:

```sh
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
ANDROID_SERIAL=emulator-5554 ./gradlew connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=com.alaarab.mutter.AppIntegrationTest,com.alaarab.mutter.RobustnessTest,com.alaarab.mutter.StorageTest,com.alaarab.mutter.EditorTest,com.alaarab.mutter.AudioCodecTest
```

Fault injection is global to the local test harness; run the full integration suite on one
emulator at a time. Gradle may uninstall test APKs after a run, so install both APKs before
running the permission scenario directly:

```sh
adb -s emulator-5554 install -r android/app/build/outputs/apk/debug/app-arm64-v8a-debug.apk
adb -s emulator-5554 install -r android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s emulator-5554 shell pm revoke com.alaarab.mutter android.permission.RECORD_AUDIO
adb -s emulator-5554 shell pm revoke com.alaarab.mutter android.permission.POST_NOTIFICATIONS
adb -s emulator-5554 shell pm revoke com.alaarab.mutter android.permission.BLUETOOTH_CONNECT
adb -s emulator-5554 shell am instrument -w -r \
  -e class com.alaarab.mutter.DeniedPermissionsTest -e mumbleDeniedPermissions true \
  com.alaarab.mutter.test/androidx.test.runner.AndroidJUnitRunner
```

Those commands run from the repository root on a disposable review emulator. Omit notification
permission on Android 12 or older and Bluetooth permission on Android 11 or older. The permission
test grants microphone access before it finishes.

For live video, stop other Gradle test runs first:

```sh
ANDROID_SERIAL=emulator-5554 CHROME=/path/to/chromium node android/test-share.mjs
```

Reports are under `android/app/build/reports/`. A successful instrumentation run must report its
expected test count and no failures; an ADB command exiting successfully is not sufficient.

## Physical devices

The offline `EditorTest`, `StorageTest`, and `AudioCodecTest` classes can run in
[Firebase Test Lab](https://firebase.google.com/docs/test-lab) without a public Mumble endpoint.
Uploading the app and instrumentation APKs requires a Firebase project. No cloud-device runs
have been performed for this checkout.

Hardware microphone quality, acoustic echo, Bluetooth accessories, route changes during phone
calls, cellular handover, long background sessions under OEM power management, and battery use
still require physical-device testing. Release signing and Play distribution are not configured.
