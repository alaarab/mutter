# Feature coverage

What Mumble offers, and where Mutter stands. "Done" means implemented in code; nothing has been
run on a device yet.

## Voice

| Feature | Status |
|---|---|
| Opus voice, OCB2-AES128 UDP, TCP tunnel fallback and recovery | Done |
| Push-to-talk (hold or toggle), voice activity with live meter, always on | Done |
| Whisper to people / shout to a channel (voice targets) | Done: hold-to-whisper button, whisper mode, target picker |
| Listen to a channel without joining (1.4 listeners) | Done |
| Priority speaker, server mute/deafen, self mute/deafen, suppress | Done |
| Local per-user mute and volume | Done |
| Bluetooth / AirPods / speakerphone routing | Done |
| Echo cancellation and automatic gain (Apple voice processing) | Done |
| System Voice Isolation mic mode (Apple's ML isolation, FaceTime-grade) | Done: picker in Voice & audio settings |
| Spectral noise suppression for hiss, fans, hum (own DSP) | Done: Off / Light / Strong |
| Adaptive voice gate that tracks room noise | Done |
| Click-free playback (fade-in/out, soft limiter) | Done |
| Stays connected with the screen locked or the app in the background | Done (audio background mode keeps the session alive) |
| Positional audio, recording, sidetone | Not planned (desktop features) |

## Channels and people

| Feature | Status |
|---|---|
| Channel tree with collapsing, search, live counts, speaking rings | Done |
| Hide empty channels | Done |
| Join, create temporary/permanent channels, rename, delete, links | Done |
| Restricted and locked channels, max users | Done |
| Comments, avatars, registered badge, user stats | Done |
| Kick, ban, move user, register self | Done |
| Registered users list (rename / remove) | Done |
| Ban list editor | Not yet |
| ACL / group editor | Not yet |
| Server-defined context actions | Not yet |
| Friends list, ignore list | Not yet |

## Chat

| Feature | Status |
|---|---|
| Channel, channel-tree and direct messages | Done |
| HTML formatting, links, inline images received | Done |
| Sending photos (shrunk to the server's image size limit) | Done |
| Unread badge, local notifications when backgrounded | Done |

## Connection and identity

| Feature | Status |
|---|---|
| Certificates: create on device, import .p12, choose per server | Done |
| Server certificate pinning with first-contact / changed prompts | Done |
| Server password, access tokens | Done |
| Public server directory, Bonjour LAN discovery, live occupancy probe | Done |
| Auto-reconnect with backoff | Done |
| Export certificate as .p12 | Not possible without OpenSSL on iOS |

## iOS integration

| Feature | Status |
|---|---|
| Live Activity on the lock screen: server, channel, who's speaking, mute + talk buttons | Done |
| Dynamic Island compact/expanded views | Done |
| Now Playing on the lock screen and in Control Centre | Done |
| Headset / AirPods play-pause button toggles mute or talk | Done |
| App Intents: connect to server, toggle mute, push to talk, deafen, disconnect | Done |
| Action button and Shortcuts via the intents above; Siri phrases | Done |
| Haptics on voice activation, keep-screen-awake option | Done |
| Volume buttons as push-to-talk | Not possible (App Store rejects apps that repurpose them) |
| CallKit call UI | Not planned; the Live Activity covers the lock screen without CallKit's constraints |
| iPad two-column layout | Not yet |
| Apple Watch companion | Not yet |
