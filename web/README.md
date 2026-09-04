# Mutter Web

A browser client for Mumble that speaks the protocol itself, so a machine where you can't
install anything can still be a first-class participant — including, eventually, our
screen-sharing extension, which stock Mumble clients don't implement.

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
node web/bridge/server.mjs      # then open http://localhost:8788
```

Set `PORT` to use a different port.

## Layout

| Path | What it is |
|---|---|
| `src/protobuf.js` | Minimal protobuf reader/writer, the same subset the iOS app hand-rolls |
| `src/mumble.js` | Framing, message types, encode/decode. Shared by browser and bridge |
| `bridge/server.mjs` | Static file server + WebSocket↔TLS relay |
| `app/` | The client: UI, Midnight theme, brand faces served from the iOS app's fonts |
| `probe.mjs` | CLI handshake test — connects and dumps the roster, no browser involved |

Field numbers mirror `Packages/MumbleCore/Sources/MumbleProtocol` so both clients stay in step.

```sh
node web/probe.mjs <host> [port] [username]
```

## Status

Working: connect, authenticate, channel/user roster with live join/leave, text chat, ping.

Next: voice (getUserMedia → WebCodecs Opus → `UDPTunnel`, tunnelled over TCP so we skip the
UDP crypto entirely), then screen share over `PluginDataTransmission` (type 26) with
`getDisplayMedia` — which is considerably easier here than ReplayKit is on iOS.
