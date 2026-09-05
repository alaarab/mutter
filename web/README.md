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
in WSL at the same address. The server operator does nothing.

**Voice goes over UDP, like a native client.** The browser tunnels voice frames to the bridge
over the WebSocket (localhost never drops a packet); the bridge takes the server's `CryptSetup`
key, encrypts each frame with Mumble's OCB2-AES128 and sends it as a UDP datagram, decrypts the
server's datagrams back into tunnel frames, keeps the UDP pings going, asks for a nonce resync
when decrypts stall, and falls back to the TCP tunnel by itself if UDP is blocked (`--tcp` forces
that). This matters on Wi-Fi: voice over TCP freezes for a second or two on every lost packet
while TCP retransmits, then dumps the backlog; over UDP a lost packet is just a lost 20 ms.
The Server tab says which lane is in use and counts delivery stalls, playback underruns and
capture stalls, so a choppy call can be diagnosed from the log.

## Running it

**As a desktop app** — download a build from the releases page and run it; no install, no
admin, no browser. It is the same client and bridge wrapped in Electron, which matters on a
managed laptop: the browser's enterprise policy can block WebRTC, and the app's own Chromium
doesn't read it. See [`desktop/`](../desktop/README.md).

**From source in a browser** — Node 18+ is the only requirement. There are **no dependencies**
here in `web/`: the WebSocket server is hand-rolled precisely so a locked-down machine needs no
`npm install`.

```sh
node web/bridge/server.mjs
```

That starts the bridge **and opens Mutter as its own window** — Chrome/Edge app mode: no tabs,
no address bar, its own taskbar entry, remembers its size. From WSL it launches the Windows
browser (Edge by default; `BROWSER=chrome` to pick). `--no-open` just serves. You can also
install it from Chrome's address bar ("Install Mutter") for a permanent icon.

Set `PORT` to use a different port. Open it as `localhost`, not a LAN address: the microphone
and the Opus codec are only available to secure origins, and `localhost` counts as one.

### Make it feel installed — without installing anything

On a managed laptop that runs Node in WSL but treats new Windows executables with suspicion, this
gets you a Start-menu app that just works, using only the browser IT already approved:

1. **Install it as an app.** With the bridge running, open `http://localhost:8788` in Edge or
   Chrome and use *Install Mutter* in the address bar (Edge: … → Apps → Install). It gets its own
   window, taskbar icon and Start-menu entry, stored in your browser profile — nothing new is
   written outside your user folder.
2. **Start the bridge with Windows.** Press `Win+R`, run `shell:startup`, and create a shortcut
   there whose target is

   ```
   wsl.exe -d Ubuntu -- bash -lc "cd ~/mutter && exec node web/bridge/server.mjs --no-open"
   ```

   (your distro name in place of `Ubuntu`, your clone's path in place of `~/mutter`). Set the
   shortcut to run minimised. From then on the bridge is up by the time you sit down, and the app
   icon opens straight into Mutter. No admin, no installer, no new binary — the only executables
   involved are `wsl.exe` and the browser.

The one thing this cannot fix is a browser policy that blocks WebRTC; see
*Settings → Screen share → Test my connection*. Everything else — voice, chat, images — is
unaffected.

Voice needs Chrome or Edge (WebCodecs + AudioWorklet). Other browsers get chat only.

## What works

The shell is the Revolt/Discord shape (`docs/revolt-notes.md` has the measurements it follows):
a server rail on the left with your saved servers, the channel sidebar with the voice panel
and your user panel at the bottom, the chat with a channel header, and a member list on the
right. Under 880px it becomes the phone layout — one pane at a time behind a tab strip.

- Connect, saved servers, reconnect with backoff after a drop (fresh roster, no ghost "old me").
- Channel tree with people nested under their channel, search, collapse (remembered per
  server), counts, a join arrow on hover, status-dot avatars (speaking ring, muted, deafened,
  sharing). Members grouped by channel on the right. Click anyone for a profile card: banner,
  badges, connection stats, message / mute-for-me / volume / watch / join them.
- A voice view (the speaker icon in the header, the channel row in the voice card, or the voice
  pill on a phone): a tile per person in your channel with a speaking ring, mute and deafen
  glyphs and a LIVE badge, and a bar with hold to talk, mute, deafen, share screen and disconnect.
- Voice both ways over the TCP tunnel: 20 ms Opus at 16–96 kbit/s, per-user jitter buffer that reorders by sequence number and conceals lost packets with a mirrored, decaying copy of the last one.
  Cleaning: the browser's echo cancellation and gain control, then **RNNoise** — the neural
  denoiser Mumble desktop uses, compiled to WebAssembly and run in the worklet (−22 dB on
  realistic background noise, voice within 1 dB; `web/vendor/rnnoise`) — or the iOS app's
  spectral suppressor (Light / Strong, with a keyboard-click ducker). Voice activity uses
  RNNoise's voice probability over the room's noise floor; push to talk on any key or mouse
  button you pick in Settings
  (Space by default; the browser only hears keys while the window is focused); always on. Mute,
  deafen, local per-user mute and volume.
- Chat the Discord way: grouped by author within seven minutes, day dividers, a "New messages"
  line, hover toolbar (quote, copy, message them, mute for me), Enter sends and Shift+Enter
  breaks. Send to the channel, a channel and its subtree, or one person. Inbound HTML goes through a whitelist.
  Images: paste, drop or pick; they're shrunk to the server's limit and sent as the well-formed
  XHTML murmur insists on for long messages. A refused message is marked "Not delivered".
- Five palettes from the iOS app, the same typefaces, settings and diagnostics log in the sheet.
- **Screen share**, which stock Mumble clients don't have: the share button in the dock opens
  the browser's picker (screen, window or tab, with audio where the browser offers it). People
  in your channel see a card and a green badge on your name; Watch opens the video in a third
  column with live resolution / fps / bitrate / codec, full screen and picture-in-picture.
  Video goes peer to peer over WebRTC (AV1 › VP9 › H.264 › VP8, up to 1080p); only the
  signaling crosses the Mumble server, in `PluginDataTransmission`. A TURN server can be set in
  Settings for networks that block direct connections. Protocol: `docs/screen-share.md`.

## Layout

| Path | What it is |
|---|---|
| `src/protobuf.js` | Minimal protobuf reader/writer, the same subset the iOS app hand-rolls |
| `src/mumble.js` | Framing, message types, encode/decode. Shared by browser, bridge and tests |
| `src/voice.js` | Voice packet codec, both UDP wire formats (chosen by the server's version) |
| `src/rtcsignal.js` | Screen-share signaling: fragmenting/compressing JSON into ≤1000-byte plugin messages |
| `src/ocb2.js` | Mumble's voice cipher (OCB2-AES128 with nonce recovery), Node only |
| `bridge/server.mjs` | Static file server, WebSocket↔TLS relay, and the encrypted UDP voice lane |
| `app/client.js` | The session: handshake, roster, chat, reconnect, talking detection |
| `app/audio.js`, `app/worklets.js`, `app/dsp.js` | Capture → noise suppressor → gate → Opus → tunnel; tunnel → Opus → mixer |
| `app/share.js`, `app/stage.js` | WebRTC screen share (one connection per viewer) and its UI |
| `app/app.js`, `tree.js`, `messages.js`, `members.js`, `popovers.js`, `chat.js`, `store.js`, `themes.js`, `icons.js`, `ui.js` | The UI |
| `probe.mjs` | CLI handshake test — connects and dumps the roster, no browser involved |
| `test/` | Fake Mumble server, headless-Chromium driver, end-to-end and codec tests |

Field numbers mirror `Packages/MumbleCore/Sources/MumbleProtocol` so both clients stay in step.

## Testing

Nothing here talks to a real server. `test/fake-server.mjs` is a small Mumble server (TLS,
handshake, roster, text, voice relay, plugin data with murmur's limits) and `test/browser.mjs`
drives headless Chromium over the DevTools protocol — both with Node's built-ins only.

```sh
node web/test/webcodecs.test.mjs                    # does this Chromium do Opus the way we assume?
node web/test/e2e.test.mjs                          # two tabs, voice both ways over UDP, chat, images, reconnect
FAKE_VERSION=1.4.287 node web/test/e2e.test.mjs     # same, legacy voice format
FAKE_UDP=0 node web/test/e2e.test.mjs               # same with UDP blocked: voice must stay on the TCP tunnel
node web/test/ocb2.test.mjs                         # the cipher against Mumble's test vectors, loss/replay/resync rules
node web/test/share.test.mjs                        # screen share between two tabs, WebRTC + signaling
node web/test/signal.test.mjs                       # the plugin-message fragment codec, in Node
node web/test/dsp.test.mjs                          # the spectral suppressor: FFT, SNR gain, click ducking, block-size independence
node web/test/rnnoise.test.mjs                      # the RNNoise wasm: loads without imports, −22 dB on noise, voice kept, speed
node web/test/voice.test.mjs                        # voice packet codec round-trips and missing-packet arithmetic, in Node
node web/test/quality.test.mjs                      # a tone through two tabs: SNR, clicks, dropouts, underruns; FAKE_LOSS=0.05 FAKE_JITTER=40 to impair
node web/test/fake-server.mjs                       # keep one running to click around against
node web/probe.mjs <host> [port] [username]         # handshake against any server, read-only
```

`SHOTS=dir` saves screenshots from the end-to-end run; `VERBOSE=1` shows page console output.
