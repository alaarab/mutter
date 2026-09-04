// The 'mutter/rtc' fragment codec, in Node: sizes, compression, out-of-order reassembly,
// interleaved senders, and rejection of junk.
//
//   node web/test/signal.test.mjs

import assert from 'node:assert/strict';
import { encodeSignal, SignalAssembler, HEADER, FRAGMENT, VERSION } from '../src/rtcsignal.js';

const sdp = Array.from({ length: 60 }, (_, i) => `a=candidate:${i} 1 udp ${2122260223 - i} 192.168.1.${i % 250} ${50000 + i} typ host generation 0 ufrag abcd network-id 1`).join('\r\n');
const offer = { t: 'offer', id: 'abc12345', sdp: `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n${sdp}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\n` };

// 1. small message: one fragment, not compressed
{
  const frags = await encodeSignal({ t: 'watch', id: 'abc12345' }, 7);
  assert.equal(frags.length, 1);
  assert.deepEqual([...frags[0].subarray(0, HEADER)], [VERSION, 7, 0, 1, 0]);
  const a = new SignalAssembler();
  assert.deepEqual(await a.push(1, frags[0]), { t: 'watch', id: 'abc12345' });
  console.log(' ok  small message: 1 fragment, no compression');
}

// 2. big SDP: compressed, several fragments, every one ≤ 1000 bytes
{
  const raw = new TextEncoder().encode(JSON.stringify(offer)).length;
  const frags = await encodeSignal(offer, 200);
  const total = frags.reduce((n, f) => n + f.length - HEADER, 0);
  assert.ok(frags.every(f => f.length <= 1000), 'fragment over the server cap');
  assert.ok(frags.every(f => f[4] & 1), 'expected the deflate flag');
  assert.ok(total < raw * 0.6, `compression too weak: ${total} of ${raw}`);
  const a = new SignalAssembler();
  let out = null;
  for (const f of frags.slice().reverse()) out = (await a.push(5, f)) ?? out;    // reversed order
  assert.deepEqual(out, offer);
  console.log(` ok  ${raw}-byte offer → ${frags.length} fragments (${total} bytes), reassembled out of order`);
}

// 3. two senders interleaved with the same msgId don't collide; a duplicated fragment is harmless
{
  const a = new SignalAssembler();
  const noise = () => Array.from({ length: 80 }, () => crypto.randomUUID()).join('');   // 2.9 KB of hex, ~2:1 at best
  const x = await encodeSignal({ t: 'announce', id: 'x', title: noise() }, 3);
  const y = await encodeSignal({ t: 'announce', id: 'y', title: noise() }, 3);
  assert.ok(x.length >= 2 && y.length >= 2, 'need multi-fragment messages for this case');
  const got = [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i]) got.push(await a.push(1, x[i]));
    if (y[i]) got.push(await a.push(2, y[i]));
    if (x[i] && i < x.length - 1) got.push(await a.push(1, x[i]));   // duplicate of a middle fragment
  }
  const done = got.filter(Boolean);
  assert.equal(done.length, 2);
  assert.deepEqual(done.map(m => m.id).sort(), ['x', 'y']);
  console.log(` ok  interleaved senders (${x.length} + ${y.length} fragments) reassemble separately`);
}

// 4. junk: wrong version, index ≥ count, short buffer → null, no throw
{
  const a = new SignalAssembler();
  assert.equal(await a.push(1, Uint8Array.from([2, 0, 0, 1, 0, 123])), null);
  assert.equal(await a.push(1, Uint8Array.from([1, 0, 1, 1, 0, 123])), null);
  assert.equal(await a.push(1, Uint8Array.from([1, 0])), null);
  assert.equal(await a.push(1, Uint8Array.from([1, 0, 0, 1, 0, 0x7b, 0x7d, 0x7d])), null);   // bad JSON
  console.log(' ok  junk is ignored');
}

// 5. stale partials expire
{
  const a = new SignalAssembler(10);
  const frags = await encodeSignal(offer, 9);
  await a.push(1, frags[0]);
  await new Promise(r => setTimeout(r, 30));
  await a.push(1, Uint8Array.from([1, 99, 0, 1, 0, 0x7b, 0x7d]));    // any push sweeps
  assert.equal(a.partial.size, 0);
  console.log(' ok  incomplete messages expire');
}

console.log(`\nPASS (fragment payload ${FRAGMENT} + header ${HEADER} ≤ 1000)`);
