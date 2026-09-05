import { Reader, Writer } from './protobuf.js';

const OPUS = 4;
const LEGACY_PING = 1;
const TERMINATOR_BIT = 0x2000n;
const LENGTH_MASK = 0x1fffn;
const TARGET_MASK = 0x1f;
const PROTOBUF_AUDIO = 0;
const PROTOBUF_PING = 1;

function pushBigEndian(out, value, byteCount) {
  for (let shift = BigInt(8 * (byteCount - 1)); shift >= 0n; shift -= 8n) {
    out.push(Number((value >> shift) & 0xffn));
  }
}

function readBigEndian(bytes, offset, byteCount, highBits, signed = false) {
  if (offset + byteCount >= bytes.length) {
    return null;
  }
  let value = BigInt(highBits);
  for (let i = 1; i <= byteCount; i++) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return [signed ? BigInt.asIntN(64, value) : value, offset + byteCount + 1];
}

const MumbleVarint = {
  encode(value, out) {
    const big = BigInt(value);
    if (big < 0n) {
      if (big >= -4n) {
        out.push(0xfc | Number(~big & 0x03n));
        return;
      }
      out.push(0xf8);
      this.encode(~big, out);
      return;
    }
    if (big < 0x80n) {
      out.push(Number(big));
    } else if (big < 0x4000n) {
      out.push(Number(big >> 8n) | 0x80);
      pushBigEndian(out, big, 1);
    } else if (big < 0x200000n) {
      out.push(Number(big >> 16n) | 0xc0);
      pushBigEndian(out, big, 2);
    } else if (big < 0x10000000n) {
      out.push(Number(big >> 24n) | 0xe0);
      pushBigEndian(out, big, 3);
    } else if (big < 0x100000000n) {
      out.push(0xf0);
      pushBigEndian(out, big, 4);
    } else {
      out.push(0xf4);
      pushBigEndian(out, big, 8);
    }
  },

  decode(bytes, offset) {
    if (offset >= bytes.length) {
      return null;
    }
    const first = bytes[offset];
    if ((first & 0x80) === 0) {
      return [BigInt(first & 0x7f), offset + 1];
    }
    if ((first & 0xc0) === 0x80) {
      return readBigEndian(bytes, offset, 1, first & 0x3f);
    }
    if ((first & 0xe0) === 0xc0) {
      return readBigEndian(bytes, offset, 2, first & 0x1f);
    }
    if ((first & 0xf0) === 0xe0) {
      return readBigEndian(bytes, offset, 3, first & 0x0f);
    }
    switch (first & 0xfc) {
      case 0xf0:
        return readBigEndian(bytes, offset, 4, 0);
      case 0xf4:
        return readBigEndian(bytes, offset, 8, 0, true);
      case 0xf8: {
        const inner = this.decode(bytes, offset + 1);
        return inner ? [~inner[0], inner[1]] : null;
      }
      case 0xfc:
        return [~BigInt(first & 0x03), offset + 1];
      default:
        return null;
    }
  },
};

function readVarints(bytes, offset, count) {
  const values = [];
  for (let i = 0; i < count; i++) {
    const decoded = MumbleVarint.decode(bytes, offset);
    if (!decoded) {
      return null;
    }
    values.push(decoded[0]);
    offset = decoded[1];
  }
  return { values, offset };
}

function legacyLengthField(opus, isTerminator) {
  return (BigInt(opus.length) & LENGTH_MASK) | (isTerminator ? TERMINATOR_BIT : 0n);
}

function legacyOpusSlice(bytes, offset, lengthField) {
  const length = Number(lengthField & LENGTH_MASK);
  if (offset + length > bytes.length) {
    return null;
  }
  return bytes.subarray(offset, offset + length);
}

function isTerminatorField(lengthField) {
  return (lengthField & TERMINATOR_BIT) !== 0n;
}

function encodeLegacy(headerByte, varints, opus) {
  const header = [headerByte];
  for (const value of varints) {
    MumbleVarint.encode(value, header);
  }
  const packet = new Uint8Array(header.length + opus.length);
  packet.set(header);
  packet.set(opus, header.length);
  return packet;
}

function withHeader(headerByte, body) {
  const packet = new Uint8Array(body.length + 1);
  packet[0] = headerByte;
  packet.set(body, 1);
  return packet;
}

function protobufAudio(writer, frameNumber, opus, isTerminator) {
  writer.uint(4, frameNumber).bytes(5, opus);
  if (isTerminator) {
    writer.bool(16, true);
  }
  return withHeader(PROTOBUF_AUDIO, writer.finish());
}

export function encodeAudio({ target = 0, frameNumber = 0, opus, isTerminator = false }, format) {
  if (format === 'legacy') {
    const headerByte = (OPUS << 5) | (target & TARGET_MASK);
    return encodeLegacy(headerByte, [frameNumber, legacyLengthField(opus, isTerminator)], opus);
  }
  return protobufAudio(new Writer().uint(1, target & TARGET_MASK), frameNumber, opus, isTerminator);
}

export function encodeServerAudio({ session, context = 0, frameNumber = 0, opus, isTerminator = false }, format) {
  if (format === 'legacy') {
    const headerByte = (OPUS << 5) | (context & TARGET_MASK);
    return encodeLegacy(headerByte, [session, frameNumber, legacyLengthField(opus, isTerminator)], opus);
  }
  return protobufAudio(new Writer().uint(2, context).uint(3, session), frameNumber, opus, isTerminator);
}

export function encodePing(timestampMicros, format) {
  if (format === 'legacy') {
    return encodeLegacy(LEGACY_PING << 5, [timestampMicros], new Uint8Array(0));
  }
  return withHeader(PROTOBUF_PING, new Writer().uint(1, timestampMicros).finish());
}

export function isPingPacket(bytes, format) {
  if (!bytes.length) {
    return false;
  }
  return format === 'legacy' ? bytes[0] >> 5 === LEGACY_PING : bytes[0] === PROTOBUF_PING;
}

function decodeLegacyServerAudio(bytes) {
  const header = readVarints(bytes, 1, 3);
  if (!header) {
    return null;
  }
  const [session, frameNumber, lengthField] = header.values;
  const opus = legacyOpusSlice(bytes, header.offset, lengthField);
  if (!opus) {
    return null;
  }
  return {
    kind: 'audio',
    session: Number(session),
    frameNumber,
    context: bytes[0] & TARGET_MASK,
    isTerminator: isTerminatorField(lengthField),
    opus,
  };
}

function decodeLegacyClientAudio(bytes) {
  const header = readVarints(bytes, 1, 2);
  if (!header) {
    return null;
  }
  const [frameNumber, lengthField] = header.values;
  const opus = legacyOpusSlice(bytes, header.offset, lengthField);
  if (!opus) {
    return null;
  }
  return { target: bytes[0] & TARGET_MASK, frameNumber, isTerminator: isTerminatorField(lengthField), opus };
}

function decodeProtobufAudio(body) {
  const packet = {
    kind: 'audio',
    target: 0,
    context: 0,
    session: 0,
    frameNumber: 0n,
    opus: new Uint8Array(0),
    isTerminator: false,
    volume: 0,
  };
  new Reader(body).forEachField((field) => {
    switch (field.number) {
      case 1:
        packet.target = field.uint;
        break;
      case 2:
        packet.context = field.uint;
        break;
      case 3:
        packet.session = field.uint;
        break;
      case 4:
        packet.frameNumber = BigInt(field.uint);
        break;
      case 5:
        packet.opus = field.payload;
        break;
      case 7:
        if (field.payload?.length === 4) {
          packet.volume = new DataView(field.payload.buffer, field.payload.byteOffset).getFloat32(0, true);
        }
        break;
      case 16:
        packet.isTerminator = field.bool;
        break;
      default:
        break;
    }
  });
  return packet;
}

function decodeProtobufPing(body) {
  const packet = { kind: 'ping', timestamp: 0n };
  new Reader(body).forEachField((field) => {
    if (field.number === 1) {
      packet.timestamp = BigInt(field.uint);
    }
  });
  return packet;
}

export function decodeVoice(bytes, format) {
  if (!bytes.length) {
    return null;
  }
  if (format === 'legacy') {
    if (isPingPacket(bytes, format)) {
      const timestamp = MumbleVarint.decode(bytes, 1);
      return timestamp ? { kind: 'ping', timestamp: timestamp[0] } : null;
    }
    return bytes[0] >> 5 === OPUS ? decodeLegacyServerAudio(bytes) : null;
  }
  const body = bytes.subarray(1);
  if (bytes[0] === PROTOBUF_AUDIO) {
    return decodeProtobufAudio(body);
  }
  if (bytes[0] === PROTOBUF_PING) {
    return decodeProtobufPing(body);
  }
  return null;
}

export function decodeClientAudio(bytes, format) {
  if (!bytes.length) {
    return null;
  }
  if (format === 'legacy') {
    return bytes[0] >> 5 === OPUS ? decodeLegacyClientAudio(bytes) : null;
  }
  return bytes[0] === PROTOBUF_AUDIO ? decodeProtobufAudio(bytes.subarray(1)) : null;
}

export const SAMPLES_PER_SEQUENCE_UNIT = 480;

export function missingPackets(previousSequence, previousSamples, sequence) {
  const unitsPerPacket = Math.max(1, Math.round(previousSamples / SAMPLES_PER_SEQUENCE_UNIT));
  return Math.max(0, Math.round((sequence - previousSequence) / unitsPerPacket) - 1);
}

export function wireFormatFor({ v1, v2 }) {
  let major;
  let minor;
  if (v2) {
    const big = BigInt(v2);
    major = Number((big >> 48n) & 0xffffn);
    minor = Number((big >> 32n) & 0xffffn);
  } else if (v1) {
    major = (v1 >> 16) & 0xffff;
    minor = (v1 >> 8) & 0xff;
  } else {
    return 'legacy';
  }
  const isModern = major > 1 || (major === 1 && minor >= 5);
  return isModern ? 'protobuf' : 'legacy';
}
