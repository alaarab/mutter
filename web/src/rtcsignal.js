// Screen-share signaling rides on PluginDataTransmission, which the server caps at 1000 bytes
// of data and a few messages per second. So a signal is JSON, deflated when that helps, and
// split into fragments behind a 5-byte header. The exact layout is in docs/screen-share.md;
// the iOS client mirrors it byte for byte.
//
//   byte 0  version   (1)
//   byte 1  msgId     one logical message from this sender; wraps at 256
//   byte 2  index     fragment number, from 0
//   byte 3  count     fragments in the message, at least 1
//   byte 4  flags     bit 0: payload is deflate-raw (RFC 1951)
//   5..     fragment  ≤ FRAGMENT bytes of the (possibly compressed) UTF-8 JSON

export const DATA_ID = 'mutter/rtc';
export const VERSION = 1;
export const HEADER = 5;
export const FRAGMENT = 990;
const FLAG_DEFLATE = 1;
const COMPRESS_FROM = 160;     // shorter than this, deflate costs more than it saves

export async function encodeSignal(obj, msgId) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  let payload = raw, flags = 0;
  if (raw.length >= COMPRESS_FROM) {
    const z = await deflate(raw);
    if (z.length < raw.length) { payload = z; flags |= FLAG_DEFLATE; }
  }
  const count = Math.max(1, Math.ceil(payload.length / FRAGMENT));
  if (count > 255) throw new Error(`signal too large: ${payload.length} bytes`);
  const out = [];
  for (let i = 0; i < count; i++) {
    const piece = payload.subarray(i * FRAGMENT, (i + 1) * FRAGMENT);
    const f = new Uint8Array(HEADER + piece.length);
    f[0] = VERSION; f[1] = msgId & 0xff; f[2] = i; f[3] = count; f[4] = flags;
    f.set(piece, HEADER);
    out.push(f);
  }
  return out;
}

/// Reassembles fragments per (sender, msgId). Fragments may arrive out of order; a message
/// that isn't complete within `ttlMs` is forgotten.
export class SignalAssembler {
  constructor(ttlMs = 10_000) { this.partial = new Map(); this.ttl = ttlMs; }

  /// Returns the decoded object when `bytes` completes a message, otherwise null.
  async push(sender, bytes) {
    if (bytes.length < HEADER || bytes[0] !== VERSION) return null;
    const msgId = bytes[1], idx = bytes[2], count = bytes[3], flags = bytes[4];
    if (count < 1 || idx >= count) return null;
    const now = Date.now();
    for (const [k, p] of this.partial) if (now - p.at > this.ttl) this.partial.delete(k);
    const key = `${sender}:${msgId}`;
    let p = this.partial.get(key);
    if (!p || p.count !== count) { p = { count, flags, parts: new Array(count), got: 0, at: now }; this.partial.set(key, p); }
    if (!p.parts[idx]) { p.parts[idx] = bytes.subarray(HEADER); p.got++; }
    if (p.got < count) return null;
    this.partial.delete(key);
    let payload = concat(p.parts);
    if (p.flags & FLAG_DEFLATE) payload = await inflate(payload);
    try { return JSON.parse(new TextDecoder().decode(payload)); } catch { return null; }
  }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function pipe(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const deflate = bytes => pipe(bytes, new CompressionStream('deflate-raw'));
const inflate = bytes => pipe(bytes, new DecompressionStream('deflate-raw'));
