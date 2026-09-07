# Mutter design system

Mutter uses softly shaded surfaces, restrained ambient color, Bricolage Display headings, and
Plus Jakarta Sans body text. Color and motion have one maintained source across iOS, web,
Electron, the screen picker, and Live Activities.

## Shared catalog

Edit `design/themes.json`, then run:

```sh
node scripts/generate-themes.mjs
node scripts/generate-themes.mjs --check
```

The generator writes `web/app/theme-data.js`, `web/app/tokens.css`,
`Mutter/Shared/ThemeCatalog.swift`, the PWA launch colors, and the native accent/launch colors.
Generated files are checked in, so building or running the app needs no extra generation step. CI rejects stale
outputs. Do not add a second palette in a component, window, or widget.

| Theme | Character |
| --- | --- |
| Carbon | Graphite and silver |
| Graphite | Charcoal and iris |
| Midnight | Deep navy and ice |
| Slate | Steel and periwinkle |
| Moss | Forest and sage |
| Plum | Aubergine and rose |
| Paper | Parchment and clay |
| Ultra | Obsidian and citron |
| Ember | Espresso and apricot |
| Orchid | Velvet and lilac |
| Mint | Deep teal and sea glass |

Every theme has light and dark variants. New installs use Carbon and the system appearance.
Existing saved theme names are preserved. Web settings written before the appearance selector
retain their former appearance (Paper light, the other themes dark). The native app retains
its existing appearance preference. Live Activities use the selected theme's dark variant to
fit the lock screen and Dynamic Island; their theme travels with the activity state.

## Color roles

- `bg`, `surface`, `elevated`, and `sunken` establish depth. Use `separator` for boundaries and
  `surfaceHighlight` for the gentle edge lighting used by native cards.
- `ink`, `body`, and `muted` establish text hierarchy. The generator tunes their luminance to
  keep text readable across all four surfaces, with at least 4.8:1 contrast (7:1 for `ink`).
- `accent` is for selection, actions, links, and unread messages. `secondary` provides ambient
  color and decorative variation. Text on a filled action uses `onAccent`.
- Green means voice/presence, red means mute/error/destructive action, amber means caution,
  and violet means whisper or video sharing. Filled status controls use `onStatus`.
- Avatars use six related colors derived from the active palette and the same UTF-8 name hash
  on all clients. Their foreground is `onAvatar`; do not introduce a separate avatar palette.
- Video/image surfaces remain black with light overlays regardless of theme. These are media
  colors, not application backgrounds.

The generator checks button and avatar contrast as well as text. These are token checks;
rendered surfaces, opacity, hover states, and layouts still need visual review.

## Surfaces and motion

Use low-opacity accent/secondary light at the edges of large surfaces, subtle sheen on cards
and the voice dock, and one soft shadow treatment for floating surfaces. Content stays on a
quiet background. Keep the radius scale at 8/12/16/20 points, with smaller radii for compact
controls and full circles/capsules where the control calls for them.

The motion scale is 120 ms for press/hover, 180 ms for small changes, 240 ms for panels, and
260 ms for theme changes, using the shared easing curve. Theme changes preserve the session,
open sheets, drafts, and view identity. Web floating surfaces use `motion.js` for cancellable
entrance/exit animations; avoid independent timeout-based hide logic. Respect reduced motion.
Speaking halos follow the active speaking state without an unrelated continuous pulse.

The in-app mark and platform icons come from `docs/brand/icon.svg`:

```sh
swift scripts/make-appicon.swift
```

The graphite artwork is shared by the regular and dark iOS icons. Desktop assets retain
rounded corners, iOS gets square opaque assets, and the browser gets the SVG. The script also
extracts the monochrome mark used inside the interface.

## Verification

```sh
node scripts/generate-themes.mjs --check
CHROME=/path/to/chromium SHOTS=/tmp/mutter-appearance node --test web/test/appearance.test.mjs
node --test desktop/test/persistence.test.mjs
```

The appearance check renders all 22 variants, checks theme selection and saved settings,
keeps a live session and composer in place, tests rapid sheet reopening, checks narrow layouts
and system/reduced-motion preferences, and renders the real desktop picker with a stubbed
preload bridge. The Electron test verifies the real shell across two launches. Build the
`Mutter` scheme in Xcode to verify the native app and widget together. `MutterUITests` cycles
through every theme in both appearances, checks that Settings stays open, and samples the
rendered preview to catch a sheet retaining the wrong appearance. Its screenshots are kept in
the Xcode test results. Native list sections use `.themedRows()` and their containers use
`.themedList()` so they share the same surface treatment.

`docs/mockups` contains historical explorations. Screenshots from the running app are the
current visual reference.
