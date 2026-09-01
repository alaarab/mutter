# Mutter design notes

## Goal

Same protocol as Mumble, an interface people actually want to use on a phone. The old official
app is a 2011 UIKit table-view app: a flat channel list, no collapsing, tiny status icons, and
voice controls hidden behind a toolbar.

## What was borrowed

**From Discord mobile (2023–2025 redesign)**

- Clear hierarchy: server → channels → people, with people nested under the channel they're in.
- A persistent voice "dock" at the bottom that survives tab changes: current channel, who is
  speaking, mute / deafen / speaker / leave, all one thumb away.
- Speaking rings on avatars instead of a separate speaker icon.
- Distinct tabs for the channel tree and chat, with an unread badge, instead of one screen that
  tries to do both.
- Presence toasts (joined/left/moved) that don't interrupt.

**From the Claude app / Anthropic design language**

- Warm cream canvas (`#FAF9F5`) and warm black (`#181715`) instead of Discord's cold greys.
- One coral accent (`#CC785C`) used sparingly: joins, active tab, own message bubbles, CTA.
- Serif display type (New York on iOS) for server and channel names, humanist sans for UI.
- Elevation by colour blocking (card on canvas) rather than shadows.
- Copy written in sentences ("Hold the button to talk"), not labels.

## Structure

```
Home (NavigationStack)
├── Favourites / Recent / On this network   ← live users & latency from a UDP probe
├── + Add server / Quick connect
├── Public directory (searchable, grouped by country, live counts)
└── Settings → Voice & audio, Certificates, Appearance, Behaviour

Session (full screen, replaces Home while connected)
├── Header: server name, state, ping pill, leave
├── Channels tab: collapsible tree with search, join buttons, speaking rings
├── Chat tab: unified timeline, scope picker (channel / tree / DM), images
├── Server tab: welcome, versions, connection stats, certificate, permissions
└── Dock: VoiceBar (+ PTT button or VAD meter) and the tab strip
```

Sheets: user (local mute/volume, message, moderation gated on real permissions, stats),
channel (join, listen, message, manage), certificate trust (first contact vs changed), server
edit, quick connect, identity create/import.

## Tokens

See `app/Mutter/Design/Theme.swift`. Radii 8/12/16, 4-pt spacing, adaptive light/dark palettes,
semantic green (speaking), amber (warning), red (danger), indigo (whisper/listen).

## Decisions

- Custom bottom dock instead of `TabView` so the voice bar sits above the tabs on every screen.
- Tapping a channel row opens details; the explicit arrow joins. Accidental joins on a phone are
  worse than one extra tap, and long-press/context menus cover power users.
- Voice activity is the default transmit mode with a visible meter and threshold marker; PTT is
  a full-width button (hold or toggle) because the old app's small PTT was a top complaint.
- Certificate pinning with a human-readable prompt rather than silently trusting everything.
