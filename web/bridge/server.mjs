import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, FrameParser, MessageType, frame, decode } from '../src/mumble.js';
import { ByteQueue, Writer, isWellFormedMessage } from '../src/protobuf.js';
import { CryptState } from '../src/ocb2.js';
import { decodeVoice, encodePing, isPingPacket, wireFormatFor } from '../src/voice.js';
import { inspectPeer, isFingerprint } from './peer-certificate.mjs';
import { BoundedWriter } from './bounded-writer.mjs';

const PORT = Number(process.env.PORT ?? 8788);
const OPEN_WINDOW = !process.argv.includes('--no-open') && !process.env.NO_OPEN;
const USE_UDP = !process.argv.includes('--tcp') && process.env.VOICE !== 'tcp';
const PING_MS = 5000;
const UDP_TIMEOUT_MS = 10_000;
const RESYNC_MS = 5000;
const MAX_PING_AGE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CERTIFICATE_APPROVAL_TIMEOUT_MS = 120_000;
const SERVER_SYNC_TIMEOUT_MS = 30_000;
const MIN_DATAGRAM_BYTES = 5;
const MAX_DATAGRAM_BYTES = 2048;
const MAX_WS_HEADER_BYTES = 14;
const EPHEMERAL_PORT_ATTEMPTS = 20;
const IPV6_UNAVAILABLE_CODES = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.join(ROOT, '..', 'design', 'fonts');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BRIDGE_TOKEN = crypto.randomBytes(32).toString('hex');
const MAX_WS_MESSAGE = 8 * 1024 * 1024 + 6;
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function allowedHost(host) {
  const port = server.address()?.port;
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

function allowedRequest(request) {
  if (!allowedHost(request.headers.host)) return false;
  const origin = request.headers.origin;
  return !origin || origin === `http://${request.headers.host}`;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

const Opcode = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
};

function isInside(base, file) {
  const relative = path.relative(base, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveStaticFile(pathname) {
  const [base, relative] = pathname.startsWith('/fonts/')
    ? [FONTS, pathname.slice('/fonts/'.length)]
    : [ROOT, pathname === '/' ? 'app/index.html' : pathname];
  const file = path.join(base, relative);
  return isInside(base, file) ? file : null;
}

function requestPath(request) {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    return pathname.includes('\0') ? null : pathname;
  } catch {
    return null;
  }
}

function handleRequest(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (!allowedRequest(request)) {
    response.writeHead(403).end();
    return;
  }
  const pathname = requestPath(request);
  if (!pathname) {
    response.writeHead(400).end();
    return;
  }
  if (pathname === '/bridge-token' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ token: BRIDGE_TOKEN }));
    return;
  }
  const file = resolveStaticFile(pathname);
  if (!file) {
    response.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    response.end(data);
  });
}

function handleUpgrade(request, socket, head) {
  socket.on('error', () => socket.destroy());
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  const key = request.headers['sec-websocket-key'];
  if (!allowedRequest(request) || url.pathname !== '/bridge' || url.searchParams.get('token') !== BRIDGE_TOKEN ||
      typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || request.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const connection = new WebSocketConnection(socket);
  new BridgeSession(connection);
  if (head.length) connection.read(head);
}

const server = http.createServer(handleRequest);
const loopbackIPv6Server = http.createServer(handleRequest);
const listeners = [server, loopbackIPv6Server];
for (const listener of listeners) {
  listener.on('upgrade', handleUpgrade);
}

class BridgeSession {
  constructor(connection) {
    this.connection = connection;
    this.upstream = null;
    this.upstreamWriter = null;
    this.udp = null;
    this.port = DEFAULT_PORT;
    this.label = '';
    this.crypt = new CryptState();
    this.toServer = new FrameParser();
    this.toBrowser = new FrameParser();
    this.wireFormat = 'protobuf';
    this.udpUp = false;
    this.udpConnected = false;
    this.lastUdpReply = 0;
    this.lastResyncAsk = 0;
    this.cryptKeyedAt = 0;
    this.roundTripMs = 0;
    this.pingTimer = null;
    this.trusted = false;
    this.certificate = null;
    this.closed = false;
    this.connectionTimer = setTimeout(() => this.fail('Connection timed out.'), CONNECT_TIMEOUT_MS);
    connection.onMessage = (data, isText) => {
      try { this.onBrowserMessage(data, isText); }
      catch { this.fail('Invalid client message.'); }
    };
    connection.onClose = () => this.close();
    connection.onBackpressure = (blocked) => {
      if (!this.trusted || this.closed) return;
      if (blocked) this.upstream.pause();
      else this.upstream.resume();
    };
  }

  onBrowserMessage(data, isText) {
    if (this.closed) return;
    if (isText) {
      let message;
      try {
        if (data.length > 4096) throw new Error('Connection request is too large.');
        message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid connection request.');
        if (!this.upstream) {
          this.dial(message);
        } else if (!this.trusted && this.certificate && message.event === 'trust' && message.fingerprint === this.certificate.fingerprint) {
          this.acceptCertificate();
        } else {
          throw new Error('Unexpected connection request.');
        }
      } catch (error) {
        this.fail(error.message);
      }
      return;
    }
    if (!this.upstream || !this.trusted) {
      this.fail('The server certificate has not been accepted.');
      return;
    }
    let frames;
    try {
      frames = this.toServer.push(new Uint8Array(data));
    } catch {
      this.connection.close();
      return;
    }
    for (const { type, payload } of frames) {
      if (this.closed) return;
      if (type === MessageType.udpTunnel && this.udpUp && this.udpConnected) {
        const encrypted = this.crypt.encrypt(payload);
        if (encrypted) {
          this.udp.send(encrypted);
          continue;
        }
      }
      this.upstreamWriter.write(frame(type, payload));
    }
  }

  dial(target) {
    const { host } = target;
    this.port = target.port ?? DEFAULT_PORT;
    if (typeof host !== 'string' || !host.length || host.length > 253 || /[\s\x00/\\]/.test(host) ||
        !Number.isInteger(this.port) || this.port < 1 || this.port > 65535 ||
        (target.fingerprint !== undefined && !isFingerprint(target.fingerprint))) {
      throw new Error('Invalid server address, port, or certificate fingerprint.');
    }
    this.label = `${host}:${this.port}`;
    console.log(`→ dialing ${this.label}`);
    this.upstream = tls.connect({ host, port: this.port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => {
      try {
        this.certificate = inspectPeer(this.upstream, host, target.fingerprint);
        clearTimeout(this.connectionTimer);
        if (this.certificate.trusted) {
          this.acceptCertificate();
        } else {
          this.connectionTimer = setTimeout(() => this.fail('Certificate approval timed out.'), CERTIFICATE_APPROVAL_TIMEOUT_MS);
          this.connection.send(JSON.stringify({ event: 'certificate', host, port: this.port, ...this.certificate }), true);
        }
      } catch (error) {
        this.fail(error.message);
      }
    });
    this.upstreamWriter = new BoundedWriter(this.upstream, {
      pause: () => this.connection.pause(),
      resume: () => this.connection.resume(),
      overflow: () => this.connection.abort(),
    });
    this.upstream.pause();
    this.upstream.on('data', (chunk) => this.onServerData(chunk));
    this.upstream.on('error', (error) => {
      this.fail(error.message);
    });
    this.upstream.on('close', () => this.connection.close());
  }

  acceptCertificate() {
    clearTimeout(this.connectionTimer);
    this.connectionTimer = setTimeout(() => this.fail('The server did not finish connecting.'), SERVER_SYNC_TIMEOUT_MS);
    this.trusted = true;
    console.log(`  connected ${this.label}`);
    this.connection.send(JSON.stringify({ event: 'open', fingerprint: this.certificate.fingerprint }), true);
    if (!this.connection.writer.blocked) this.upstream.resume();
  }

  fail(message) {
    if (this.closed) return;
    this.connection.send(JSON.stringify({ event: 'error', message }), true);
    this.close();
    this.connection.close();
  }

  onServerData(chunk) {
    if (!this.trusted || this.closed) return;
    let frames;
    try {
      frames = this.toBrowser.push(new Uint8Array(chunk));
    } catch {
      this.connection.close();
      return;
    }
    try {
      for (const { type, payload } of frames) {
        if (this.closed) return;
        if (type !== MessageType.udpTunnel && !isWellFormedMessage(payload)) {
          continue;
        }
        if (type === MessageType.version) {
          this.wireFormat = wireFormatFor(decode(type, payload));
        } else if (type === MessageType.cryptSetup && USE_UDP) {
          this.onCryptSetup(decode(type, payload));
        } else if (type === MessageType.serverSync) {
          clearTimeout(this.connectionTimer);
        }
        this.connection.send(frame(type, payload), false);
      }
    } catch {
      this.fail('Malformed server message.');
    }
  }

  onCryptSetup(message) {
    if (message.key && message.clientNonce && message.serverNonce) {
      if (this.crypt.setKey(message.key, message.clientNonce, message.serverNonce)) {
        this.cryptKeyedAt = Date.now();
        this.openUdp();
      }
    } else if (message.serverNonce) {
      this.crypt.setDecryptIV(message.serverNonce);
    } else {
      const ourNonce = new Writer().bytes(2, this.crypt.encryptIV).finish();
      this.upstreamWriter.write(frame(MessageType.cryptSetup, ourNonce));
    }
  }

  openUdp() {
    if (this.udp) {
      this.ping();
      return;
    }
    const udp = dgram.createSocket(this.upstream.remoteFamily === 'IPv6' ? 'udp6' : 'udp4');
    this.udp = udp;
    udp.on('message', (datagram) => {
      try {
        this.onDatagram(datagram);
      } catch (error) {
        console.log(`  ${this.label}: dropped a voice datagram (${error.message})`);
      }
    });
    udp.on('error', (error) => {
      console.log(`  udp error ${error.message}`);
      this.setUdp(false);
    });
    udp.connect(this.port, this.upstream.remoteAddress, () => {
      if (this.udp !== udp) {
        return;
      }
      this.udpConnected = true;
      this.ping();
      this.pingTimer = setInterval(() => this.tick(), PING_MS);
    });
  }

  onDatagram(datagram) {
    if (this.closed || datagram.length < MIN_DATAGRAM_BYTES || datagram.length > MAX_DATAGRAM_BYTES) {
      return;
    }
    const plain = this.crypt.decrypt(new Uint8Array(datagram));
    if (!plain) {
      this.requestResyncIfStalled();
      return;
    }
    if (isPingPacket(plain, this.wireFormat)) {
      const packet = decodeVoice(plain, this.wireFormat);
      if (packet?.kind === 'ping') {
        this.onUdpPong(packet);
      }
      return;
    }
    // UDP has no upstream flow control. Discard voice while the browser is
    // stalled instead of retaining stale audio or growing its write queue.
    if (!this.connection.writer.blocked) {
      this.connection.send(frame(MessageType.udpTunnel, plain), false);
    }
  }

  requestResyncIfStalled() {
    const now = Date.now();
    const lastGood = this.crypt.lastGood || this.cryptKeyedAt;
    if (now - lastGood > RESYNC_MS && now - this.lastResyncAsk > RESYNC_MS) {
      this.lastResyncAsk = now;
      this.upstreamWriter.write(frame(MessageType.cryptSetup, new Uint8Array(0)));
    }
  }

  onUdpPong(packet) {
    this.lastUdpReply = Date.now();
    const sentAt = Number(BigInt(packet.timestamp) / 1000n);
    if (sentAt > 0 && this.lastUdpReply - sentAt < MAX_PING_AGE_MS) {
      this.roundTripMs = this.lastUdpReply - sentAt;
    }
    if (!this.udpUp) {
      this.setUdp(true);
    }
  }

  ping() {
    if (!this.udpConnected || !this.crypt.isValid) {
      return;
    }
    const encrypted = this.crypt.encrypt(encodePing(BigInt(Date.now()) * 1000n, this.wireFormat));
    if (encrypted) {
      this.udp.send(encrypted);
    }
  }

  tick() {
    this.ping();
    if (this.udpUp && Date.now() - this.lastUdpReply > UDP_TIMEOUT_MS) {
      this.setUdp(false);
    }
  }

  setUdp(up) {
    if (this.udpUp === up) {
      return;
    }
    this.udpUp = up;
    console.log(`  ${this.label}: voice over ${up ? `UDP (${this.roundTripMs} ms)` : 'TCP tunnel'}`);
    this.connection.send(JSON.stringify({ event: 'udp', up, rtt: this.roundTripMs }), true);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectionTimer);
    clearInterval(this.pingTimer);
    this.udp?.close();
    this.udp = null;
    this.udpConnected = false;
    this.upstreamWriter?.dispose();
    this.upstreamWriter = null;
    this.upstream?.destroy();
    this.upstream = null;
  }
}

class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.readingPaused = false;
    this.pending = new ByteQueue();
    this.fragments = null;
    this.onMessage = () => {};
    this.onClose = () => {};
    this.onBackpressure = () => {};
    this.writer = new BoundedWriter(socket, {
      pause: () => this.onBackpressure(true),
      resume: () => this.onBackpressure(false),
      overflow: () => this.abort(),
    });
    socket.on('data', (chunk) => this.read(chunk));
    socket.on('close', () => this.abort());
    socket.on('end', () => this.close());
    socket.on('error', () => {
      this.abort();
    });
  }

  read(chunk) {
    if (this.closed) return;
    this.pending.push(chunk);
    while (!this.readingPaused && this.pending.length >= 2) {
      const header = Buffer.from(this.pending.peek(Math.min(this.pending.length, MAX_WS_HEADER_BYTES)));
      const first = header[0];
      const second = header[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (header.length < 4) {
          return;
        }
        length = header.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (header.length < 10) {
          return;
        }
        length = Number(header.readBigUInt64BE(2));
        offset = 10;
      }
      if (!masked || length > MAX_WS_MESSAGE || (first & 0x70) ||
          (opcode >= 8 && (!fin || length > 125))) {
        this.close();
        return;
      }
      if (this.pending.length < offset + 4 + length) {
        return;
      }
      const maskKey = header.subarray(offset, offset + 4);
      this.pending.skip(offset + 4);
      const maskedPayload = this.pending.take(length);
      const payload = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i++) {
        payload[i] = maskedPayload[i] ^ maskKey[i & 3];
      }
      this.handleFrame(opcode, fin, payload);
      if (this.closed) return;
    }
  }

  handleFrame(opcode, fin, payload) {
    if (opcode === Opcode.close) {
      this.close();
      return;
    }
    if (opcode === Opcode.ping) {
      this.writeFrame(payload, Opcode.pong);
      return;
    }
    if (opcode === Opcode.pong) {
      return;
    }
    if (opcode === Opcode.text || opcode === Opcode.binary) {
      if (this.fragments) { this.close(); return; }
      if (fin) {
        this.onMessage(payload, opcode === Opcode.text);
      } else {
        this.fragments = { opcode, parts: [payload], size: payload.length };
      }
      return;
    }
    if (opcode === Opcode.continuation && this.fragments) {
      this.fragments.size += payload.length;
      if (this.fragments.size > MAX_WS_MESSAGE || this.fragments.parts.length >= 8192) { this.close(); return; }
      this.fragments.parts.push(payload);
      if (fin) {
        const { opcode: firstOpcode, parts } = this.fragments;
        this.fragments = null;
        this.onMessage(Buffer.concat(parts), firstOpcode === Opcode.text);
      }
      return;
    }
    this.close();
  }

  send(data, isText = false) {
    if (this.closed) return false;
    return this.writeFrame(Buffer.from(data), isText ? Opcode.text : Opcode.binary);
  }

  writeFrame(payload, opcode) {
    if (this.socket.destroyed) {
      return;
    }
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    return this.writer.write(Buffer.concat([header, payload]));
  }

  pause() {
    this.readingPaused = true;
    this.socket.pause();
  }

  resume() {
    if (this.closed) return;
    this.readingPaused = false;
    this.read(Buffer.alloc(0));
    if (!this.readingPaused && !this.closed) this.socket.resume();
  }

  abort() {
    this.writer.dispose();
    this.pending = new ByteQueue();
    this.fragments = null;
    if (!this.closed) {
      this.closed = true;
      this.onClose();
    }
    this.socket.destroy();
  }

  close() {
    if (this.closed || this.socket.destroyed) {
      return;
    }
    this.closed = true;
    this.pending = new ByteQueue();
    this.fragments = null;
    this.onClose();
    this.writeFrame(Buffer.alloc(0), Opcode.close);
    this.writer.dispose();
    this.socket.end();
    this.socket.setTimeout(1000, () => this.socket.destroy());
  }
}

function listenOn(listener, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      listener.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      listener.off('error', onError);
      resolve(listener.address().port);
    };
    listener.once('error', onError);
    listener.once('listening', onListening);
    listener.listen(port, host);
  });
}

function stopListening(listener) {
  return new Promise((resolve) => listener.close(() => resolve()));
}

async function listenOnBothLoopbacks() {
  const attempts = PORT === 0 ? EPHEMERAL_PORT_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    const port = await listenOn(server, PORT, '127.0.0.1');
    try {
      await listenOn(loopbackIPv6Server, port, '::1');
      return port;
    } catch (error) {
      if (IPV6_UNAVAILABLE_CODES.has(error.code)) {
        return port;
      }
      await stopListening(server);
      if (error.code !== 'EADDRINUSE' || attempt >= attempts) {
        throw error;
      }
    }
  }
}

export const ready = listenOnBothLoopbacks().then((port) => {
  const url = `http://localhost:${port}`;
  console.log(`Mutter  →  ${url}`);
  if (OPEN_WINDOW) {
    openAppWindow(url);
  } else if (!process.versions.electron) {
    console.log('(running in WSL? Windows reaches this at the same localhost address)');
  }
  return url;
});

export { server, listeners };

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function browserLauncher(url) {
  const flags = [`--app=${url}`, '--window-size=1180,760'];
  const isWsl = process.platform === 'linux' && /microsoft/i.test(readFileOrEmpty('/proc/version'));
  const preferred = process.env.BROWSER;
  if (isWsl || process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/c', 'start', preferred || 'msedge', ...flags], name: preferred || 'Edge' };
  }
  if (process.platform === 'darwin') {
    return { command: 'open', args: ['-na', preferred || 'Google Chrome', '--args', ...flags], name: preferred || 'Chrome' };
  }
  const candidates = ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave'];
  const command = preferred || candidates.find(hasCommand);
  return { command, args: flags, name: command };
}

function openAppWindow(url) {
  const { command, args, name } = browserLauncher(url);
  if (!command) {
    console.log(`Open ${url} in Chrome or Edge (install it from the address bar for an app window).`);
    return;
  }
  const fallback = `Couldn't launch ${name}; open ${url} in Chrome or Edge.`;
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(fallback));
    child.unref();
    console.log(`Opened an app window with ${name}. (--no-open to skip, BROWSER=chrome to pick.)`);
  } catch {
    console.log(fallback);
  }
}
