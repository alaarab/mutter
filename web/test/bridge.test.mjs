import assert from 'node:assert/strict';
import crypto, { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeServer } from './fake-server.mjs';
import { FrameParser, MessageType, authenticateMessage, frame, pingMessage, versionMessage, CLIENT_VERSION } from '../src/mumble.js';
import { Writer } from '../src/protobuf.js';
import { CryptState } from '../src/ocb2.js';
import { decodeVoice, encodePing } from '../src/voice.js';

process.env.PORT = '0';
process.env.NO_OPEN = '1';
const { server, listeners, ready } = await import('../bridge/server.mjs');
const url = await ready;
const fake = await startFakeServer({ port: 0, quiet: true });
const { token } = await (await fetch(`${url}/bridge-token`)).json();
const target = { host: '127.0.0.1', port: fake.port };
const bridgeScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'server.mjs');
const hostileIdentity = createIdentity();
after(async () => {
  await fake.close();
  for (const listener of listeners) {
    listener.closeAllConnections();
    if (listener.listening) await new Promise(resolve => listener.close(resolve));
  }
  fs.rmSync(hostileIdentity.directory, { recursive: true, force: true });
});

function createIdentity() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-hostile-'));
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=Hostile Mumble'], { stdio: 'ignore' });
  const cert = fs.readFileSync(certFile);
  return {
    directory,
    key: fs.readFileSync(keyFile),
    cert,
    fingerprint: crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('hex'),
  };
}

function overlongVarint(byteCount) {
  const bytes = new Uint8Array(byteCount).fill(0xff);
  bytes[byteCount - 1] = 0x01;
  return bytes;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function startHostileServer(t, { onDatagram = () => {}, onControl = () => {} } = {}) {
  const key = randomBytes(16);
  const clientNonce = randomBytes(16);
  const serverNonce = randomBytes(16);
  const crypt = new CryptState();
  crypt.setKey(key, serverNonce, clientNonce);
  const sockets = new Set();
  const hostile = {
    crypt,
    control: null,
    bridgeAddress: null,
    resyncRequests: 0,
    sendDatagram(bytes, from = hostile.udp) {
      from.send(bytes, hostile.bridgeAddress.port, hostile.bridgeAddress.address);
    },
    sendPong(from) {
      hostile.sendDatagram(crypt.encrypt(encodePing(BigInt(Date.now()) * 1000n, 'protobuf')), from);
    },
  };
  hostile.tcp = tls.createServer({ key: hostileIdentity.key, cert: hostileIdentity.cert }, socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    hostile.control = socket;
    const parser = new FrameParser();
    socket.on('data', chunk => {
      for (const { type, payload } of parser.push(new Uint8Array(chunk))) {
        if (type === MessageType.cryptSetup && payload.length === 0) {
          hostile.resyncRequests++;
        }
        onControl(type, payload);
      }
    });
    onControl('connected');
  });
  hostile.tcp.listen(0, '127.0.0.1');
  await once(hostile.tcp, 'listening');
  hostile.port = hostile.tcp.address().port;
  hostile.udp = dgram.createSocket('udp4');
  hostile.udp.bind(hostile.port, '127.0.0.1');
  await once(hostile.udp, 'listening');
  hostile.udp.on('message', (datagram, remote) => {
    hostile.bridgeAddress = remote;
    const plain = crypt.decrypt(new Uint8Array(datagram));
    if (plain) onDatagram(decodeVoice(plain, 'protobuf'));
  });
  hostile.sendCryptSetup = () => {
    hostile.control.write(frame(MessageType.cryptSetup, new Writer().bytes(1, key).bytes(2, clientNonce).bytes(3, serverNonce).finish()));
  };
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    hostile.udp.close();
    await new Promise(resolve => hostile.tcp.close(resolve));
  });
  return hostile;
}

async function until(condition, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

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
  socket.binaryType = 'arraybuffer';
  const messages = [];
  socket.addEventListener('message', event => {
    if (typeof event.data === 'string') {
      messages.push(JSON.parse(event.data));
      return;
    }
    const bytes = new Uint8Array(event.data);
    messages.push({ event: 'binary', type: (bytes[0] << 8) | bytes[1], bytes });
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
  for (const listener of listeners) {
    if (listener.listening) {
      assert.ok(['127.0.0.1', '::1'].includes(listener.address().address));
      assert.equal(listener.address().port, server.address().port);
    }
  }
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

test('the bridge also owns its port on [::1], so no other process can serve its origin there', async t => {
  const ipv6 = listeners.find(listener => listener !== server);
  if (!ipv6.listening) {
    t.skip('IPv6 loopback is unavailable on this machine');
    return;
  }
  assert.equal(ipv6.address().address, '::1');
  const squatter = net.createServer();
  const failure = once(squatter, 'error');
  squatter.listen(server.address().port, '::1');
  assert.equal((await failure)[0].code, 'EADDRINUSE');
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '::1', port: server.address().port, path: '/bridge-token', headers: { Host: new URL(url).host } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 200);
});

test('a fixed port already taken on [::1] stops the bridge from starting', async t => {
  const squatter = net.createServer();
  try {
    squatter.listen(0, '::1');
    await once(squatter, 'listening');
  } catch {
    t.skip('IPv6 loopback is unavailable on this machine');
    return;
  }
  t.after(() => squatter.close());
  const child = spawn(process.execPath, [bridgeScript], {
    env: { ...process.env, PORT: String(squatter.address().port), NO_OPEN: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 5000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  assert.notEqual(code, 0);
  assert.match(stderr, /EADDRINUSE/);
});

test('a request path containing a null byte is refused without taking the bridge down', async () => {
  assert.equal((await fetch(`${url}/%00`)).status, 400);
  assert.equal((await fetch(`${url}/app/%00.js`)).status, 400);
  assert.equal((await fetch(url)).status, 200);
});

test('a client that resets a refused WebSocket upgrade does not take the bridge down', async () => {
  const { port } = server.address();
  for (let attempt = 0; attempt < 30; attempt++) {
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.on('error', () => {});
    socket.write(`GET /bridge?token=wrong HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    socket.resetAndDestroy();
  }
  await sleep(200);
  assert.equal((await fetch(url)).status, 200);
});

test('a WebSocket frame split across many reads is reassembled', async () => {
  const { socket } = await upgrade();
  socket.setNoDelay(true);
  const replies = [];
  socket.on('data', chunk => replies.push(chunk));
  const payload = randomBytes(70_000);
  const mask = randomBytes(4);
  const lengthHeader = Buffer.alloc(10);
  lengthHeader[0] = 0x82;
  lengthHeader[1] = 0xff;
  lengthHeader.writeBigUInt64BE(BigInt(payload.length), 2);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index & 3]));
  const pieces = [...lengthHeader].map(byte => Buffer.from([byte]));
  pieces.push(...[...mask].map(byte => Buffer.from([byte])));
  for (let offset = 0; offset < masked.length; offset += 20_000) {
    pieces.push(masked.subarray(offset, offset + 20_000));
  }
  for (const piece of pieces) {
    socket.write(piece);
    await sleep(5);
  }
  await until(() => Buffer.concat(replies).includes('certificate has not been accepted'), 'the bridge to answer the reassembled frame');
  socket.destroy();
});

test('a malformed server message is dropped without stalling the bridge', async t => {
  const hostile = await startHostileServer(t, {
    onControl(type) {
      if (type !== 'connected') return;
      const hostileSetup = concat(Uint8Array.from([0x08]), overlongVarint(128 * 1024));
      hostile.control.write(frame(MessageType.cryptSetup, hostileSetup));
      hostile.control.write(frame(MessageType.version, concat(Uint8Array.from([0x0a]), overlongVarint(64)).subarray(0, 40)));
      hostile.control.write(pingMessage(42n));
    },
  });
  const peer = await connect(t);
  peer.send({ host: '127.0.0.1', port: hostile.port, fingerprint: hostileIdentity.fingerprint });
  await peer.next('open');
  const started = Date.now();
  const forwarded = await peer.next('binary');
  assert.ok(Date.now() - started < 1000, `the bridge took ${Date.now() - started} ms to forward the next message`);
  assert.equal(forwarded.type, MessageType.ping);
  await sleep(100);
  assert.equal(peer.messages.filter(message => message.event === 'binary').length, 0);
  assert.equal((await fetch(url)).status, 200);
});

test('hostile UDP replies cannot crash the bridge, and only the server address is heard', async t => {
  const pings = [];
  const hostile = await startHostileServer(t, {
    onControl(type) {
      if (type === 'connected') hostile.sendCryptSetup();
    },
    onDatagram(packet) {
      if (packet?.kind === 'ping') pings.push(packet);
    },
  });
  const impostor = dgram.createSocket('udp4');
  impostor.bind(0, '127.0.0.1');
  await once(impostor, 'listening');
  t.after(() => impostor.close());
  const peer = await connect(t);
  peer.send({ host: '127.0.0.1', port: hostile.port, fingerprint: hostileIdentity.fingerprint });
  await peer.next('open');
  await until(() => pings.length > 0, 'the bridge to ping over UDP');

  hostile.sendPong(impostor);
  await sleep(300);
  assert.equal(peer.messages.some(message => message.event === 'udp'), false, 'a pong from another address was accepted');

  const hostilePong = concat(Uint8Array.from([1, 0x08]), overlongVarint(200));
  hostile.sendDatagram(hostile.crypt.encrypt(hostilePong));
  hostile.sendDatagram(randomBytes(4096));
  await sleep(200);
  assert.equal(peer.messages.some(message => message.event === 'udp'), false);

  hostile.sendPong();
  assert.equal((await peer.next('udp')).up, true);
  assert.equal((await fetch(url)).status, 200);
});

test('crypt resyncs are requested only after a failed decrypt, not while voice decrypts fine', async t => {
  const healthyPings = [];
  const healthy = await startHostileServer(t, {
    onControl(type) {
      if (type === 'connected') healthy.sendCryptSetup();
    },
    onDatagram(packet) {
      if (packet?.kind !== 'ping') return;
      healthyPings.push(Date.now());
      healthy.sendPong();
    },
  });
  let silentAnswered = 0;
  const silent = await startHostileServer(t, {
    onControl(type) {
      if (type === 'connected') silent.sendCryptSetup();
    },
    onDatagram(packet) {
      if (packet?.kind !== 'ping' || silentAnswered > 0) return;
      silentAnswered = Date.now();
      silent.sendPong();
    },
  });
  const healthyPeer = await connect(t);
  healthyPeer.send({ host: '127.0.0.1', port: healthy.port, fingerprint: hostileIdentity.fingerprint });
  const silentPeer = await connect(t);
  silentPeer.send({ host: '127.0.0.1', port: silent.port, fingerprint: hostileIdentity.fingerprint });
  await healthyPeer.next('udp');
  await silentPeer.next('udp');

  await until(() => Date.now() - silentAnswered > 5300, 'five seconds without a good decrypt', 7000);
  assert.equal(silent.resyncRequests, 0);
  silent.sendDatagram(randomBytes(40));
  await until(() => silent.resyncRequests === 1, 'a resync request after a failed decrypt');
  silent.sendDatagram(randomBytes(40));
  await sleep(200);
  assert.equal(silent.resyncRequests, 1, 'resync requests are throttled');

  await until(() => healthyPings.length >= 3, 'two more UDP ping rounds', 12_000);
  await sleep(100);
  assert.equal(healthy.resyncRequests, 0);
});
