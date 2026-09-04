// Minimal protobuf reader/writer — the same hand-rolled subset MumbleProtocol uses on iOS,
// ported so the browser and the bridge share one implementation with no dependencies.

export class Reader {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  get done() { return this.i >= this.b.length; }

  varint() {
    let result = 0n, shift = 0n;
    while (this.i < this.b.length) {
      const byte = this.b[this.i++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }

  /// Calls fn({ number, wire, ... }) for each field in the message.
  forEachField(fn) {
    while (!this.done) {
      const key = Number(this.varint());
      const number = key >>> 3, wire = key & 7;
      let value = null, payload = null;
      if (wire === 0) value = this.varint();
      else if (wire === 2) {
        const len = Number(this.varint());
        payload = this.b.subarray(this.i, this.i + len);
        this.i += len;
      } else if (wire === 5) { payload = this.b.subarray(this.i, this.i + 4); this.i += 4; }
      else if (wire === 1) { payload = this.b.subarray(this.i, this.i + 8); this.i += 8; }
      else break;
      fn({
        number, wire, payload,
        uint: value === null ? 0 : Number(value),
        bool: value === null ? false : value !== 0n,
        string: payload ? new TextDecoder().decode(payload) : undefined,
      });
    }
  }
}

export class Writer {
  constructor() { this.parts = []; }
  _varint(n) {
    let v = BigInt(n), out = [];
    do { let byte = Number(v & 0x7fn); v >>= 7n; if (v > 0n) byte |= 0x80; out.push(byte); } while (v > 0n);
    this.parts.push(Uint8Array.from(out));
  }
  _key(field, wire) { this._varint((field << 3) | wire); }

  uint(field, value) { if (value === undefined || value === null) return this; this._key(field, 0); this._varint(value); return this; }
  bool(field, value) { if (value === undefined || value === null) return this; this._key(field, 0); this._varint(value ? 1 : 0); return this; }
  string(field, value) {
    if (value === undefined || value === null) return this;
    const bytes = new TextEncoder().encode(value);
    this._key(field, 2); this._varint(bytes.length); this.parts.push(bytes);
    return this;
  }
  bytes(field, value) {
    if (!value) return this;
    this._key(field, 2); this._varint(value.length); this.parts.push(value);
    return this;
  }

  finish() {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}
