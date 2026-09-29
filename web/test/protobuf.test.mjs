import assert from 'node:assert/strict';
import { ByteQueue, Reader, Writer, isWellFormedMessage } from '../src/protobuf.js';
import { FrameParser, MessageType, decode, frame } from '../src/mumble.js';

function varintOf(byteCount) {
  const bytes = new Uint8Array(byteCount).fill(0xff);
  bytes[byteCount - 1] = 0x01;
  return bytes;
}

function withKey(fieldNumber, wire, body) {
  const message = new Uint8Array(body.length + 1);
  message[0] = (fieldNumber << 3) | wire;
  message.set(body, 1);
  return message;
}

{
  const message = new Writer().uint(1, 300).string(2, 'hello').uint(3, 2n ** 64n - 1n).finish();
  const fields = new Reader(message).fields();
  assert.deepEqual(fields.map((field) => field.number), [1, 2, 3]);
  assert.equal(fields[0].uint, 300);
  assert.equal(fields[1].string, 'hello');
  assert.equal(fields[2].big, 2n ** 64n - 1n);
  assert.ok(Number.isFinite(fields[2].uint));
  console.log(' ok  round-trips varints, strings and full 64-bit values');
}

{
  assert.equal(isWellFormedMessage(withKey(1, 0, varintOf(10))), true);
  assert.equal(isWellFormedMessage(withKey(1, 0, varintOf(11))), false);
  assert.equal(isWellFormedMessage(withKey(1, 0, new Uint8Array([0x80, 0x80]))), false);
  assert.equal(isWellFormedMessage(withKey(1, 2, new Uint8Array([10, 1, 2]))), false);
  assert.equal(isWellFormedMessage(withKey(1, 5, new Uint8Array([1, 2]))), false);
  assert.equal(isWellFormedMessage(withKey(1, 7, new Uint8Array(0))), false);
  assert.equal(isWellFormedMessage(new Uint8Array([0x00, 0x01])), false);
  let calls = 0;
  const complete = new Reader(new Uint8Array([0x08, 0x01, 0x10])).forEachField(() => calls++);
  assert.equal(complete, false);
  assert.equal(calls, 0, 'a truncated message delivers none of its fields');
  console.log(' ok  overlong varints, truncated fields and bad wire types are malformed');
}

{
  const hostile = withKey(1, 2, varintOf(8 * 1024 * 1024));
  const started = performance.now();
  assert.equal(isWellFormedMessage(hostile), false);
  assert.deepEqual(decode(MessageType.cryptSetup, hostile), {});
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `rejecting an 8 MB varint took ${elapsed.toFixed(0)} ms`);
  console.log(` ok  an 8 MB varint is rejected in ${elapsed.toFixed(1)} ms`);
}

{
  const queue = new ByteQueue();
  queue.push(Uint8Array.from([1, 2]));
  queue.push(Uint8Array.from([3]));
  queue.push(Uint8Array.from([4, 5, 6]));
  assert.deepEqual(Array.from(queue.peek(4)), [1, 2, 3, 4]);
  assert.equal(queue.length, 6);
  queue.skip(1);
  assert.deepEqual(Array.from(queue.take(3)), [2, 3, 4]);
  assert.deepEqual(Array.from(queue.take(2)), [5, 6]);
  assert.equal(queue.length, 0);
  assert.deepEqual(Array.from(queue.take(0)), []);
  console.log(' ok  byte queue peeks, skips and takes across chunk boundaries');
}

{
  const messages = [
    frame(MessageType.ping, new Writer().uint(1, 7).finish()),
    frame(MessageType.textMessage, new Writer().string(5, 'x'.repeat(300)).finish()),
    frame(MessageType.serverSync, new Uint8Array(0)),
  ];
  const stream = new Uint8Array(messages.reduce((sum, message) => sum + message.length, 0));
  let offset = 0;
  for (const message of messages) {
    stream.set(message, offset);
    offset += message.length;
  }
  for (let split = 0; split <= stream.length; split++) {
    const parser = new FrameParser();
    const frames = [...parser.push(stream.subarray(0, split)), ...parser.push(stream.subarray(split))];
    assert.deepEqual(frames.map((parsed) => parsed.type), [MessageType.ping, MessageType.textMessage, MessageType.serverSync]);
    assert.equal(decode(MessageType.textMessage, frames[1].payload).message, 'x'.repeat(300));
    assert.equal(frames[2].payload.length, 0);
  }
  console.log(' ok  frames reassemble at every split point');
}

{
  const payload = new Uint8Array(8 * 1024 * 1024).fill(7);
  const bytes = frame(MessageType.textMessage, payload);
  const parser = new FrameParser();
  const chunkSize = 16 * 1024;
  const started = performance.now();
  let frames = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    frames = frames.concat(parser.push(bytes.subarray(offset, offset + chunkSize)));
  }
  const elapsed = performance.now() - started;
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, payload.length);
  assert.ok(elapsed < 500, `an 8 MB frame in 16 KB chunks took ${elapsed.toFixed(0)} ms`);
  console.log(` ok  an 8 MB frame in 16 KB chunks reassembles in ${elapsed.toFixed(1)} ms`);
}

console.log('\nPASS');
