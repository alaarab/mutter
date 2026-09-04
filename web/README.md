# Mutter Web

A browser client for Mumble that speaks the protocol itself, so a machine where you can't
install anything can still be a first-class participant — including our screen-sharing
extension, which stock Mumble clients don't implement.

## Why a bridge

Browsers can't open raw TCP sockets, and Mumble's control channel is TLS over TCP. So a small
local process relays the browser's WebSocket to the real server:

```
Browser (Windows, no install, no admin)
   │  WebSocket → localhost
   ▼
Bridge (Node, in WSL)
   │  TLS/TCP :64738
   ▼
Mumble server — unchanged, no plugins, nothing to install
```

WSL2 forwards listening ports to Windows' localhost, so the browser reaches a bridge running
in WSL at the same address. The server operator does nothing; the bridge is a byte pipe.

## Running it

Node 18+ is the only requirement. There are **no dependencies** — the WebSocket server is
hand-rolled precisely so a locked-down machine needs no `npm install`.

```sh
node web/bridge/server.mjs      # then open http://localhost:8788 in Chrome or Edge
```

Set `PORT` to use a different port. Open it as `localhost`, not a LAN address: the microphone
and the Opus codec are only available to secure origins, and `localhost` counts as one.

Voice needs Chrome or Edge (WebCodecs + AudioWorklet). Other browsers get chat only.

## What works

- Connect, saved servers, reconnect with backoff after a drop (fresh roster, no ghost "old me").
- Channel tree with people nested under their channel, collapse (remembered per server),
  subtree counts, join arrow, speaking rings, mute / deafen / priority badges.
- Voice both ways over the TCP tunnel: 20 ms Opus at 16–96 kbit/s, browser echo cancellation
  and noise suppression, per-user jitter buffer. Voice activity with auto sensitivity, push to
  talk (hold **Space** or the Talk button), always on. Mute, deafen, local per-user mute and
  volume.
- Chat to the channel, a channel and its subtree, or one person. Inbound HTML goes through a
  whitelist. Images: paste, drop or pick; they're shrunk to the server's limit.
- Five palettes from the iOS app, the same typefaces, settings and diagnostics log in the sheet.

Next: screen share over `PluginDataTransmission` + WebRTC (see `docs/screen-share.md` once it
lands).

## Layout

| Path | What it is |
|---|---|
| `src/protobuf.js` | Minimal protobuf reader/writer, the same subset the iOS app hand-rolls |
| `src/mumble.js` | Framing, message types, encode/decode. Shared by browser, bridge and tests |
| `src/voice.js` | Voice packet codec, both UDP wire formats (chosen by the server's version) |
| `bridge/server.mjs` | Static file server + WebSocket↔TLS relay |
| `app/client.js` | The session: handshake, roster, chat, reconnect, talking detection |
| `app/audio.js`, `app/worklets.js` | Capture → Opus → tunnel; tunnel → Opus → mixer |
| `app/app.js`, `chat.js`, `store.js`, `themes.js`, `icons.js` | The UI |
| `probe.mjs` | CLI handshake test — connects and dumps the roster, no browser involved |
| `test/` | Fake Mumble server, headless-Chromium driver, end-to-end and codec tests |

Field numbers mirror `Packages/MumbleCore/Sources/MumbleProtocol` so both clients stay in step.

## Testing

Nothing here talks to a real server. `test/fake-server.mjs` is a small Mumble server (TLS,
handshake, roster, text, voice relay, plugin data with murmur's limits) and `test/browser.mjs`
drives headless Chromium over the DevTools protocol — both with Node's built-ins only.

```sh
node web/test/webcodecs.test.mjs                    # does this Chromium do Opus the way we assume?
node web/test/e2e.test.mjs                          # two tabs, voice both ways, chat, images, reconnect
FAKE_VERSION=1.4.287 node web/test/e2e.test.mjs     # same, legacy voice format
node web/test/fake-server.mjs                       # keep one running to click around against
node web/probe.mjs <host> [port] [username]         # handshake against any server, read-only
```

`SHOTS=dir` saves screenshots from the end-to-end run; `VERBOSE=1` shows page console output.
