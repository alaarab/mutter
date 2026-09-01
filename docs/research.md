# Research log (2026-09-01)

## The existing iOS app

- App Store: "Mumble" by Mumble (id443472808). Description: free group voice chat, low latency
  over Wi‑Fi/3G, thousands of public servers, PTT and voice-activated modes, TLS + OCB2-AES128,
  text messaging with links/images, Bluetooth headset and echo cancellation.
- Source: `mumble-voip/mumble-iphoneos` (Objective-C, MumbleKit submodule). README says
  unmaintained, seeking a maintainer (issue #129). Builds with Xcode 16 only via patches.
- Screens (from `Source/Classes`): favourite server list, public server list by country, LAN
  list, server root (channel/user tree), messages, preferences (audio quality/transmission/
  sidetone/advanced), certificate create/import/trust, access tokens, legal.
- User complaints found: no update in years, UI "outdated and a bit hard to use", poor iPad
  split-screen, doesn't use screen space, can't collapse channel groups on big servers, PTT and
  whisper/shout hard to find or missing.
- Alternative: Mumblefy (also stale).

## Protocol sources used

- `Mumble.proto` (27 messages) and `MumbleUDP.proto` (Audio, Ping) from mumble master.
- `MumbleProtocol.h`: `PROTOBUF_INTRODUCTION_VERSION = 1.5.0`; `UDPMessageType {Audio=0, Ping=1}`;
  legacy types `{CELTAlpha, Ping, Speex, CELTBeta, Opus}`; `MAX_UDP_PACKET_SIZE = 1024`.
- `MumbleProtocol.cpp`: protobuf packets start with the type byte then the message at offset 1;
  decoder branches on `getProtocolVersion() < PROTOBUF_INTRODUCTION_VERSION`.
- `Server.cpp`: server sets the decoder's protocol version from the *user's* version.
- `CryptStateOCB2.cpp` verbatim, and `TestCrypt.cpp` for vectors.
- `docs/dev/network-protocol/{protocol_stack_tcp,establishing_connection,voice_data}.md`.

## Design references

- Discord's "Improving our mobile experience" / "Refining Discord's mobile experience" posts:
  separate servers/messages tabs, faster open, swipe to reply, Midnight theme.
- Claude design tokens (community DESIGN.md): cream canvas `#faf9f5`, coral `#cc785c`, ink
  `#141413`, dark surfaces `#181715`/`#252320`, serif display + humanist sans, 8/12/16 radii.

## Dependencies chosen

- libopus: `OnBeep/Opus-iOS` (SPM binary xcframework, iOS 16+, `import Opus`; no ogg dependency).
  Alternative: `sbooth/opus-binary-xcframework` (needs the ogg package).
- Project generation: XcodeGen (`project.yml`), so no hand-written pbxproj.
- No SwiftProtobuf: a 150-line wire codec covers everything Mumble uses and avoids protoc.
