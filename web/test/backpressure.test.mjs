import assert from 'node:assert/strict';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { BoundedWriter } from '../bridge/bounded-writer.mjs';

test('a slow reader pauses its source, then drains every byte in order', async () => {
  const socket = new PassThrough({ highWaterMark: 16 });
  const changes = [];
  const writer = new BoundedWriter(socket, {
    pause: () => changes.push('pause'), resume: () => changes.push('resume'),
    overflow: () => assert.fail('unexpected overflow'), limit: 128,
  });
  const first = Buffer.alloc(32, 1), second = Buffer.alloc(32, 2);
  assert.equal(writer.write(first), false);
  assert.equal(writer.write(second), false);
  assert.deepEqual(changes, ['pause']);
  const drained = once(socket, 'drain');
  const received = [];
  socket.on('data', bytes => received.push(bytes));
  await drained;
  assert.deepEqual(Buffer.concat(received), Buffer.concat([first, second]));
  assert.deepEqual(changes, ['pause', 'resume']);
  assert.equal(writer.blocked, false);
  writer.dispose();
  socket.destroy();
});

test('writes that ignore flow control are bounded and rejected before allocation in the socket', () => {
  const socket = new Writable({ highWaterMark: 16, write(_data, _encoding, _done) {} });
  let overflows = 0;
  const writer = new BoundedWriter(socket, {
    pause() {}, resume: () => assert.fail('stalled writer resumed'),
    overflow: () => overflows++, limit: 64,
  });
  writer.write(Buffer.alloc(32));
  writer.write(Buffer.alloc(32));
  assert.equal(socket.writableLength, 64);
  assert.equal(writer.write(Buffer.alloc(1)), false);
  assert.equal(socket.writableLength, 64);
  assert.equal(overflows, 1);
  writer.write(Buffer.alloc(1));
  assert.equal(overflows, 1);
  assert.equal(socket.listenerCount('drain'), 0);
  socket.destroy();
});

test('closing a blocked writer removes its drain callback and rejects late writes', () => {
  const socket = new PassThrough({ highWaterMark: 16 });
  const writer = new BoundedWriter(socket, {
    pause() {}, resume: () => assert.fail('closed source resumed'), overflow: () => assert.fail('overflow'),
  });
  writer.write(Buffer.alloc(32));
  writer.dispose();
  socket.emit('drain');
  assert.equal(writer.write(Buffer.alloc(1)), false);
  assert.equal(socket.listenerCount('drain'), 0);
  socket.destroy();
});
