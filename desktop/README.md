# Mutter Desktop

The web client and its bridge in one window. Nothing here is new code: the main process runs
`web/bridge/server.mjs` exactly as WSL does, and the window loads the same `web/app`. What the
shell adds is the part a browser can't give you.

**Why it exists.** A managed browser carries its employer's policies onto every network, and a
common one disables WebRTC over UDP — voice keeps working because the bridge sends that from
Node, but a screen share from the browser process can never connect. Electron ships its own
Chromium and reads no policy from the registry, so the same code connects. It also gives a real
screen picker with **system audio on Windows** (loopback capture, which `getDisplayMedia` in a
browser tab does not offer), one taskbar entry with our icon, and an install that asks for no
admin.

## Run it

Nothing to install on the machine you run it on. Grab a file from the
[releases](https://github.com/alaarab/mutter/releases):

| File | What it is |
|---|---|
| `Mutter-x.y.z-portable.exe` | Runs from wherever you put it. No install, no admin, leaves nothing behind. |
| `Mutter-x.y.z-setup.exe` | Per-user install to `%LOCALAPPDATA%\Programs`, Start menu entry, no admin prompt. |
| `Mutter-x.y.z-mac-*.dmg` / `.AppImage` | macOS and Linux. |

They are unsigned, so Windows SmartScreen will say "unrecognised app" the first time: *More info →
Run anyway*. Signing needs a certificate we don't have; see below if that becomes worth doing.

## Build it

Releases are built by [the workflow](../.github/workflows/desktop.yml) on GitHub's runners —
push a tag like `v0.1.0` and the three platforms build and attach themselves to a release, so no
toolchain is needed anywhere near the laptop.

To build locally you need Node 22+:

```sh
cd desktop
npm install
npm start            # run from source, with the bridge on a random port
npm run dist:win     # portable + per-user installer into desktop/dist (run this on Windows)
```

Windows targets can only be built on Windows without `wine`; macOS targets only on macOS.

## How it fits together

```
BrowserWindow ──http/ws──▶ bridge (in the main process) ──TLS + UDP──▶ murmur
      │
      └── getDisplayMedia() ──▶ setDisplayMediaRequestHandler ──▶ our picker (picker.html)
                                                             └──▶ audio: 'loopback' on Windows
```

- `PORT=0` is set before the bridge is imported, so the OS picks a free port and two copies of
  the app never fight over 8788. The bridge's `ready` promise resolves with the URL.
- `web/` and the fonts are shipped as extra resources next to the app, not inside the archive,
  so they can be inspected and edited in place. The bridge finds them through
  `process.resourcesPath`.
- The renderer runs sandboxed with context isolation and no preload; it is the plain web client.
  Only the picker page has a preload, and it exposes two functions.

## Signing, later

Unsigned is fine for a handful of friends. If SmartScreen becomes a nuisance, an Authenticode
certificate plus `CSC_LINK`/`CSC_KEY_PASSWORD` secrets in the workflow is all electron-builder
needs; the config already leaves room for it.
