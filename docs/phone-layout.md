# Phone layout

Channels, messages, and call controls stay within reach. This guide covers where to find
everything in the mobile apps, from joining a channel to changing your theme.

## Where things belong

| Screen or control | Shared layout |
| --- | --- |
| Home | Settings at the top left; browse and add at the top right; saved servers below |
| Session header | Back, server name, people online, current channel, and latency |
| Tabs | Channels, Chat, Server, with Channels selected when you connect |
| Channels | Search, an indented tree, circular avatars, and status badges beside people |
| Call dock | Channel and voice status; mute, deafen, output, and more; push-to-talk below |
| Chat | Incoming messages left, your messages right, destination beside the composer |
| Server | Grouped server, connection, and identity details |
| Settings | Voice, certificates, identity, appearance, behaviour, and sharing |
| Profiles | Avatar beside the name and badges, then comment, personal mute, volume, and messaging |

Status bars, keyboards, permission prompts, and switches still follow their platform. Short
landscape windows put push-to-talk beside the other call controls and let search scroll with
the channel list. When the keyboard takes most of the screen, the input gets priority.

The browser and Electron keep their wider layouts while sharing Mutter’s colors, fonts,
and visual style.

## Colors that mean the same thing

All four clients draw from [the shared theme catalog](../design/themes.json). Each of its
11 themes has light and dark variants. Accent colors mark actions and selections; green means
voice or presence, red marks mute and errors, amber signals caution, and violet marks whisper
or video sharing. Avatars use colors from the active theme too.

The [design guide](design.md) explains the color roles, typography, and transitions. The palette
generator checks contrast, but screenshots still matter: opacity and surrounding surfaces can
change how a color reads in the app.

## Keeping the apps familiar

Keep the screen hierarchy, content order, and control placement consistent when changing a phone screen.
Compare the running apps with the same theme, people, and voice mode, then check large text,
the keyboard, and a short landscape window. Keep colors in the shared catalog and reuse the
existing controls so a fix carries through the app.

[Back to the docs](README.md) · [Build Android](../android/README.md) · [Build iOS](ios.md)
