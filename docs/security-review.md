# Security review

Reviewed September 8, 2026, across Mutter’s browser client, local bridge, Electron shell,
Swift packages, iOS app, Android app, dependency manifests, Git history, and GitHub workflows.
This combines automated scans, source review, malformed-input tests, and running-app checks.
It is a point-in-time review, not a guarantee that every vulnerability has been found.

## Fixed in this pass

| Area | Finding | Change |
| --- | --- | --- |
| Android dependencies | Bouncy Castle 1.81 / 1.81.1 matched two published advisories | Updated all three resolved Bouncy Castle artifacts to 1.85 and retained their bundled license notices. |
| Android video | The app shipped an older M144 WebRTC binary | Updated to the distributor’s 150.7871.01 release and verified live video decoding. |
| Browser chat | An inherited object property could make malformed markup throw during rendering | Restricted the formatting allowlist to its own properties and added hostile-markup regression coverage. |
| iOS chat | Server HTML reached the attributed-string importer with insufficient filtering | Added a formatting/link allowlist; removed resource-bearing markup; bounded text, embedded-image decoding, and cache memory. |
| Electron | External URL handling accepted arbitrary schemes and app navigation used a string prefix | Restricted external links to HTTP, HTTPS, and mailto; checked exact app origin/path; limited device permissions and capture requests to the app’s main frame. |
| Browser bridge | Responses lacked a Content Security Policy | Added CSP and a no-referrer policy, including blocked frames, objects, and inline scripts. |
| Screen sharing | JavaScript/iOS reassembly and candidate queues lacked consistent resource limits | Added packet, pending-message, decompression, and candidate bounds; rejected inconsistent fragment headers and malformed streams. |
| Native share controls | iOS did not consistently authenticate the sender of stop/ICE messages; Android could throw on malformed candidate entries | Bound controls to the active sender/share, rejected unknown senders, capped announcements, and ignored malformed candidates. |
| Build workflows | Actions used mutable tags, checkouts retained credentials, and permissions/cache defaults were broader than needed | Pinned actions to commit hashes, disabled persisted checkout credentials, scoped permissions, and disabled release package caching. |
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
| OSV, Android build toolchain | 144 resolved build artifacts; 12 artifacts match 45 distinct advisories. These remain open and are detailed below. |
| Semgrep security-audit rules | 241 files scanned; no findings or scan errors. Manual review found issues outside those rules’ coverage. |
| Gitleaks, all Git refs | 67 commits scanned; one reviewed false positive, no confirmed committed credential. |
| Gitleaks, current source tree | Same false positive in a WebSocket test; no confirmed credential. |
| Zizmor | Security findings addressed. One informational suggestion remains to replace the pinned release action with the runner’s `gh` CLI. |
| Android lint | Build passes with 21 warnings, including dependency/style suggestions and the custom certificate-verification warning discussed below. |
| Repository checks | No whitespace errors or first-party code comments; required language directives remain. Gradle’s wrapper JAR matches the publisher’s SHA-256. |

The secret scanner’s only match is the public RFC 6455 sample WebSocket handshake value in
`web/test/bridge.test.mjs`. It is test data, not a service credential. No history rewrite or
credential rotation is warranted for that match.

The browser bridge binds to loopback and validates Host, Origin, a random bridge token,
WebSocket framing, and certificate approval before forwarding credentials. Android’s custom
trust manager collects the peer certificate; the connection then requires certificate trust
or a matching saved pin before authentication. Tests cover rejection and pin reuse. Its
`TrustAllX509TrustManager` lint warning was reviewed in that surrounding flow.

## Runtime verification

- Swift package: 55 tests passed, including the new HTML sanitizer cases.
- iOS simulator build: succeeded. Native probes also passed malformed signaling, audio
  playout, and reconnect scenarios.
- Android: 13 JVM tests passed; APK build and lint passed; nine emulator integration/storage
  tests passed; the updated WebRTC engine decoded real desktop video in a separate interop test.
- Electron: connected to a local fixture, sent chat, and acquired a microphone stream through
  the restricted permission handler. Navigation policy and persistence tests passed.
- Browser: certificate approval, chat, voice, sharing, themes, persistence, and malformed-input
  tests ran. The full run had one audio-buffer timing failure while native builds and the
  emulator were running. It passed on an isolated rerun, with 42.7 dB signal-to-noise ratio,
  no clicks/dropouts/underruns, and no buffer growth across short talk spurts. The first
  failure remains evidence of timing sensitivity under load.

## Open Android build-tool findings

These libraries belong to the Gradle/plugin classpath, not the APK’s runtime dependency graph.
Version matches establish exposure in the build environment; they do not prove each affected
API is reachable during this project’s build. The complete matching IDs are in the
[build dependency findings](security/android-build-audit.json).

| Build dependency | Resolved version | Advisory matches |
| --- | --- | --- |
| Kotlin Gradle plugin | 2.2.20 | 1 |
| Bouncy Castle PKIX / provider | 1.79 | 3 across two artifacts |
| Commons Compress | 1.21 | 2 |
| jose4j | 0.9.5 | 1 |
| JDOM | 2.0.6 | 1 |
| Netty HTTP/2, HTTP, proxy, handler, codec, common | 4.1.110.Final | 38 matches across six artifacts, including a shared advisory |

The Kotlin finding concerns KAPT incremental-cache deserialization. Mutter does not apply
KAPT; the [upstream fix](https://github.com/JetBrains/kotlin/commit/bf51df665b458fda7c3eaf436c4d88dc119d7ec6)
is in that subsystem. CI now disables Gradle cache restoration to reduce exposure to poisoned
build caches. This is a mitigation, not removal of the vulnerable dependencies.

The next remediation is an Android Gradle Plugin/Kotlin toolchain upgrade, followed by another
resolved-classpath scan and clean build, signing, lint, and emulator checks. Forcing unrelated
transitive versions into the existing plugin would need its own compatibility validation.

## Remaining work and limits

- **Credential storage:** browser/Electron remembered server passwords and TURN credentials
  use localStorage. iOS server passwords use Keychain, but TURN credentials use UserDefaults
  and access tokens remain in the saved-server file. Those values rely on the OS/app profile’s
  protection. Moving them into platform credential storage needs a tested migration.
- **Remote images:** browser chat can still load HTTP/HTTPS images automatically. Image hosts
  can observe the viewer’s network address. A click-to-load setting remains a privacy improvement.
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
android/gradlew -p android testDebugUnitTest lintDebug assembleDebug
node scripts/generate-themes.mjs --check
git diff --check
```

Set `CHROME` to a Chromium-compatible browser executable for browser tests. Electron tests
need `npm ci` in `desktop/`. Android needs JDK 21 and the SDK; emulator test setup is in the
[Android guide](../android/README.md). Gitleaks intentionally still reports the reviewed test
constant. Weekly dependency PRs use a seven-day cooldown for ordinary version updates;
[security updates are exempt](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown).
