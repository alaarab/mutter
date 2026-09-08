# Security review

Reviewed September 8, 2026, across Mutter’s browser client, local bridge, Electron shell,
Swift packages, iOS app, Android app, dependency manifests, Git history, and GitHub workflows.
All confirmed security findings from this review have been addressed, including the Android
build dependencies, stored credentials, and remote-image privacy items left open in the first pass.
This combines automated scans, source review, malformed-input tests, and running-app checks.
It is a point-in-time review, not a guarantee that every vulnerability has been found.

## Fixed in this pass

| Area | Finding | Change |
| --- | --- | --- |
| Android dependencies | Bouncy Castle 1.81 / 1.81.1 matched two published advisories | Updated all three resolved Bouncy Castle artifacts to 1.85 and retained their bundled license notices. |
| Android build dependencies | 12 resolved artifacts matched 45 distinct advisories | Updated Kotlin to 2.4.20 and constrained the affected plugin dependencies to patched versions. The resolved runtime and build graphs now have zero OSV matches; CI repeats the scan. |
| Stored credentials | Browser/Electron passwords and iOS TURN credentials/access tokens used ordinary app storage | Browser secrets are session-only. Electron uses OS-backed encryption when available. iOS migrates TURN credentials and tokens to Keychain. Migration and storage-failure tests protect existing secrets from accidental overwrite. |
| Remote chat images | External images could expose a viewer’s address before consent | Parse markup in an inert template and show a load button. No external image request occurs until clicked; requests omit the referrer. |
| Android video | The app shipped an older M144 WebRTC binary | Updated to the distributor’s 150.7871.01 release and verified live video decoding. |
| Browser chat | An inherited object property could make malformed markup throw during rendering | Restricted the formatting allowlist to its own properties and added hostile-markup regression coverage. |
| iOS chat | Server HTML reached the attributed-string importer with insufficient filtering | Added a formatting/link allowlist; removed resource-bearing markup; bounded text, embedded-image decoding, and cache memory. |
| Electron | External URL handling accepted arbitrary schemes and app navigation used a string prefix | Restricted external links to HTTP, HTTPS, and mailto; checked exact app origin/path; limited device permissions and capture requests to the app’s main frame. |
| Browser bridge | Responses lacked a Content Security Policy | Added CSP and a no-referrer policy, including blocked frames, objects, and inline scripts. |
| Screen sharing | JavaScript/iOS reassembly and candidate queues lacked consistent resource limits | Added packet, pending-message, decompression, and candidate bounds; rejected inconsistent fragment headers and malformed streams. |
| Native share controls | iOS did not consistently authenticate the sender of stop/ICE messages; Android could throw on malformed candidate entries | Bound controls to the active sender/share, rejected unknown senders, capped announcements, and ignored malformed candidates. |
| Build workflows | Actions used mutable tags, checkouts retained credentials, and permissions/cache defaults were broader than needed | Pinned actions to commit hashes, disabled persisted checkout credentials, scoped permissions, disabled release package caching, and replaced the release action with the runner’s GitHub CLI. |
| Repository hygiene | RNNoise’s referenced license was missing and a reused source checkout could bypass its build pin | Restored the upstream license, included it in desktop distributions, and required a clean checkout of the pinned source commit. |
| Maintenance | Sensitive local file patterns and recurring security regressions lacked coverage | Expanded ignore rules, pinned the iOS Opus version, added security CI and weekly dependency updates, and removed two Swift concurrency warnings. |

The Bouncy Castle findings are [CVE-2026-5588](https://github.com/bcgit/bc-java/wiki/CVE%E2%80%902026%E2%80%905588)
and [CVE-2026-0636](https://github.com/bcgit/bc-java/wiki/CVE%E2%80%902026%E2%80%900636).
The affected composite-signature and LDAP APIs were not found in Mutter’s call paths;
the dependency advisories were confirmed, but an app-level exploit was not reproduced.

The Android video update follows the [distributor’s release](https://github.com/webrtc-sdk/android/releases/tag/v150.7871.01).
Chromium has published [WebRTC security fixes since M144](https://chromereleases.googleblog.com/2026/05/stable-channel-update-for-desktop_0841193308.html).
This motivates updating the embedded engine; it does not establish that every Chromium advisory
applies to this Android binary.

## Scan results

| Check | Result |
| --- | --- |
| npm audit, including development dependencies | No known vulnerabilities in the desktop lockfile. |
| pip-audit | No known vulnerabilities in the two pinned docs dependencies. |
| OSV, Android runtime | 64 resolved Maven artifacts; no advisory matches after the updates. |
| OSV, Android build toolchain | 143 resolved build artifacts; no advisory matches. [Resolved inventory](security/android-build-audit.json). |
| Semgrep security-audit rules | 248 files scanned; no scan errors. One generic Python HTTPS API warning was reviewed: the auditor uses a fixed HTTPS host and an explicit certificate-verifying TLS context. |
| Gitleaks, all Git refs | 68 commits scanned; no unsuppressed findings. One historical test-data false positive has an exact commit/path/rule/line exception. |
| Gitleaks, current source tree | No findings in tracked source and new source files. Generated Android build-cache bytes produced two unrelated matches when included in a broader directory scan. |
| Zizmor | No findings. |
| Android lint | Build passes with 21 warnings, including dependency/style suggestions and the custom certificate-verification warning discussed below. |
| Repository checks | No whitespace errors or first-party code comments; required language directives remain. Gradle’s wrapper JAR matches the publisher’s SHA-256. |

The historical secret-scanner exception is the public RFC 6455 sample handshake value in
`web/test/bridge.test.mjs`. The current test generates a fresh nonce. The exception applies only
to that historical match; it does not exclude the file or disable a detector. No history rewrite
or credential rotation is warranted for that test value.

The browser bridge binds to loopback and validates Host, Origin, a random bridge token,
WebSocket framing, and certificate approval before forwarding credentials. Android’s custom
trust manager collects the peer certificate; the connection then requires certificate trust
or a matching saved pin before authentication. Tests cover rejection and pin reuse. Its
`TrustAllX509TrustManager` lint warning was reviewed in that surrounding flow.

## Runtime verification

- Swift package: 55 tests passed, including the new HTML sanitizer cases.
- iOS simulator build: succeeded. The signed app migrated legacy TURN credentials and access
  tokens out of plaintext storage; both values reopened through the iOS Keychain API. An unsigned
  build refused Keychain access and retained the
  originals. Native probes also passed migration/failure, malformed signaling, audio playout,
  and reconnect scenarios.
- Android: 13 JVM tests passed; APK build and lint passed; nine emulator integration/storage
  tests passed; the updated WebRTC engine decoded real desktop video in a separate interop test.
  A certificate-prompt test initially raced the rendered dialog; it now waits for visibility,
  and the complete nine-test run passed after that correction.
- Electron: connected to a local fixture, sent chat, and acquired a microphone stream through
  the restricted permission handler. Navigation, persistence, vault-failure, and credential IPC
  isolation checks passed. The real OS-encryption round-trip test was skipped locally because
  this session’s OS store was unavailable; the test verified no plaintext fallback. The same
  test passed against the real OS store in macOS CI, including an encrypted save and reopen. The encryption adapter was exercised separately with authenticated-encryption
  fixtures, including tampered ciphertext and failed writes.
- Browser and desktop regression suite: 41 passed, zero failed, and the one OS-storage skip
  described above. Coverage includes certificate approval, credentials, remote-image consent,
  chat, voice, sharing, themes, persistence, and malformed input. The previous audit’s audio
  timing failure under heavy host load did not recur in this full run.

## Android build-tool remediation

The 45 advisory matches from the first pass belonged to the Gradle/plugin classpath, rather
than the APK’s runtime graph. The following versions resolved successfully in a clean build:

| Dependency | Previous | Current |
| --- | --- | --- |
| Kotlin Gradle plugin / Compose compiler | 2.2.20 | 2.4.20 |
| Bouncy Castle PKIX / provider | 1.79 | 1.85 |
| Commons Compress | 1.21 | 1.28.0 |
| jose4j | 0.9.5 | 0.9.6 |
| JDOM | 2.0.6 | 2.0.6.1 |
| Netty build dependencies | 4.1.110.Final | 4.1.137.Final |

Android Gradle Plugin remains at 8.13.2. Kotlin’s published
[compatibility range](https://kotlinlang.org/docs/gradle-configure-project.html) includes this
plugin and the pinned Gradle version. The explicit transitive constraints are validated by
unit tests, lint, APK assembly, and emulator integration tests. CI inventories the resolved
runtime and build classpaths and fails on any OSV match or an incomplete audit response.

## Credential storage and image privacy

- **Browser:** saved server details remain available, but server passwords and TURN secrets
  stay in memory for the current session. Previously stored plaintext values are removed
  from localStorage when the app loads. Reloading clears session-only passwords.
- **Electron:** a sandboxed preload exposes a narrow credential API to the main app frame.
  Credentials are encrypted with Electron’s OS-backed safeStorage and written atomically.
  Linux’s plaintext fallback is rejected. When the OS store is unavailable, passwords remain
  session-only; the UI labels explain which behavior is active. Decryption failures preserve
  the existing vault and block writes.
- **iOS:** server passwords, TURN credentials, and access tokens use device-bound Keychain
  entries. Legacy fields are removed only after secure writes succeed. Failed reads prevent
  editing unknown saved credentials; failed writes surface an error and preserve old values.
- **Android:** the existing device-bound Keystore encryption remains in place, with tamper
  detection and credential-storage tests rerun against the patched toolchain.
- **Images:** HTTP/HTTPS chat images show a load button identifying the host. A regression test
  counts network requests and verifies zero requests before consent, then one image request
  without a referrer after a click. Embedded attachments still display directly.

Removing a value from an app’s storage does not erase old backups or guarantee forensic
removal from disk. These changes stop ongoing plaintext persistence in the app.

## Coverage and separate maintenance

- **Native binaries:** iOS uses Opus wrapper 1.9.0 and WebRTC 152.0.0; Android uses WebRTC
  150.7871.01; RNNoise is pinned to source commit `1cbdbcf`. OSV commit queries for RNNoise,
  upstream Opus 1.5.2, and the iOS WebRTC source revision returned no matches. This is limited
  database coverage, not a verified SBOM or proof that distributed binaries reproduce that source.
- **Licensing:** the repository has no root license, while desktop metadata declares MIT.
  The owner needs to settle the project-wide license before broader redistribution.
- **Build hygiene:** older platform APIs and third-party Opus header warnings remain. Android
  has nonfatal lint warnings. A Swift 6 migration and a full dependency modernization are separate work.
- **Coverage:** no production server, physical Android hardware, Windows/Linux packaged app,
  signing account, or machine-wide security assessment was included. Continuous fuzzing and
  a specialist penetration test would provide additional coverage.

## Repeat the checks

From the repository root, with the platform prerequisites installed:

```sh
npm --prefix desktop audit
uv run --with pip-audit pip-audit -r docs/site/requirements.txt --no-deps --disable-pip
uv run --with semgrep semgrep scan --config p/security-audit --metrics=off
uv run --with zizmor zizmor .github
gitleaks git . --redact --log-opts=--all
swift test --package-path Packages/MumbleCore
node --test --test-concurrency=1 web/test/*.test.mjs desktop/test/*.test.mjs
android/gradlew -p android securityInventory testDebugUnitTest lintDebug assembleDebug
python3 scripts/audit-android-dependencies.py
node scripts/generate-themes.mjs --check
git diff --check
```

Set `CHROME` to a Chromium-compatible browser executable for browser tests. Electron tests
need `npm ci` in `desktop/`. Android needs JDK 21 and the SDK; emulator test setup is in the
[Android guide](../android/README.md). The historical Gitleaks exception is recorded in
`.gitleaksignore`. Weekly dependency PRs use a seven-day cooldown for ordinary version updates;
[security updates are exempt](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown).
