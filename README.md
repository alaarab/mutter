# Mutter — a modern Mumble client for iPhone

Mutter speaks the standard Mumble protocol (TLS control channel, OCB2-AES128 encrypted UDP voice,
Opus) and wraps it in an interface that borrows Discord's structure (servers → channels → a
persistent voice bar) and a warm, editorial look. It is a from-scratch Swift codebase with no
MumbleKit and no third-party dependency other than libopus.

## Status

The code in this directory was written without access to Xcode or an iOS device, so it has not
been compiled or run yet. The protocol layer ships with unit tests, and the OCB2 cipher was
validated in Python against Mumble's official test vectors before being ported to Swift, but
expect a round of compiler fixes on first build. See "First build" below.

## Layout

```
app/
├── project.yml                     XcodeGen manifest → Mutter.xcodeproj
├── Packages/MumbleCore/            Local Swift package
│   ├── Sources/MumbleProtocol/     Pure Swift, portable, unit tested
│   │   ├── ProtobufWire.swift      Minimal protobuf encoder/decoder (no codegen)
│   │   ├── Messages.swift          All 27 control messages that matter, typed
│   │   ├── ControlFraming.swift    6-byte TCP frame header + reassembly
│   │   ├── Varint.swift            Mumble's own varint (legacy voice packets)
│   │   ├── VoicePacket.swift       Legacy + protobuf (1.5) UDP audio/ping codecs, server probe
│   │   ├── OCB2.swift              CryptState port (nonce recovery, replay history, XEX* guard)
│   │   ├── AES128.swift            CommonCrypto on Apple, pure-Swift AES for Linux tests
│   │   └── Version.swift           v1/v2 version encodings, protobuf-UDP threshold
│   ├── Sources/MumbleClient/       Apple only
│   │   ├── MumbleClient.swift      Handshake, state machine, ping/UDP failover, user actions
│   │   ├── ServerSession.swift     @Observable snapshot for SwiftUI
│   │   ├── Transport/              Network.framework TLS + UDP connections
│   │   ├── Identity/               Self-signed certificate generation (DER by hand), keychain store, .p12 import
│   │   └── Discovery/              Public server list, Bonjour LAN browser, UDP server pinger
│   └── Tests/MumbleProtocolTests/  Varint, protobuf, messages, framing, voice packets, AES, OCB2
└── Mutter/                         The app
    ├── App/                        AppModel (composition root), settings, server store
    ├── Audio/                      AVAudioEngine capture/playback, Opus, jitter buffer, VAD, PTT
    ├── Design/                     Theme tokens, components, HTML message rendering
    ├── Features/                   Servers, Session (tabs + voice bar), Channels, Chat, Settings, Identity
    ├── LiveActivity/, Intents/     Lock screen presence, App Intents (Siri / Shortcuts / Action button)
    └── Shared/                     Types compiled into both the app and the widget extension
MutterWidgets/                      Widget extension: Live Activity + Dynamic Island
```

## First build

Requirements: Xcode 16, iOS 17 device or simulator, [XcodeGen](https://github.com/yonaskolb/XcodeGen).

```bash
brew install xcodegen
cd mumble-ios/app
xcodegen generate
open Mutter.xcodeproj
```

Set your team under Signing & Capabilities, then build the `Mutter` scheme. Run the package tests
with `swift test` from `Packages/MumbleCore` (macOS) or via the scheme's Test action.

Things most likely to need a touch on first build:

1. **Opus headers.** `Mutter/Audio/OpusShim/opus_shim.h` includes `<opus/opus.h>` with fallbacks.
   If the OnBeep `Opus` xcframework lays out headers differently, adjust the include or swap the
   package in `project.yml` (sbooth/opus-binary-xcframework also works; it needs the ogg package).
   The shim exists because `opus_encoder_ctl` is variadic and Swift cannot call it.
2. **Swift concurrency warnings.** The project uses Swift 5 language mode with minimal checking on
   purpose; don't switch to Swift 6 mode until it compiles.
3. **Keychain entitlement.** Certificates live in the keychain; the entitlements file is generated
   by XcodeGen from `project.yml`.

## What it does

- Connects to any Mumble server 1.2 through 1.5+. Announces itself as 1.5 and picks the UDP wire
  format from the server's version (protobuf for 1.5+, legacy header-byte for older).
- Voice over encrypted UDP with automatic fallback to the TCP tunnel when UDP is blocked, and
  automatic return when it comes back. Crypt resync on decode stalls.
- Push-to-talk (hold or toggle), voice activity with a live meter and adjustable threshold, or always on.
- Opus 16–96 kbit/s, 10–60 ms packets, in-band FEC, per-user jitter buffer with packet-loss concealment.
- Bluetooth/AirPods routing, speakerphone toggle, echo cancellation via the voice-chat audio mode,
  background audio so calls keep running with the screen off.
- Channel tree that collapses, remembers what you collapsed, shows live speaking rings and user
  counts, and has instant search across channels and people (the main complaint about the old app).
- Chat with HTML rendering, inline images, links, direct messages, channel and tree targets,
  unread badge, and local notifications when backgrounded.
- User sheet: local mute and volume, stats (ping, client version, address), moderation actions
  gated on your actual permissions (move, mute, deafen, priority speaker, kick, ban).
- Channel sheet: join, listen without joining, message, create/rename/delete when permitted.
- Server list with live user counts and latency (UDP probe), favourites, recents, the public
  directory, and Bonjour discovery on the local network.
- Certificates: create a self-signed identity on device (RSA-2048, 20 years), import a .p12,
  choose per server. Server certificates are pinned by SHA-256 with a first-contact/changed prompt.
- Auto-reconnect with backoff after a drop.

- Whisper to people or shout to a channel: pick targets, hold the whisper button or flip the mic
  into whisper mode.
- Send photos in chat; they're shrunk to fit the server's image limit.
- Lock screen and Dynamic Island Live Activity showing the channel and who's speaking, with mute
  and talk buttons that work without unlocking. Now Playing shows the session too, and the
  play/pause button on AirPods or a headset toggles mute or talk.
- App Intents for Siri, Shortcuts and the Action button: connect to a server, toggle mute, push
  to talk, deafen, disconnect.
- Registered users list with rename and remove, hide-empty-channels filter.

Full coverage table: `docs/features.md`.

## Not done yet

- Positional audio, recording, ACL and ban list editors, context actions.
- Exporting a certificate as .p12 (iOS has no API to build PKCS#12 without OpenSSL).
- iPad split-view layout; the phone layout works on iPad but isn't tailored.
- App icon artwork (the catalog has an empty slot).
