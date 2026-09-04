// The OCB2 port against Mumble's own test vectors (TestCrypt.cpp), plus the packet-level rules:
// round trip, out-of-order tolerance, loss counting, replay rejection, and resync.
//
//   node web/test/ocb2.test.mjs

import assert from 'node:assert/strict';
import { CryptState } from '../src/ocb2.js';

const hex = s => Uint8Array.from(s.match(/../g).map(h => parseInt(h, 16)));
const toHex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
const keyNonce = hex('000102030405060708090a0b0c0d0e0f');

// 1. Mumble's vectors: key = nonce = 00..0f
{
  const c = new CryptState(); c.setKey(keyNonce, keyNonce, keyNonce);
  let r = c._ocbEncrypt(new Uint8Array(0), keyNonce);
  assert.equal(toHex(r.tag), 'BF3108130773AD5EC70EC69E7875A7B0');
  const plain = Uint8Array.from({ length: 40 }, (_, i) => i);
  r = c._ocbEncrypt(plain, keyNonce);
  assert.equal(toHex(r.ct), 'F75D6BC8B4DC8D66B836A2B08B32A6369F1CD3C5228D79FD6C267F5F6AA7B231C7DFB9D59951AE9C');
  assert.equal(toHex(r.tag), '9DB0CDF880F73E3E10D4EB3217766688');
  const d = c._ocbDecrypt(r.ct, keyNonce);
  assert.deepEqual(Array.from(d.plain), Array.from(plain));
  assert.equal(toHex(d.tag), '9DB0CDF880F73E3E10D4EB3217766688');
  assert.ok(d.ok);
  console.log(' ok  Mumble test vectors (empty message tag, 40-byte message ciphertext + tag)');
}

// 2. client ↔ server round trip: the server decrypts with the client's nonce and vice versa
{
  const key = crypto.getRandomValues(new Uint8Array(16)), cn = crypto.getRandomValues(new Uint8Array(16)), sn = crypto.getRandomValues(new Uint8Array(16));
  const client = new CryptState(), server = new CryptState();
  client.setKey(key, cn, sn); server.setKey(key, sn, cn);
  for (let i = 0; i < 300; i++) {
    const msg = crypto.getRandomValues(new Uint8Array(1 + (i * 37) % 200));
    const pkt = client.encrypt(msg);
    assert.equal(pkt.length, msg.length + 4);
    assert.deepEqual(Array.from(server.decrypt(pkt)), Array.from(msg), `packet ${i}`);
  }
  assert.equal(server.good, 300); assert.equal(server.lost, 0);
  console.log(' ok  300 packets client → server (crossing the 256-packet IV wrap), all good, none lost');
}

// 3. loss, reordering, replay
{
  const key = new Uint8Array(16).fill(7), cn = new Uint8Array(16).fill(1), sn = new Uint8Array(16).fill(2);
  const a = new CryptState(), b = new CryptState();
  a.setKey(key, cn, sn); b.setKey(key, sn, cn);
  const p = Array.from({ length: 6 }, (_, i) => a.encrypt(Uint8Array.from([i, i, i])));
  assert.deepEqual(Array.from(b.decrypt(p[0])), [0, 0, 0]);
  assert.ok(b.decrypt(p[1]));
  assert.deepEqual(Array.from(b.decrypt(p[4])), [4, 4, 4], 'skip ahead over two lost packets');
  assert.equal(b.lost, 2);
  assert.deepEqual(Array.from(b.decrypt(p[3])), [3, 3, 3], 'a late packet still decrypts');
  assert.equal(b.late, 1);
  assert.equal(b.decrypt(p[3]), null, 'the same late packet again is a replay');
  assert.equal(b.decrypt(Uint8Array.from(p[5]).map((v, i) => i === 4 ? v ^ 1 : v)), null, 'a tampered packet fails its tag');
  assert.deepEqual(Array.from(b.decrypt(p[5])), [5, 5, 5]);
  console.log(' ok  loss counted, late packet accepted once, replay and tampering rejected');
}

// 4. resync: a new server nonce resets the decrypt side
{
  const key = new Uint8Array(16).fill(9), cn = new Uint8Array(16).fill(3), sn = new Uint8Array(16).fill(4);
  const a = new CryptState(), b = new CryptState();
  a.setKey(key, cn, sn); b.setKey(key, sn, cn);
  for (let i = 0; i < 40; i++) a.encrypt(Uint8Array.from([i]));        // b never saw these
  assert.ok(b.decrypt(a.encrypt(Uint8Array.from([1]))), 'a forward jump under 128 is accepted');
  assert.equal(b.lost, 40);
  for (let i = 0; i < 200; i++) a.encrypt(Uint8Array.from([i]));       // now the streams are hopelessly apart
  assert.equal(b.decrypt(a.encrypt(Uint8Array.from([1]))), null, 'beyond that the packet is dropped');
  b.setDecryptIV(a.encryptIV);                                          // CryptSetup { client_nonce } from the client
  assert.ok(b.decrypt(a.encrypt(Uint8Array.from([2]))));
  assert.equal(b.resync, 1);
  console.log(' ok  40 lost packets tolerated; a 200-packet gap needs the resync, which recovers the stream');
}

console.log('\nPASS');
