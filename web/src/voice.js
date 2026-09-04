// Voice packet codec: both Mumble UDP wire formats, carried over the TCP control channel via
// UDPTunnel so the browser never touches the UDP crypto. Port of VoicePacket.swift.
//
// The format is chosen by the SERVER's announced version: 1.5.0+ speaks protobuf, older
// servers use the legacy header-byte layout.

import { Reader, Writer } from './protobuf.js';

export const OPUS = 4;                     // legacy audio type
const TERMINATOR = 0x2000;                 // legacy: high bit of the length field

/// Mumble's own varint (NOT protobuf's). Only needed for the legacy layout.
export const MumbleVarint = {
  encode(value, out) {
    let v = BigInt(value);
    if (v < 0n) {
      if (v >= -4n) { out.push(0xFC | Number(~v & 0x03n)); return; }
      out.push(0xF8); this.encode(~v, out); return;
    }
    if (v < 0x80n) out.push(Number(v));
    else if (v < 0x4000n) out.push(Number(v >> 8n) | 0x80, Number(v & 0xFFn));
    else if (v < 0x200000n) out.push(Number(v >> 16n) | 0xC0, Number((v >> 8n) & 0xFFn), Number(v & 0xFFn));
    else if (v < 0x10000000n) out.push(Number(v >> 24n) | 0xE0, Number((v >> 16n) & 0xFFn), Number((v >> 8n) & 0xFFn), Number(v & 0xFFn));
    else if (v < 0x100000000n) out.push(0xF0, Number((v >> 24n) & 0xFFn), Number((v >> 16n) & 0xFFn), Number((v >> 8n) & 0xFFn), Number(v & 0xFFn));
    else { out.push(0xF4); for (let s = 56n; s >= 0n; s -= 8n) out.push(Number((v >> s) & 0xFFn)); }
  },
  /// Returns [value, newOffset] or null on truncation.
  decode(b, i) {
    if (i >= b.length) return null;
    const v = b[i];
    if ((v & 0x80) === 0) return [BigInt(v & 0x7F), i + 1];
    if ((v & 0xC0) === 0x80) return i + 1 < b.length ? [BigInt(((v & 0x3F) << 8) | b[i + 1]), i + 2] : null;
    if ((v & 0xE0) === 0xC0) return i + 2 < b.length ? [BigInt(((v & 0x1F) << 16) | (b[i + 1] << 8) | b[i + 2]), i + 3] : null;
    if ((v & 0xF0) === 0xE0) return i + 3 < b.length ? [BigInt(((v & 0x0F) << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) & 0xFFFFFFFFn, i + 4] : null;
    switch (v & 0xFC) {
      case 0xF0: return i + 4 < b.length ? [BigInt(((b[i + 1] << 24) | (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4]) >>> 0), i + 5] : null;
      case 0xF4: { if (i + 8 >= b.length) return null; let r = 0n; for (let k = 1; k <= 8; k++) r = (r << 8n) | BigInt(b[i + k]); return [BigInt.asIntN(64, r), i + 9]; }
      case 0xF8: { const inner = this.decode(b, i + 1); return inner ? [~inner[0], inner[1]] : null; }
      case 0xFC: return [~BigInt(v & 0x03), i + 1];
    }
    return null;
  },
};

/// Outgoing audio (client → server). `frameNumber` is the sequence of the first frame.
export function encodeAudio({ target = 0, frameNumber = 0, opus, isTerminator = false }, format) {
  if (format === 'legacy') {
    const out = [(OPUS << 5) | (target & 0x1F)];
    MumbleVarint.encode(frameNumber, out);
    MumbleVarint.encode((opus.length & 0x1FFF) | (isTerminator ? TERMINATOR : 0), out);
    const head = Uint8Array.from(out);
    const pkt = new Uint8Array(head.length + opus.length);
    pkt.set(head); pkt.set(opus, head.length);
    return pkt;
  }
  // protobuf: 1=target 4=frame_number 5=opus_data 16=is_terminator, prefixed by UDPMessageType 0
  const w = new Writer().uint(1, target & 0x1F).uint(4, frameNumber).bytes(5, opus);
  if (isTerminator) w.bool(16, true);
  const body = w.finish();
  const pkt = new Uint8Array(body.length + 1);
  pkt[0] = 0; pkt.set(body, 1);
  return pkt;
}

/// UDP ping (client → server). The server echoes the timestamp, which gives the round trip.
export function encodePing(timestampMicros, format) {
  if (format === 'legacy') { const out = [0x20]; MumbleVarint.encode(timestampMicros, out); return Uint8Array.from(out); }
  const body = new Writer().uint(1, timestampMicros).finish();
  const pkt = new Uint8Array(body.length + 1);
  pkt[0] = 1; pkt.set(body, 1);
  return pkt;
}

/// Incoming packet from the server (via UDPTunnel). Returns { kind: 'audio'|'ping', ... } or null.
export function decodeVoice(b, format) {
  if (!b.length) return null;
  if (format === 'legacy') {
    const type = b[0] >> 5;
    if (type === 1) { const t = MumbleVarint.decode(b, 1); return t ? { kind: 'ping', timestamp: t[0] } : null; }
    if (type !== OPUS) return null;                 // CELT/Speex are long dead
    const context = b[0] & 0x1F;
    let r = MumbleVarint.decode(b, 1); if (!r) return null; const [session, i1] = r;
    r = MumbleVarint.decode(b, i1); if (!r) return null; const [seq, i2] = r;
    r = MumbleVarint.decode(b, i2); if (!r) return null; const [lenField, i3] = r;
    const len = Number(lenField & 0x1FFFn);
    if (i3 + len > b.length) return null;
    return { kind: 'audio', session: Number(session), frameNumber: seq, context, isTerminator: (lenField & BigInt(TERMINATOR)) !== 0n, opus: b.subarray(i3, i3 + len) };
  }
  const body = b.subarray(1);
  if (b[0] === 0) {
    const p = { kind: 'audio', target: 0, context: 0, session: 0, frameNumber: 0n, opus: new Uint8Array(0), isTerminator: false, volume: 0 };
    new Reader(body).forEachField(f => {
      switch (f.number) {
        case 1: p.target = f.uint; break;
        case 2: p.context = f.uint; break;
        case 3: p.session = f.uint; break;
        case 4: p.frameNumber = BigInt(f.uint); break;
        case 5: p.opus = f.payload; break;
        case 7: if (f.payload?.length === 4) p.volume = new DataView(f.payload.buffer, f.payload.byteOffset).getFloat32(0, true); break;
        case 16: p.isTerminator = f.bool; break;
      }
    });
    return p;
  }
  if (b[0] === 1) {
    const p = { kind: 'ping', timestamp: 0n };
    new Reader(body).forEachField(f => { if (f.number === 1) p.timestamp = BigInt(f.uint); });
    return p;
  }
  return null;
}

/// Wire format from the server's Version message (v2 is 64-bit: major<<48 | minor<<32 | patch<<16).
export function wireFormatFor({ v1, v2 }) {
  let major, minor;
  if (v2) { const big = BigInt(v2); major = Number((big >> 48n) & 0xFFFFn); minor = Number((big >> 32n) & 0xFFFFn); }
  else if (v1) { major = (v1 >> 16) & 0xFFFF; minor = (v1 >> 8) & 0xFF; }
  else return 'legacy';
  return major > 1 || (major === 1 && minor >= 5) ? 'protobuf' : 'legacy';
}
