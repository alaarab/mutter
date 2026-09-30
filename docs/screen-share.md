# Screen share

Mutter's screen share is an extension stock Mumble clients don't have. The Mumble server is
not modified and needs no plugin: video travels **peer to peer over WebRTC**, and the only
thing that crosses the Mumble server is the signaling, carried in `PluginDataTransmission`
(control message type 26).

Implemented in `web/app/share.js` + `web/src/rtcsignal.js`. iOS and Android mirror the wire format
and can both share and view.

## What the server gives us

Verified against murmur's source (`Server::msgPluginDataTransmission`):

- `data` is capped at **1000 bytes**; `dataID` at 100 characters.
- A leaky bucket per client: burst of 15 messages, then 4 messages per second sustained.
  Overflow is dropped silently.
- `receiverSessions` **must** be listed; an empty list delivers to nobody. One message can
  name many receivers. There is no version filtering; the server forwards to anyone listed.

So the channel is fine for a few kilobytes of signaling and useless for video. We stay under
the limits with a client-side token bucket (burst 12, 3/s) so nothing is ever dropped — and,
as etiquette on a server we don't run, nothing recurring is ever sent: every message is tied to
a user action (start, watch, join, stop), never a heartbeat.

## Framing

`dataID = "mutter/rtc"`. `data` is a 5-byte header followed by a fragment:

| Offset | Size | Field | Meaning |
|---:|---:|---|---|
| 0 | 1 | `version` | `1` |
| 1 | 1 | `msgId` | Identifies one logical message from this sender. Increments per message, wraps at 256. |
| 2 | 1 | `index` | Fragment number, from 0 |
| 3 | 1 | `count` | Number of fragments in the message, ≥ 1 |
| 4 | 1 | `flags` | bit 0: payload is **deflate-raw** (RFC 1951, no zlib/gzip header). Other bits reserved, must be 0. |
| 5 | ≤ 990 | fragment | Bytes `index·990 … ` of the payload |

The payload is the UTF-8 JSON of one message. It is compressed when it's 160 bytes or more
and compression actually shrinks it (SDPs shrink to roughly a third). Reassembly is keyed by
`(senderSession, msgId)`; fragments may arrive out of order; an incomplete message older than
10 s is discarded. Unknown `version` → ignore the fragment.

## Messages

All messages are JSON objects with a string `t`. `id` is the share id: 8 characters chosen by
the sharer when it starts, so late or stale signals for an earlier share can be ignored.

| `t` | Direction | Fields | When |
|---|---|---|---|
| `announce` | sharer → channel members | `id`, `title`, `w`, `h`, `audio` | Once on start to everyone in the channel, and once to each person who joins the channel afterwards. Never repeated: the control channel is reliable, and the plugin channel is someone else's server — nothing recurring rides on it. Viewers keep the offer until `stop`, or until either of them leaves the channel. |
| `stop` | sharer → everyone announced to | `id` | Sharing ended, or that person left the sharer's channel. |
| `watch` | viewer → sharer | `id` | Please send me an offer. |
| `offer` | sharer → viewer | `id`, `sdp` | Complete SDP offer, candidates included (vanilla ICE: gather until complete or 1.5 s). |
| `answer` | viewer → sharer | `id`, `sdp` | Complete SDP answer, same rule. |
| `leave` | viewer → sharer | `id` | Stopped watching; sharer closes that connection. |
| `ice` | either | `id`, `c: [RTCIceCandidateInit…]` | Reserved for trickle ICE; not sent today, accepted if received. |

Flow for one viewer:

```
sharer                                 viewer
  │ announce ────────────────────────▶ │  shows "Alice is sharing · Watch"
  │ ◀──────────────────────── watch    │
  │ (RTCPeerConnection, sendonly video[, audio])
  │ offer (SDP w/ candidates) ───────▶ │  setRemote, createAnswer, gather
  │ ◀─────────── answer (SDP w/ cand.) │
  │ ═══════════ WebRTC media ════════▶ │
  │ ◀──────────────────────── leave    │  (or sharer sends stop)
```

The sharer keeps one `RTCPeerConnection` per viewer (a small mesh; the typical channel has a
handful of people). A viewer watches one share at a time.

Rules both sides follow:

- The sharer answers a `watch` that carries its current `id` only from someone who is **in its
  channel right now**. When a viewer leaves the channel, the sharer closes that viewer's
  connection and sends it `stop`; coming back brings a fresh `announce`. The id is never
  rotated, so this channel check is what keeps former members out.
- The sharer accepts a short burst of `watch` requests from one viewer (4, then one every 2 s)
  and ignores the rest. A newer `offer` or `answer` for the same viewer and share replaces one
  still waiting in the send queue, and the queue is capped, so a flood cannot delay everyone
  else's signaling.
- A viewer may **decline the audio m-line** in its answer (port 0). iOS always does — WebRTC's
  audio unit would fight Mutter's own audio engine — and the web does when "Play the sharer's
  audio" is off. The sharer must keep the video going regardless; `web/test/share.test.mjs`
  checks this.
- A viewer sends `watch` only after it has an `announce` for that `id`; an `offer` for an
  unknown `id` is ignored. A viewer drops offers from anyone who is not in its channel.

## Media

- Capture: `getDisplayMedia` with video up to 1920×1080 @ 30 (60 max) and system/tab audio when
  the browser offers it. `MediaStreamTrack.contentHint` is `detail` (text, code — keep
  resolution) or `motion` (video, games — keep frame rate), switchable while sharing.
- Codec preference on the sender: AV1 › VP9 › H.264 › VP8, whatever the browser has.
- Sender parameters: `maxBitrate` 6 Mbit/s, `maxFramerate` 30/60 by hint,
  `degradationPreference` `maintain-resolution` / `maintain-framerate` by hint.
- ICE servers: `stun:stun.l.google.com:19302`, plus an optional TURN server from settings for
  networks that block direct connections (corporate NAT). `bundlePolicy: max-bundle`,
  `rtcpMuxPolicy: require` — keeps the SDP small.
- Local addresses: browsers replace host candidates with random `.local` mDNS names unless the
  page holds microphone or camera permission. Two computers that both do this cannot reach each
  other on a LAN where multicast DNS is blocked, while native viewers (iOS, Android) always offer
  real addresses. The desktop app starts Chromium with `WebRtcHideLocalIpsWithMdns` disabled so
  it always offers real local addresses to the peers it connects to.

## Phones as sharers

Phones share the whole screen, video only (`audio: false`), and announce `kind: "screen"`.

- **Android** (`sharing/ScreenSharer.kt`): Share screen in the call options asks for
  MediaProjection consent. The voice service then adds the `mediaProjection` foreground type,
  and webrtc-sdk's `ScreenCapturerAndroid` captures at up to 1280 pixels on the longest side,
  30 fps, 2.5 Mbit/s. Stopping from the banner, the notification's Stop sharing, the system's
  cast indicator, or a disconnect sends `stop` to everyone announced to.
- **iOS** (`ScreenShare/ScreenSharer.swift`, `MutterBroadcast/`): ReplayKit hands screen frames
  to a Broadcast Upload Extension, a separate process capped at about 50 MB. WebRTC runs in the
  app, not in the extension: the extension scales each frame to at most 1280 pixels on the
  longest side, encodes a JPEG at 15 fps, and writes it to a Unix socket in the App Group
  container (`share.sock`; frames are `MTRF`, a 4-byte big-endian length, the ReplayKit
  orientation byte, then the JPEG). The app decodes on the CPU, feeds a screencast
  `RTCVideoSource`, and signals exactly like the web sharer. The encoder is VP8 in software,
  because the app keeps encoding while it's in the background and the GPU isn't available to it
  there. Stop sharing in the app closes the socket, and the extension then ends the broadcast.
  The app stays running because it's in a voice call; leaving the server stops the share.

Both use the same ICE servers as their viewers (the STUN server and optional TURN server from
settings), answer `watch` only from people in their channel with the same rate limit as the web,
and replace a queued `offer` for the same viewer instead of sending two.

## Viewer

The stage (third column) shows the video, `width×height · fps · bitrate · codec` from
`getStats()` once a second, full-screen and picture-in-picture buttons, and Stop watching.
A sharing user gets a green screen badge in the channel tree; clicking it watches.
A viewer that isn't connected 25 seconds after `watch` gives up and says why, naming hidden
(mDNS-only) local addresses on both ends when that is the cause. A `disconnected` connection
shows as reconnecting with a Retry button; only `failed` shows as couldn't connect.

## Notes for the iOS port

- Reassembly and fragmentation are the whole "protocol"; everything else is standard WebRTC.
  Use `NSData` + `Compression` (`COMPRESSION_ZLIB` is raw deflate on Apple platforms — matches
  `deflate-raw`).
- Receiving only (a viewer) needs `RTCPeerConnection` recvonly and the same vanilla-ICE
  rule: send the SDP after `iceGatheringState == complete` or 1.5 s, whichever is first.
- Send `watch` only after receiving `announce` for that `id`; ignore `offer` for another id.
- Keep receivers explicit and respect the rate limit — the server drops, it does not tell you.
