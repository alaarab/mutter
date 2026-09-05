import assert from 'node:assert/strict';
import { encodeSignal, SignalAssembler, HEADER, FRAGMENT, VERSION } from '../src/rtcsignal.js';

const candidates = Array.from(
  { length: 60 },
  (_, i) =>
    `a=candidate:${i} 1 udp ${2122260223 - i} 192.168.1.${i % 250} ${50000 + i} typ host generation 0 ufrag abcd network-id 1`
).join('\r\n');
const offer = {
  t: 'offer',
  id: 'abc12345',
  sdp: `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n${candidates}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 97 98\r\n`,
};

{
  const fragments = await encodeSignal({ t: 'watch', id: 'abc12345' }, 7);
  assert.equal(fragments.length, 1);
  assert.deepEqual([...fragments[0].subarray(0, HEADER)], [VERSION, 7, 0, 1, 0]);
  const assembler = new SignalAssembler();
  assert.deepEqual(await assembler.push(1, fragments[0]), { t: 'watch', id: 'abc12345' });
  console.log(' ok  small message: 1 fragment, no compression');
}

{
  const rawLength = new TextEncoder().encode(JSON.stringify(offer)).length;
  const fragments = await encodeSignal(offer, 200);
  const total = fragments.reduce((sum, fragment) => sum + fragment.length - HEADER, 0);
  assert.ok(
    fragments.every((fragment) => fragment.length <= 1000),
    'fragment over the server cap'
  );
  assert.ok(
    fragments.every((fragment) => fragment[4] & 1),
    'expected the deflate flag'
  );
  assert.ok(total < rawLength * 0.6, `compression too weak: ${total} of ${rawLength}`);
  const assembler = new SignalAssembler();
  let result = null;
  for (const fragment of fragments.slice().reverse()) {
    result = (await assembler.push(5, fragment)) ?? result;
  }
  assert.deepEqual(result, offer);
  console.log(` ok  ${rawLength}-byte offer → ${fragments.length} fragments (${total} bytes), reassembled out of order`);
}

{
  const assembler = new SignalAssembler();
  const noise = () => Array.from({ length: 80 }, () => crypto.randomUUID()).join('');
  const first = await encodeSignal({ t: 'announce', id: 'x', title: noise() }, 3);
  const second = await encodeSignal({ t: 'announce', id: 'y', title: noise() }, 3);
  assert.ok(first.length >= 2 && second.length >= 2, 'need multi-fragment messages for this case');
  const results = [];
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    if (first[i]) {
      results.push(await assembler.push(1, first[i]));
    }
    if (second[i]) {
      results.push(await assembler.push(2, second[i]));
    }
    if (first[i] && i < first.length - 1) {
      results.push(await assembler.push(1, first[i]));
    }
  }
  const completed = results.filter(Boolean);
  assert.equal(completed.length, 2);
  assert.deepEqual(completed.map((message) => message.id).sort(), ['x', 'y']);
  console.log(` ok  interleaved senders (${first.length} + ${second.length} fragments) reassemble separately`);
}

{
  const assembler = new SignalAssembler();
  assert.equal(await assembler.push(1, Uint8Array.from([2, 0, 0, 1, 0, 123])), null);
  assert.equal(await assembler.push(1, Uint8Array.from([1, 0, 1, 1, 0, 123])), null);
  assert.equal(await assembler.push(1, Uint8Array.from([1, 0])), null);
  assert.equal(await assembler.push(1, Uint8Array.from([1, 0, 0, 1, 0, 0x7b, 0x7d, 0x7d])), null);
  console.log(' ok  junk is ignored');
}

{
  const assembler = new SignalAssembler(10);
  const fragments = await encodeSignal(offer, 9);
  await assembler.push(1, fragments[0]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assembler.push(1, Uint8Array.from([1, 99, 0, 1, 0, 0x7b, 0x7d]));
  assert.equal(assembler.partial.size, 0);
  console.log(' ok  incomplete messages expire');
}

console.log(`\nPASS (fragment payload ${FRAGMENT} + header ${HEADER} ≤ 1000)`);
