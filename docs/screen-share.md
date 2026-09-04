# Screen share

Mutter's screen share is an extension stock Mumble clients don't have. The Mumble server is
not modified and needs no plugin: video travels **peer to peer over WebRTC**, and the only
thing that crosses the Mumble server is the signaling, carried in `PluginDataTransmission`
(control message type 26).

Implemented in `web/app/share.js` + `web/src/rtcsignal.js`. iOS mirrors the wire format.

## What the server gives us

Verified against murmur's source (`Server::msgPluginDataTransmission`):

- `data` is capped at **1000 bytes**; `dataID` at 100 characters.
- A leaky bucket per client: burst of 15 messages, then 4 messages per second sustained.
  Overflow is dropped silently.
- `receiverSessions` **must** be listed; an empty list delivers to nobody. One message can
  name many receivers. There is no version filtering; the server forwards to anyone listed.

So the channel is fine for a few kilobytes of signaling and useless for video. We stay under
the limits with a client-side token bucket (burst 12, 3/s) so nothing is ever dropped.

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
| `announce` | sharer → channel members | `id`, `title`, `w`, `h`, `audio` | On start, to anyone who joins the channel, and every 10 s to everyone (late arrivals, lost messages). Viewers forget a share not re-announced within 25 s. |
| `stop` | sharer → everyone announced to | `id` | Sharing ended. |
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

- The sharer answers **any** `watch` that carries its current `id`, whether or not it has seen
  an announce reach that viewer (a late joiner may have learned the id another way). It then
  treats that viewer as announced, so it also receives `stop`.
- A viewer may **decline the audio m-line** in its answer (port 0). iOS always does — WebRTC's
  audio unit would fight Mutter's own audio engine — and the web does when "Play the sharer's
  audio" is off. The sharer must keep the video going regardless; `web/test/share.test.mjs`
  checks this.
- A viewer sends `watch` only after it has an `announce` for that `id`; an `offer` for an
  unknown `id` is ignored.

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

## Viewer

The stage (third column) shows the video, `width×height · fps · bitrate · codec` from
`getStats()` once a second, full-screen and picture-in-picture buttons, and Stop watching.
A sharing user gets a green screen badge in the channel tree; clicking it watches.

## Notes for the iOS port

- Reassembly and fragmentation are the whole "protocol"; everything else is standard WebRTC.
  Use `NSData` + `Compression` (`COMPRESSION_ZLIB` is raw deflate on Apple platforms — matches
  `deflate-raw`).
- Receiving only (a viewer) needs `RTCPeerConnection` recvonly and the same vanilla-ICE
  rule: send the SDP after `iceGatheringState == complete` or 1.5 s, whichever is first.
- Send `watch` only after receiving `announce` for that `id`; ignore `offer` for another id.
- Keep receivers explicit and respect the rate limit — the server drops, it does not tell you.

See also docs/extensions.md for the typing indicator.
