import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { encodeSignal, SignalAssembler, HEADER, FRAGMENT } from '../src/rtcsignal.js';

function fragments(payload, flags = 1) {
  const count = Math.ceil(payload.length / FRAGMENT);
  return Array.from({ length: count }, (_, index) => {
    const bytes = new Uint8Array(HEADER + Math.min(FRAGMENT, payload.length - index * FRAGMENT));
    bytes.set([1, 1, index, count, flags]);
    bytes.set(payload.subarray(index * FRAGMENT, (index + 1) * FRAGMENT), HEADER);
    return bytes;
  });
}

test('oversized packets, invalid flags, and damaged compressed streams are rejected', async () => {
  const assembler = new SignalAssembler();
  const oversized = new Uint8Array(1001);
  oversized.set([1, 1, 0, 1, 0]);
  for (const packet of [oversized, new Uint8Array([1, 1, 0, 1, 2, 123, 125]), new Uint8Array([1, 1, 0, 1, 1, 255])]) {
    assert.equal(await assembler.push(1, packet), null);
  }
  assert.equal(assembler.partial.size, 0);
});

test('fragment count and compression flags cannot change during reassembly', async () => {
  for (const header of [[1, 1, 1, 2, 1], [1, 1, 1, 3, 0]]) {
    const assembler = new SignalAssembler();
    await assembler.push(1, new Uint8Array([1, 1, 0, 2, 0, 123]));
    assert.equal(await assembler.push(1, new Uint8Array([...header, 125])), null);
    assert.equal(assembler.partial.size, 0);
  }
});

test('incomplete message floods have a fixed memory budget', async () => {
  const assembler = new SignalAssembler();
  for (let sender = 0; sender < 1000; sender++) {
    await assembler.push(sender, new Uint8Array([1, 1, 0, 2, 0, 123]));
  }
  assert.equal(assembler.partial.size, 128);
  assert.deepEqual(await assembler.push(0, new Uint8Array([1, 1, 1, 2, 0, 125])), {});
  assert.equal(assembler.partial.size, 127);
});

test('small compressed packets cannot expand beyond four MiB', async () => {
  const payload = Buffer.from(JSON.stringify({ t: 'offer', id: 'large', sdp: 'a'.repeat(4 * 1024 * 1024) }));
  const compressed = deflateRawSync(payload);
  assert.ok(compressed.length < 10_000);
  const assembler = new SignalAssembler();
  for (const packet of fragments(compressed)) assert.equal(await assembler.push(1, packet), null);
  assert.equal(assembler.partial.size, 0);
  await assert.rejects(encodeSignal({ t: 'offer', id: 'large', sdp: 'a'.repeat(4 * 1024 * 1024) }, 1), /too large/);
});
