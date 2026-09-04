# When a screen share won't connect

Screen share video goes straight from the sharer to each viewer over WebRTC. Nothing relays it,
which is why it costs the Mumble server nothing and why nobody in the middle can see it. The
price of that is that the two ends have to be able to reach each other, and sometimes they
can't.

## Find out which end is the problem

Both people open **Settings → Screen share → Test my connection**. It gathers candidates and
says what this network can produce:

| Line | Meaning |
|---|---|
| `local address` | The browser can do WebRTC at all. If this says no, nothing else matters. |
| `public address` | STUN worked: the internet can see you at that address. |
| `relay` | A TURN relay answered, so there is a fallback even if direct fails. |

Read the pair of results together:

- **Either side has no public address.** UDP to the STUN server is blocked on that network — a
  corporate laptop or a hotel will do this. Direct is impossible; only a relay gets through.
- **Both have public addresses but the share still fails.** At least one end is behind a
  symmetric NAT, where the address the outside sees changes per destination, so the address STUN
  reported is useless to the other peer. Again, only a relay gets through.
- **Both have a relay.** It will connect. Relayed video is slower and costs the relay's
  bandwidth, but it works everywhere.

The Server tab's log also prints the candidate types both ends offered and the path chosen the
moment a connection succeeds or fails, e.g. `viewer failed: local host×2 srflx×1 · remote
host×3 · no relay (TURN) configured`.

## The fix: a relay you own

A relay must sit somewhere both people can reach, which means a public address — the Mumble
server's box is the obvious place. [coturn](https://github.com/coturn/coturn) does STUN and TURN
in one process:

```sh
sudo apt install coturn
sudo sed -i 's/^#TURNSERVER_ENABLED/TURNSERVER_ENABLED/' /etc/default/coturn
```

`/etc/turnserver.conf`:

```conf
listening-port=3478
tls-listening-port=5349          # 443 is better: the networks that block UDP rarely block 443
fingerprint
lt-cred-mech
user=mutter:CHANGE_THIS
realm=example.com                # your domain
external-ip=YOUR.PUBLIC.IP       # only if the box is behind NAT itself
min-port=49160
max-port=49200
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
```

Those `denied-peer-ip` lines matter: without them anyone with the credentials can use the relay
to reach machines inside your network.

Open 3478 and 5349 on TCP and UDP, plus the 49160–49200 UDP range, then
`sudo systemctl enable --now coturn`.

In **Settings → Screen share**, set:

- STUN: `stun:your.host:3478`
- TURN: `turn:your.host:3478` (or `turns:your.host:5349` to tunnel over TLS, which is what gets
  through the strictest networks)
- the username and credential from `user=`

Both people need the same entries. Pointing STUN at your own box also drops the default
`stun:stun.l.google.com:19302`, after which no third party is involved anywhere in the app.

## What a relay does and doesn't see

TURN forwards the media stream, so the operator sees packets and knows who is connected to whom
and how much data moved. It does not see the picture: WebRTC encrypts the media end to end with
DTLS-SRTP, and the relay has no key. That is why a relay you run yourself is worth the trouble
over a public one.
