import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeServer } from './fake-server.mjs';
import { authenticateMessage, versionMessage, CLIENT_VERSION } from '../src/mumble.js';

process.env.PORT = '0';
process.env.NO_OPEN = '1';
const { server, ready } = await import('../bridge/server.mjs');
const url = await ready;
const fake = await startFakeServer({ port: 0, quiet: true });
const { token } = await (await fetch(`${url}/bridge-token`)).json();
const target = { host: '127.0.0.1', port: fake.port };
after(async () => {
  await fake.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

function upgrade({ origin = url, auth = token, host = new URL(url).host, requestPath } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${url}${requestPath ?? `/bridge?token=${auth}`}`, {
      headers: {
        Host: host, Origin: origin, Upgrade: 'websocket', Connection: 'Upgrade',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13',
      },
    });
    request.on('upgrade', (response, socket) => resolve({ status: response.statusCode, socket }));
    request.on('response', response => { response.resume(); resolve({ status: response.statusCode }); });
    request.on('error', reject);
    request.end();
  });
}

async function connect(t) {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/bridge?token=${token}`);
  const messages = [];
  socket.addEventListener('message', event => {
    messages.push(typeof event.data === 'string' ? JSON.parse(event.data) : { event: 'binary' });
  });
  await once(socket, 'open');
  t.after(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = once(socket, 'close');
    socket.close();
    await closed;
  });
  return {
    socket, messages,
    send: data => socket.send(typeof data === 'string' || data instanceof Uint8Array ? data : JSON.stringify(data)),
    async next(event) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(message => message.event === event);
        if (index !== -1) return messages.splice(index, 1)[0];
        await sleep(10);
      }
      assert.fail(`Expected bridge event ${event}; got ${JSON.stringify(messages)}`);
    },
  };
}

test('bridge is loopback-only and rejects foreign hosts, origins, and missing tokens', async () => {
  assert.equal(server.address().address, '127.0.0.1');
  for (const request of [{ origin: 'https://untrusted.example' }, { origin: 'null' }, { host: 'attacker.example' }, { auth: '' }, { auth: 'wrong' }]) {
    assert.equal((await upgrade(request)).status, 403);
  }
  assert.equal((await fetch(`${url}/bridge-token`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const status = await new Promise(resolve => {
    http.get(url, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
  });
  assert.equal(status, 403);
  const allowed = await upgrade();
  assert.equal(allowed.status, 101);
  allowed.socket.destroy();
});

test('bad JSON, null, and invalid target types close only their connection', async t => {
  for (const value of ['{', 'null', '[]', 'true', '{}', { host: {} }, { host: 1 }, { host: '127.0.0.1', port: -1 }, { host: '127.0.0.1', port: 65536 }, { host: '127.0.0.1', port: '64738' }, { ...target, fingerprint: 'invalid' }]) {
    const peer = await connect(t);
    peer.send(value);
    assert.ok((await peer.next('error')).message);
    assert.equal((await fetch(url)).status, 200);
  }
});

test('unmasked and oversized WebSocket frames are rejected without allocating their advertised size', async () => {
  for (const bytes of [Buffer.from([0x81, 1, 0x61]), Buffer.from([0x82, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])]) {
    const { socket } = await upgrade();
    socket.resume();
    const closed = once(socket, 'close');
    socket.write(bytes);
    await closed;
    assert.equal((await fetch(url)).status, 200);
  }
});

test('a self-signed certificate requires approval before the Mumble handshake', async t => {
  const peer = await connect(t);
  peer.send(target);
  const certificate = await peer.next('certificate');
  assert.equal(certificate.fingerprint, fake.fingerprint);
  assert.equal(certificate.expectedFingerprint, null);
  await sleep(50);
  assert.deepEqual(peer.messages, []);
  assert.equal(fake.users.size, 0);
  peer.send({ event: 'trust', fingerprint: certificate.fingerprint });
  assert.equal((await peer.next('open')).fingerprint, fake.fingerprint);
  peer.send(versionMessage(CLIENT_VERSION));
  peer.send(authenticateMessage({ username: 'Approved' }));
  await peer.next('binary');
  assert.equal(fake.users.size, 1);
});

test('sending credentials before certificate approval is refused', async t => {
  const peer = await connect(t);
  peer.send(target);
  await peer.next('certificate');
  peer.send(authenticateMessage({ username: 'MustNotAuthenticate', password: 'must-not-leak' }));
  await peer.next('error');
  assert.equal([...fake.users.values()].some(user => user.name === 'MustNotAuthenticate'), false);
});

test('a matching pin reconnects without prompting, while a changed pin needs explicit approval', async t => {
  const pinned = await connect(t);
  pinned.send({ ...target, fingerprint: fake.fingerprint });
  await pinned.next('open');
  assert.equal(pinned.messages.some(message => message.event === 'certificate'), false);
  const changed = await connect(t);
  changed.send({ ...target, fingerprint: '0'.repeat(64) });
  const certificate = await changed.next('certificate');
  assert.equal(certificate.expectedFingerprint, '0'.repeat(64));
  assert.equal(certificate.fingerprint, fake.fingerprint);
  changed.send({ event: 'trust', fingerprint: '0'.repeat(64) });
  await changed.next('error');
  assert.equal(changed.messages.some(message => message.event === 'open'), false);
});
