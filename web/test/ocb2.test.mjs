import assert from 'node:assert/strict';
import { CryptState } from '../src/ocb2.js';

const hex = (text) => Uint8Array.from(text.match(/../g).map((pair) => parseInt(pair, 16)));
const toHex = (bytes) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
const keyNonce = hex('000102030405060708090a0b0c0d0e0f');

function makePair(key, clientNonce, serverNonce) {
  const client = new CryptState();
  const server = new CryptState();
  client.setKey(key, clientNonce, serverNonce);
  server.setKey(key, serverNonce, clientNonce);
  return { client, server };
}

{
  const state = new CryptState();
  state.setKey(keyNonce, keyNonce, keyNonce);
  const empty = state.ocbEncrypt(new Uint8Array(0), keyNonce);
  assert.equal(toHex(empty.tag), 'BF3108130773AD5EC70EC69E7875A7B0');

  const plain = Uint8Array.from({ length: 40 }, (_, i) => i);
  const encrypted = state.ocbEncrypt(plain, keyNonce);
  assert.equal(
    toHex(encrypted.ciphertext),
    'F75D6BC8B4DC8D66B836A2B08B32A6369F1CD3C5228D79FD6C267F5F6AA7B231C7DFB9D59951AE9C'
  );
  assert.equal(toHex(encrypted.tag), '9DB0CDF880F73E3E10D4EB3217766688');

  const decrypted = state.ocbDecrypt(encrypted.ciphertext, keyNonce);
  assert.deepEqual(Array.from(decrypted.plain), Array.from(plain));
  assert.equal(toHex(decrypted.tag), '9DB0CDF880F73E3E10D4EB3217766688');
  assert.ok(decrypted.ok);
  console.log(' ok  Mumble test vectors (empty message tag, 40-byte message ciphertext + tag)');
}

{
  const { client, server } = makePair(randomBytes(16), randomBytes(16), randomBytes(16));
  for (let i = 0; i < 300; i++) {
    const message = randomBytes(1 + ((i * 37) % 200));
    const packet = client.encrypt(message);
    assert.equal(packet.length, message.length + 4);
    assert.deepEqual(Array.from(server.decrypt(packet)), Array.from(message), `packet ${i}`);
  }
  assert.equal(server.good, 300);
  assert.equal(server.lost, 0);
  console.log(' ok  300 packets client → server (crossing the 256-packet IV wrap), all good, none lost');
}

{
  const key = new Uint8Array(16).fill(7);
  const { client: sender, server: receiver } = makePair(key, new Uint8Array(16).fill(1), new Uint8Array(16).fill(2));
  const packets = Array.from({ length: 6 }, (_, i) => sender.encrypt(Uint8Array.from([i, i, i])));
  assert.deepEqual(Array.from(receiver.decrypt(packets[0])), [0, 0, 0]);
  assert.ok(receiver.decrypt(packets[1]));
  assert.deepEqual(Array.from(receiver.decrypt(packets[4])), [4, 4, 4], 'skip ahead over two lost packets');
  assert.equal(receiver.lost, 2);
  assert.deepEqual(Array.from(receiver.decrypt(packets[3])), [3, 3, 3], 'a late packet still decrypts');
  assert.equal(receiver.late, 1);
  assert.equal(receiver.decrypt(packets[3]), null, 'the same late packet again is a replay');
  const tampered = Uint8Array.from(packets[5]).map((byte, i) => (i === 4 ? byte ^ 1 : byte));
  assert.equal(receiver.decrypt(tampered), null, 'a tampered packet fails its tag');
  assert.deepEqual(Array.from(receiver.decrypt(packets[5])), [5, 5, 5]);
  console.log(' ok  loss counted, late packet accepted once, replay and tampering rejected');
}

{
  const key = new Uint8Array(16).fill(9);
  const { client: sender, server: receiver } = makePair(key, new Uint8Array(16).fill(3), new Uint8Array(16).fill(4));
  for (let i = 0; i < 40; i++) {
    sender.encrypt(Uint8Array.from([i]));
  }
  assert.ok(receiver.decrypt(sender.encrypt(Uint8Array.from([1]))), 'a forward jump under 128 is accepted');
  assert.equal(receiver.lost, 40);
  for (let i = 0; i < 200; i++) {
    sender.encrypt(Uint8Array.from([i]));
  }
  assert.equal(receiver.decrypt(sender.encrypt(Uint8Array.from([1]))), null, 'beyond that the packet is dropped');
  receiver.setDecryptIV(sender.encryptIV);
  assert.ok(receiver.decrypt(sender.encrypt(Uint8Array.from([2]))));
  assert.equal(receiver.resync, 1);
  console.log(' ok  40 lost packets tolerated; a 200-packet gap needs the resync, which recovers the stream');
}

console.log('\nPASS');
