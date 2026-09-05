import http from 'node:http';
import tls from 'node:tls';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, FrameParser, MessageType, frame, decode } from '../src/mumble.js';
import { Writer } from '../src/protobuf.js';
import { CryptState } from '../src/ocb2.js';
import { decodeVoice, encodePing, wireFormatFor } from '../src/voice.js';

const PORT = Number(process.env.PORT ?? 8788);
const OPEN_WINDOW = !process.argv.includes('--no-open') && !process.env.NO_OPEN;
const USE_UDP = !process.argv.includes('--tcp') && process.env.VOICE !== 'tcp';
const PING_MS = 5000;
const UDP_TIMEOUT_MS = 10_000;
const RESYNC_MS = 5000;
const MAX_PING_AGE_MS = 60_000;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = path.join(ROOT, '..', 'Mutter', 'Resources', 'Fonts');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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
    return decodeURIComponent(new URL(request.url, 'http://x').pathname);
  } catch {
    return null;
  }
}

const server = http.createServer((request, response) => {
  const pathname = requestPath(request);
  if (!pathname) {
    response.writeHead(400).end();
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
});

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  new BridgeSession(new WebSocketConnection(socket));
});

class BridgeSession {
  constructor(connection) {
    this.connection = connection;
    this.upstream = null;
    this.udp = null;
    this.port = DEFAULT_PORT;
    this.label = '';
    this.crypt = new CryptState();
    this.toServer = new FrameParser();
    this.toBrowser = new FrameParser();
    this.wireFormat = 'protobuf';
    this.udpUp = false;
    this.lastUdpReply = 0;
    this.lastResyncAsk = 0;
    this.roundTripMs = 0;
    this.pingTimer = null;
    connection.onMessage = (data, isText) => this.onBrowserMessage(data, isText);
    connection.onClose = () => this.close();
  }

  onBrowserMessage(data, isText) {
    if (isText && !this.upstream) {
      this.dial(data.toString());
      return;
    }
    if (!this.upstream || isText) {
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
      if (type === MessageType.udpTunnel && this.udpUp && this.udp) {
        const encrypted = this.crypt.encrypt(payload);
        if (encrypted) {
          this.udp.send(encrypted, this.port, this.upstream.remoteAddress);
          continue;
        }
      }
      this.upstream.write(frame(type, payload));
    }
  }

  dial(text) {
    let target;
    try {
      target = JSON.parse(text);
    } catch {
      this.connection.close();
      return;
    }
    const { host } = target;
    this.port = target.port ?? DEFAULT_PORT;
    if (!host) {
      this.connection.close();
      return;
    }
    this.label = `${host}:${this.port}`;
    console.log(`→ dialing ${this.label}`);
    this.upstream = tls.connect({ host, port: this.port, rejectUnauthorized: false }, () => {
      console.log(`  connected ${this.label}`);
      this.connection.send(JSON.stringify({ event: 'open' }), true);
    });
    this.upstream.on('data', (chunk) => this.onServerData(chunk));
    this.upstream.on('error', (error) => {
      this.connection.send(JSON.stringify({ event: 'error', message: error.message }), true);
      this.connection.close();
    });
    this.upstream.on('close', () => this.connection.close());
  }

  onServerData(chunk) {
    let frames;
    try {
      frames = this.toBrowser.push(new Uint8Array(chunk));
    } catch {
      this.connection.close();
      return;
    }
    for (const { type, payload } of frames) {
      if (type === MessageType.version) {
        this.wireFormat = wireFormatFor(decode(type, payload));
      } else if (type === MessageType.cryptSetup && USE_UDP) {
        this.onCryptSetup(decode(type, payload));
      }
      this.connection.send(frame(type, payload), false);
    }
  }

  onCryptSetup(message) {
    if (message.key && message.clientNonce && message.serverNonce) {
      if (this.crypt.setKey(message.key, message.clientNonce, message.serverNonce)) {
        this.openUdp();
      }
    } else if (message.serverNonce) {
      this.crypt.setDecryptIV(message.serverNonce);
    } else {
      const ourNonce = new Writer().bytes(2, this.crypt.encryptIV).finish();
      this.upstream.write(frame(MessageType.cryptSetup, ourNonce));
    }
  }

  openUdp() {
    if (this.udp) {
      this.ping();
      return;
    }
    this.udp = dgram.createSocket(this.upstream.remoteFamily === 'IPv6' ? 'udp6' : 'udp4');
    this.udp.on('message', (datagram) => this.onDatagram(datagram));
    this.udp.on('error', (error) => {
      console.log(`  udp error ${error.message}`);
      this.setUdp(false);
    });
    this.ping();
    this.pingTimer = setInterval(() => this.tick(), PING_MS);
  }

  onDatagram(datagram) {
    const plain = this.crypt.decrypt(new Uint8Array(datagram));
    if (!plain) {
      return;
    }
    const packet = decodeVoice(plain, this.wireFormat);
    if (packet?.kind === 'ping') {
      this.onUdpPong(packet);
      return;
    }
    this.connection.send(frame(MessageType.udpTunnel, plain), false);
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
    if (!this.udp || !this.crypt.isValid || !this.upstream?.remoteAddress) {
      return;
    }
    const encrypted = this.crypt.encrypt(encodePing(BigInt(Date.now()) * 1000n, this.wireFormat));
    if (encrypted) {
      this.udp.send(encrypted, this.port, this.upstream.remoteAddress);
    }
  }

  tick() {
    this.ping();
    const now = Date.now();
    if (this.udpUp && now - this.lastUdpReply > UDP_TIMEOUT_MS) {
      this.setUdp(false);
    }
    const decryptsStalled = this.crypt.lastGood && now - this.crypt.lastGood > RESYNC_MS;
    if (this.udpUp && decryptsStalled && now - this.lastResyncAsk > RESYNC_MS) {
      this.lastResyncAsk = now;
      this.upstream.write(frame(MessageType.cryptSetup, new Uint8Array(0)));
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
    clearInterval(this.pingTimer);
    this.udp?.close();
    this.udp = null;
    this.upstream?.destroy();
    this.upstream = null;
  }
}

class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.onMessage = () => {};
    this.onClose = () => {};
    socket.on('data', (chunk) => this.read(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', () => {
      this.onClose();
      socket.destroy();
    });
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) {
          return;
        }
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) {
          return;
        }
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : null;
      if (masked) {
        offset += 4;
      }
      if (this.buffer.length < offset + length) {
        return;
      }
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }
      this.handleFrame(opcode, fin, payload);
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
      if (fin) {
        this.onMessage(payload, opcode === Opcode.text);
      } else {
        this.fragments = { opcode, parts: [payload] };
      }
      return;
    }
    if (opcode === Opcode.continuation && this.fragments) {
      this.fragments.parts.push(payload);
      if (fin) {
        const { opcode: firstOpcode, parts } = this.fragments;
        this.fragments = null;
        this.onMessage(Buffer.concat(parts), firstOpcode === Opcode.text);
      }
    }
  }

  send(data, isText = false) {
    this.writeFrame(Buffer.from(data), isText ? Opcode.text : Opcode.binary);
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
    this.socket.write(Buffer.concat([header, payload]));
  }

  close() {
    if (this.socket.destroyed) {
      return;
    }
    this.writeFrame(Buffer.alloc(0), Opcode.close);
    this.socket.end();
  }
}

export const ready = new Promise((resolve) => {
  server.listen(PORT, () => {
    const url = `http://localhost:${server.address().port}`;
    console.log(`Mutter  →  ${url}`);
    if (OPEN_WINDOW) {
      openAppWindow(url);
    } else if (!process.versions.electron) {
      console.log('(running in WSL? Windows reaches this at the same localhost address)');
    }
    resolve(url);
  });
});

export { server };

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
