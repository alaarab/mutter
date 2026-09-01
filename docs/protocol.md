# Mumble protocol, as implemented by Mutter

Sources: `mumble-voip/mumble` (`src/Mumble.proto`, `src/MumbleUDP.proto`, `src/MumbleProtocol.h`,
`src/crypto/CryptStateOCB2.cpp`, `src/tests/TestCrypt/TestCrypt.cpp`, `docs/dev/network-protocol/*.md`).

## Control channel (TCP + TLS)

- Port 64738 by default, same port for UDP.
- TLS 1.2+, server certificate usually self-signed. Client certificate optional but is the identity
  used for registration; servers key users by the certificate hash.
- Framing: `uint16 type` + `uint32 length`, both big-endian, then `length` bytes of protobuf.
- Type IDs are the message order in `Mumble.proto`:

| ID | Message | ID | Message | ID | Message |
|---:|---|---:|---|---:|---|
| 0 | Version | 9 | UserState | 18 | UserList |
| 1 | UDPTunnel | 10 | BanList | 19 | VoiceTarget |
| 2 | Authenticate | 11 | TextMessage | 20 | PermissionQuery |
| 3 | Ping | 12 | PermissionDenied | 21 | CodecVersion |
| 4 | Reject | 13 | ACL | 22 | UserStats |
| 5 | ServerSync | 14 | QueryUsers | 23 | RequestBlob |
| 6 | ChannelRemove | 15 | CryptSetup | 24 | ServerConfig |
| 7 | ChannelState | 16 | ContextActionModify | 25 | SuggestConfig |
| 8 | UserRemove | 17 | ContextAction | 26 | PluginDataTransmission |

- Type 1 (UDPTunnel) is not protobuf: the payload is a raw voice packet, unencrypted.
- Field numbers for every message are mirrored in `MumbleProtocol/Messages.swift`.

## Handshake

1. TLS connect.
2. Client → `Version{version_v1, version_v2, release, os, os_version}`.
3. Client → `Authenticate{username, password?, tokens[], opus: true, client_type: 0}`.
4. Server → `Version`, `CryptSetup{key, client_nonce, server_nonce}`, `CodecVersion`, many
   `ChannelState` (channels first without links, then links), `PermissionQuery`, many `UserState`,
   then `ServerSync{session, max_bandwidth, welcome_text, permissions}`, then `ServerConfig`,
   `SuggestConfig`.
5. `Reject{type, reason}` instead of `ServerSync` means failure.
6. After sync: client sends `Ping` on TCP every 5 s (with UDP stats), and an encrypted UDP ping
   every 5 s. Server drops clients silent for ~30 s.

Version encodings:

- v1 (`uint32`): `major << 16 | minor << 8 | patch`, minor/patch saturate at 255.
- v2 (`uint64`): `major << 48 | minor << 32 | patch << 16`.
- Prefer v2 when non-zero.

## Voice (UDP)

Every UDP datagram is OCB2-AES128 encrypted: `[iv byte][tag0][tag1][tag2][ciphertext]`.
Encrypt key = `CryptSetup.key`; client encrypts with `client_nonce` as its IV, decrypts with
`server_nonce`. The IV is incremented (little-endian across 16 bytes) before each encrypt.

The plaintext format depends on the **server's** version:

### Legacy (server < 1.5.0)

- Byte 0: `type << 5 | target`. Types: 0 CELT α, 1 Ping, 2 Speex, 3 CELT β, 4 Opus. Only Opus is
  implemented. Target: 0 normal, 1–30 whisper targets, 31 loopback. In server→client packets the
  low 5 bits mean context: 0 normal, 1 shout, 2 whisper, 3 listener.
- Audio: `varint session` (server→client only), `varint sequence`, `varint length` where bit
  `0x2000` is the terminator flag and the low 13 bits are the Opus payload length, Opus bytes,
  optional 3 little-endian floats of position.
- Ping: byte `0x20`, then `varint timestamp`.
- Mumble varint prefixes: `0xxxxxxx` 7-bit, `10xxxxxx`+1 14-bit, `110xxxxx`+2 21-bit,
  `1110xxxx`+3 28-bit, `111100__`+4 32-bit, `111101__`+8 64-bit, `111110__` + varint = negated,
  `111111xx` = `~xx` (−1…−4).

### Protobuf (server ≥ 1.5.0)

- Byte 0: `0` = Audio, `1` = Ping. Then a `MumbleUDP.Audio` / `MumbleUDP.Ping` protobuf.
- Audio fields: 1 target / 2 context (oneof), 3 sender_session, 4 frame_number, 5 opus_data,
  6 positional_data (repeated float, may be packed), 7 volume_adjustment, 16 is_terminator.
- Ping fields: 1 timestamp, 2 request_extended_information, 3 server_version_v2, 4 user_count,
  5 max_user_count, 6 max_bandwidth_per_user.

### Tunnel fallback

If no encrypted UDP ping reply arrives within ~10 s, voice is sent as `UDPTunnel` frames on TCP
(same plaintext format, no encryption). Return to UDP as soon as pings flow again. If decrypts
stall for 5 s while UDP is up, send an empty `CryptSetup` to ask for a fresh `server_nonce`;
if the server sends an empty `CryptSetup`, reply with `CryptSetup{client_nonce = encrypt IV}`.

### Server probe (unencrypted)

Request: `00 00 00 00` + 8-byte identifier. Reply: `uint32 version_v1`, identifier,
`uint32 users`, `uint32 max_users`, `uint32 bandwidth`; all big-endian. Used for the server list.

## OCB2-AES128

Port of `CryptStateOCB2.cpp`. `S2` doubles in GF(2^128) (shift left across 16 bytes, xor 0x87 on
carry), `S3 = S2 ^ identity`. Tail block: pad = E(len·8 in the last 4 bytes ⊕ delta); checksum
includes the padded tail. Tag = E(S3(delta) ⊕ checksum); first 3 bytes go on the wire.

Decrypt nonce recovery (from upstream): in-order if `iv[0]+1 == byte`; otherwise compute the
signed byte difference; `-30 < diff < 0` → late packet (decrypt with adjusted IV, then restore);
`diff > 0` → lost packets, advance; anything else → drop. A replay table `history[iv[0]] = iv[1]`
rejects repeats.

XEX* countermeasure (2019): on encrypt, if the second-to-last block is zero in bytes 0–14, flip
bit 0 of that block and of the checksum. On decrypt, fail if the padded last block equals delta in
bytes 0–14.

Test vectors (key = nonce = `00 01 … 0f`):

- empty message → tag `BF3108130773AD5EC70EC69E7875A7B0`
- plaintext `00…27` (40 bytes) → ciphertext `F75D6BC8B4DC8D66B836A2B08B32A6369F1CD3C5228D79FD6C267F5F6AA7B231C7DFB9D59951AE9C`,
  tag `9DB0CDF880F73E3E10D4EB3217766688`

## Permissions bits

`write 0x1, traverse 0x2, enter 0x4, speak 0x8, muteDeafen 0x10, move 0x20, makeChannel 0x40,
linkChannel 0x80, whisper 0x100, textMessage 0x200, makeTempChannel 0x400, listen 0x800,
kick 0x10000, ban 0x20000, register 0x40000, selfRegister 0x80000, resetUserContent 0x100000`.
