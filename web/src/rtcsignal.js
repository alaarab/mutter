import { concatBytes } from './protobuf.js';

export const DATA_ID = 'mutter/rtc';
export const VERSION = 1;
export const HEADER = 5;
export const FRAGMENT = 990;
const FLAG_DEFLATE = 1;
const COMPRESS_FROM = 160;
const MAX_FRAGMENTS = 255;

export async function encodeSignal(message, msgId) {
  const raw = new TextEncoder().encode(JSON.stringify(message));
  let payload = raw;
  let flags = 0;
  if (raw.length >= COMPRESS_FROM) {
    const compressed = await deflate(raw);
    if (compressed.length < raw.length) {
      payload = compressed;
      flags |= FLAG_DEFLATE;
    }
  }
  const count = Math.max(1, Math.ceil(payload.length / FRAGMENT));
  if (count > MAX_FRAGMENTS) {
    throw new Error(`signal too large: ${payload.length} bytes`);
  }
  const fragments = [];
  for (let index = 0; index < count; index++) {
    const piece = payload.subarray(index * FRAGMENT, (index + 1) * FRAGMENT);
    const fragment = new Uint8Array(HEADER + piece.length);
    fragment[0] = VERSION;
    fragment[1] = msgId & 0xff;
    fragment[2] = index;
    fragment[3] = count;
    fragment[4] = flags;
    fragment.set(piece, HEADER);
    fragments.push(fragment);
  }
  return fragments;
}

export class SignalAssembler {
  constructor(ttlMs = 10_000) {
    this.partial = new Map();
    this.ttl = ttlMs;
  }

  async push(sender, bytes) {
    if (bytes.length < HEADER || bytes[0] !== VERSION) {
      return null;
    }
    const msgId = bytes[1];
    const index = bytes[2];
    const count = bytes[3];
    const flags = bytes[4];
    if (count < 1 || index >= count) {
      return null;
    }
    this.expireStale();
    const key = `${sender}:${msgId}`;
    let partial = this.partial.get(key);
    if (!partial || partial.count !== count) {
      partial = { count, flags, parts: new Array(count), received: 0, startedAt: Date.now() };
      this.partial.set(key, partial);
    }
    if (!partial.parts[index]) {
      partial.parts[index] = bytes.subarray(HEADER);
      partial.received++;
    }
    if (partial.received < count) {
      return null;
    }
    this.partial.delete(key);
    let payload = concatBytes(partial.parts);
    if (partial.flags & FLAG_DEFLATE) {
      payload = await inflate(payload);
    }
    try {
      return JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return null;
    }
  }

  expireStale() {
    const now = Date.now();
    for (const [key, partial] of this.partial) {
      if (now - partial.startedAt > this.ttl) {
        this.partial.delete(key);
      }
    }
  }
}

async function pipeThrough(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function deflate(bytes) {
  return pipeThrough(bytes, new CompressionStream('deflate-raw'));
}

function inflate(bytes) {
  return pipeThrough(bytes, new DecompressionStream('deflate-raw'));
}
