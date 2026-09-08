# Shared phone layout

The shipping iPhone interface in `Mutter/Features` is the layout reference for Android.
Shared colors and fonts alone do not establish parity. Keep the same screen hierarchy,
content order, control placement, and visual density when changing either phone app.

| Area | Phone layout |
| --- | --- |
| Home | Settings at top left; browse and add at top right; Mutter title; grouped Favourites and Recent rows |
| Session | Back button, server title, online/channel subtitle, and latency in one compact header |
| Navigation | Channels, Chat, Server; Channels opens first |
| Channels | Search above an indented channel tree; circular person avatars and inline status badges |
| Call controls | Current channel and speaking status, then mute, deafen, output, and more; push-to-talk underneath |
| Chat | Incoming bubbles on the left and accent-colored own bubbles on the right; photo, destination, composer, send |
| Server | Grouped welcome, server, connection, identity, account, and disconnect rows |
| Settings | Compact title/Done bar; voice and certificates first; identity, appearance, behaviour, sharing |
| Profiles | Avatar beside name and badges; comment; personal volume/mute/message controls; moderation and details |

Use `design/themes.json` for palette roles, avatars, motion, and shared radii, and the fonts
in `design/fonts`. Platform system bars, permission prompts, keyboards, and accessibility
adaptations may differ. Large text and short windows must retain readable, reachable controls.
In short landscape windows, search scrolls with the tree and push-to-talk sits beside the call
controls. While typing, nonessential chrome yields space to the focused input. Sheet actions
stay on one line as text grows.

`PolishTest` exercises the Android navigation contract, call menus, channel tree, settings
restoration, chat, and all 22 theme variants. Its optional screenshot capture uses the populated
fixture on port 64746. Review actual iPhone and Android captures with the same palette, people,
and voice mode before accepting a phone layout change; historical mockups are not the reference.
