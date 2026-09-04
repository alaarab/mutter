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

Same three shapes as VS Code. Grab one from the [releases](https://github.com/alaarab/mutter/releases):

| File | Like VS Code's… | What happens |
|---|---|---|
| `Mutter-x.y.z-win-setup.exe` | User Setup | Installs to `%LOCALAPPDATA%\Programs\Mutter`, Start menu and desktop shortcut, no admin prompt. Settings in `%APPDATA%\Mutter`. |
| `Mutter-x.y.z-win.zip` | .zip download | Unzip anywhere and run `Mutter.exe`. Create a `data` folder beside it and *everything* the app remembers lives there — move the folder, move your setup. |
| `Mutter-x.y.z-win-portable.exe` | Portable Mode | One file. Keeps a `data` folder beside itself, so a USB stick carries the app and its servers together. |
| `.dmg` / `.AppImage` | — | macOS and Linux. The `data`-folder rule works for the AppImage too. |

They are unsigned, so Windows SmartScreen will say "unrecognised app" the first time: *More info →
Run anyway*.

### On a managed work laptop, don't

If the machine runs an EDR such as CrowdStrike, or AppLocker/WDAC, an unsigned executable it has
never seen is likely to be blocked — and may raise a detection with your name on it. Nothing here
is worth that. The browser-and-bridge setup in [`web/`](../web/README.md#running-it) already
gives you "install and it works" on such a machine without introducing a single new Windows
binary: install Mutter as an app from the browser's address bar, and have the bridge start with
Windows. Use these builds on machines you own, and hand them to friends.

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
