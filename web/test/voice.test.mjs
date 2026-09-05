import assert from 'node:assert/strict';
import {
  encodeAudio,
  encodeServerAudio,
  encodePing,
  decodeVoice,
  decodeClientAudio,
  isPingPacket,
  missingPackets,
  wireFormatFor,
} from '../src/voice.js';

const opus = Uint8Array.from([0xfc, 0xff, 0xfe, 1, 2, 3, 4, 5]);

for (const format of ['legacy', 'protobuf']) {
  const client = encodeAudio({ target: 3, frameNumber: 300, opus, isTerminator: true }, format);
  const parsed = decodeClientAudio(client, format);
  assert.equal(parsed.target, 3);
  assert.equal(parsed.frameNumber, 300n);
  assert.equal(parsed.isTerminator, true);
  assert.deepEqual(Array.from(parsed.opus), Array.from(opus));

  const server = encodeServerAudio({ session: 7, context: 2, frameNumber: 300n, opus, isTerminator: false }, format);
  const received = decodeVoice(server, format);
  assert.equal(received.kind, 'audio');
  assert.equal(received.session, 7);
  assert.equal(received.context, 2);
  assert.equal(received.frameNumber, 300n);
  assert.equal(received.isTerminator, false);
  assert.deepEqual(Array.from(received.opus), Array.from(opus));

  const ping = encodePing(123456789n, format);
  assert.ok(isPingPacket(ping, format));
  assert.ok(!isPingPacket(server, format));
  assert.deepEqual(decodeVoice(ping, format), { kind: 'ping', timestamp: 123456789n });
  console.log(` ok  ${format}: client audio, server audio and ping round-trip`);
}

assert.equal(decodeVoice(new Uint8Array(0), 'legacy'), null);
assert.equal(decodeVoice(Uint8Array.from([0x00, 1, 2]), 'legacy'), null);
assert.equal(decodeClientAudio(Uint8Array.from([0x80, 0x0a]), 'legacy'), null);
assert.equal(decodeVoice(Uint8Array.from([9, 1]), 'protobuf'), null);
console.log(' ok  junk and truncated packets decode to null');

assert.equal(missingPackets(0, 960, 2), 0);
assert.equal(missingPackets(0, 960, 4), 1);
assert.equal(missingPackets(0, 960, 8), 3);
assert.equal(missingPackets(0, 1920, 4), 0);
assert.equal(missingPackets(0, 1920, 8), 1);
assert.equal(missingPackets(0, 2880, 6), 0);
assert.equal(missingPackets(0, 480, 1), 0);
assert.equal(missingPackets(0, 480, 3), 2);
assert.equal(missingPackets(10, 960, 10), 0);
assert.equal(missingPackets(10, 960, 8), 0);
console.log(' ok  missing-packet count follows the sender’s frame size (10, 20, 40 and 60 ms)');

assert.equal(wireFormatFor({ v1: (1 << 16) | (4 << 8) | 255 }), 'legacy');
assert.equal(wireFormatFor({ v2: (1n << 48n) | (5n << 32n) }), 'protobuf');
assert.equal(wireFormatFor({}), 'legacy');
console.log(' ok  wire format follows the server version');

console.log('\nPASS');
