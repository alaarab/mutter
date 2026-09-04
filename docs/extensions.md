# Extensions

Small extensions Mutter adds over `PluginDataTransmission` (control message type 26), the same
side channel the screen share signals on. The server is stock: `data` is capped at 1000 bytes,
`dataID` at 100 characters, receivers must be listed explicitly (an empty list delivers to
nobody), and a leaky bucket allows a burst of 15 then 4 messages per second — overflow is
dropped silently. Screen share's own framing is in `docs/screen-share.md`; the messages here are
a handful of bytes and need none of it.

## Typing indicator

Mumble has no typing indicator. Implemented in `web/app/typing.js`; iOS can mirror it byte for
byte.

`dataID = "mutter/typing"`. `data` is 1 byte for a direct message, 5 for channel typing:

| Offset | Size | Field | Meaning |
|---:|---:|---|---|
| 0 | 1 | `state` | `1` started/still typing, `0` stopped. Any other value: ignore the message. |
| 1 | 4 | `channelId` | uint32 big-endian. **Present for channel typing, absent for a DM** — the receiver is the only addressee, so the scope is implicit. |

### Timing

| Rule | Value | Who |
|---|---:|---|
| Repeat a start while typing continues | 3 s | sender |
| No input for this long → send `0` | 5 s | sender |
| Forget a typer not restarted since | 6 s | receiver |

The sender emits a start on the first input event, then at most one per 3 s for as long as
input keeps arriving. It sends `0` when the composer goes idle for 5 s, when the message is sent
or cleared, or when the scope changes (`0` for the old scope, then a start for the new one). A
receiver expires an entry 6 s after the last start it saw, so a sender that crashes or drops off
leaves no indicator stuck on; the extra second over the repeat interval absorbs jitter. Nothing
is sent while disconnected, and a disconnect clears both sides' state.

At one message per 3 s per typing burst this is far under the server's budget, so no client-side
token bucket is needed.

### Receivers

- Channel typing: every other user currently in that channel, from the live roster.
- DM: that one session.

The list is rebuilt from the roster on every send, and the send is skipped when it would be
empty. `0` goes to everyone a start was sent to (minus anyone who has since left), which may be
more than the current channel members.
