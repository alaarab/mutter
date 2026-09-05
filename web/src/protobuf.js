const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  get done() {
    return this.offset >= this.bytes.length;
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    while (this.offset < this.bytes.length) {
      const byte = this.bytes[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7n;
    }
    return result;
  }

  take(length) {
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  forEachField(handler) {
    while (!this.done) {
      const key = Number(this.varint());
      const number = key >>> 3;
      const wire = key & 7;
      let value = null;
      let payload = null;
      if (wire === WIRE_VARINT) {
        value = this.varint();
      } else if (wire === WIRE_LENGTH_DELIMITED) {
        payload = this.take(Number(this.varint()));
      } else if (wire === WIRE_FIXED32) {
        payload = this.take(4);
      } else if (wire === WIRE_FIXED64) {
        payload = this.take(8);
      } else {
        break;
      }
      handler({
        number,
        wire,
        payload,
        uint: value === null ? 0 : Number(value),
        bool: value === null ? false : value !== 0n,
        string: payload ? textDecoder.decode(payload) : undefined,
      });
    }
  }
}

export class Writer {
  constructor() {
    this.parts = [];
  }

  uint(field, value) {
    if (value === undefined || value === null) {
      return this;
    }
    this.key(field, WIRE_VARINT);
    this.varint(value);
    return this;
  }

  bool(field, value) {
    if (value === undefined || value === null) {
      return this;
    }
    this.key(field, WIRE_VARINT);
    this.varint(value ? 1 : 0);
    return this;
  }

  string(field, value) {
    if (value === undefined || value === null) {
      return this;
    }
    return this.bytes(field, textEncoder.encode(value));
  }

  bytes(field, value) {
    if (!value) {
      return this;
    }
    this.key(field, WIRE_LENGTH_DELIMITED);
    this.varint(value.length);
    this.parts.push(value);
    return this;
  }

  finish() {
    return concatBytes(this.parts);
  }

  key(field, wire) {
    this.varint((field << 3) | wire);
  }

  varint(value) {
    let remaining = BigInt(value);
    const encoded = [];
    do {
      let byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      if (remaining > 0n) {
        byte |= 0x80;
      }
      encoded.push(byte);
    } while (remaining > 0n);
    this.parts.push(Uint8Array.from(encoded));
  }
}

export function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
