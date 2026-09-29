export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LENGTH_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

const MAX_VARINT_BYTES = 10;
const MAX_FIELD_KEY = 0xffffffff;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export class MalformedMessageError extends Error {}

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
    for (let index = 0; index < MAX_VARINT_BYTES; index++) {
      if (this.done) {
        throw new MalformedMessageError('truncated varint');
      }
      const byte = this.bytes[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return BigInt.asUintN(64, result);
      }
      shift += 7n;
    }
    throw new MalformedMessageError('varint longer than 10 bytes');
  }

  take(length) {
    if (length > this.bytes.length - this.offset) {
      throw new MalformedMessageError('field runs past the end of the message');
    }
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  field() {
    const key = this.varint();
    if (key > BigInt(MAX_FIELD_KEY)) {
      throw new MalformedMessageError('field key out of range');
    }
    const number = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (number === 0) {
      throw new MalformedMessageError('field number zero');
    }
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
      throw new MalformedMessageError(`unsupported wire type ${wire}`);
    }
    return {
      number,
      wire,
      payload,
      big: value ?? 0n,
      uint: value === null ? 0 : Number(value),
      bool: value === null ? false : value !== 0n,
      get string() {
        return payload ? textDecoder.decode(payload) : undefined;
      },
    };
  }

  fields() {
    const fields = [];
    while (!this.done) {
      fields.push(this.field());
    }
    return fields;
  }

  forEachField(handler) {
    let fields;
    try {
      fields = this.fields();
    } catch (error) {
      if (error instanceof MalformedMessageError) {
        return false;
      }
      throw error;
    }
    for (const field of fields) {
      handler(field);
    }
    return true;
  }
}

export function isWellFormedMessage(bytes) {
  try {
    new Reader(bytes).fields();
    return true;
  } catch (error) {
    if (error instanceof MalformedMessageError) {
      return false;
    }
    throw error;
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

export class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
  }

  peek(count) {
    if (count === 0) {
      return new Uint8Array(0);
    }
    const first = this.chunks[0];
    if (first.length >= count) {
      return first.subarray(0, count);
    }
    const out = new Uint8Array(count);
    let filled = 0;
    for (const chunk of this.chunks) {
      const used = Math.min(chunk.length, count - filled);
      out.set(chunk.subarray(0, used), filled);
      filled += used;
      if (filled === count) {
        break;
      }
    }
    return out;
  }

  take(count) {
    const out = this.peek(count);
    this.skip(count);
    return out;
  }

  skip(count) {
    let remaining = count;
    while (remaining > 0) {
      const first = this.chunks[0];
      const used = Math.min(first.length, remaining);
      if (used === first.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = first.subarray(used);
      }
      this.length -= used;
      remaining -= used;
    }
  }
}
