// Mutter Web bridge. Serves the client and relays its WebSocket to the Mumble server's TLS
// socket, because browsers cannot open raw TCP. Deliberately dependency-free: on a locked-down
// work machine this runs with `node server.mjs` and nothing else — no npm install, no admin.
//
// Browser (Windows)  ──ws://localhost:8788──▶  this (WSL)  ──TLS:64738──▶  Mumble server
//                                                          ──UDP:64738──▶
//
// Voice takes the UDP lane like a native client: the browser keeps tunnelling voice frames
// over the WebSocket (localhost never drops a packet), and this end encrypts them with the
// server's CryptSetup key and sends them as UDP datagrams, decrypting the server's datagrams
// back into tunnel frames. If UDP is blocked the frames pass through over TCP as before.
// Voice over TCP stalls on every lost Wi-Fi packet; over UDP it just loses that packet.

import http from 'node:http';
import tls from 'node:tls';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FrameParser, MessageType, frame, decode } from '../src/mumble.js';
import { Writer } from '../src/protobuf.js';
import { CryptState } from '../src/ocb2.js';
import { decodeVoice, encodePing, wireFormatFor } from '../src/voice.js';

const PORT = Number(process.env.PORT ?? 8788);
const OPEN = !process.argv.includes('--no-open') && !process.env.NO_OPEN;
const UDP = !process.argv.includes('--tcp') && process.env.VOICE !== 'tcp';
const PING_MS = 5000, UDP_TIMEOUT_MS = 10_000, RESYNC_MS = 5000;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The brand faces live with the iOS app; mount them so the web client looks like Mutter.
const FONTS = path.join(ROOT, '..', 'Mutter', 'Resources', 'Fonts');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const base = rel.startsWith('/fonts/') ? FONTS : ROOT;
  const file = rel.startsWith('/fonts/')
    ? path.join(FONTS, rel.slice('/fonts/'.length))
    : path.join(ROOT, rel === '/' ? 'app/index.html' : rel);
  if (!file.startsWith(base)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  handleClient(socket);
});

function handleClient(ws) {
  let upstream = null, udp = null, port = 64738, pingTimer = null;
  const conn = new WSConnection(ws);
  const crypt = new CryptState();
  const toServer = new FrameParser(), toBrowser = new FrameParser();
  let wireFormat = 'protobuf', udpUp = false, lastReply = 0, lastResyncAsk = 0, rtt = 0, label = '';

  conn.onMessage = (data, isText) => {
    if (isText && !upstream) {
      // First message names the server to dial.
      let target;
      try { target = JSON.parse(data.toString()); } catch { return conn.close(); }
      const { host } = target;
      port = target.port ?? 64738;
      if (!host) return conn.close();
      label = `${host}:${port}`;
      console.log(`→ dialing ${label}`);
      upstream = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        console.log(`  connected ${label}`);
        conn.send(JSON.stringify({ event: 'open' }), true);
      });
      upstream.on('data', fromServer);
      upstream.on('error', e => { conn.send(JSON.stringify({ event: 'error', message: e.message }), true); conn.close(); });
      upstream.on('close', () => conn.close());
      return;
    }
    if (!upstream || isText) return;
    let frames;
    try { frames = toServer.push(new Uint8Array(data)); } catch { return conn.close(); }
    for (const f of frames) {
      if (f.type === MessageType.udpTunnel && udpUp && udp) { const enc = crypt.encrypt(f.payload); if (enc) { udp.send(enc, port, upstream.remoteAddress); continue; } }
      upstream.write(frame(f.type, f.payload));
    }
  };

  function fromServer(chunk) {
    let frames;
    try { frames = toBrowser.push(new Uint8Array(chunk)); } catch { return conn.close(); }
    for (const f of frames) {
      if (f.type === MessageType.version) wireFormat = wireFormatFor(decode(f.type, f.payload));
      else if (f.type === MessageType.cryptSetup && UDP) onCryptSetup(decode(f.type, f.payload));
      conn.send(frame(f.type, f.payload), false);
    }
  }

  function onCryptSetup(m) {
    if (m.key && m.clientNonce && m.serverNonce) {
      if (!crypt.setKey(m.key, m.clientNonce, m.serverNonce)) return;
      openUdp();
    } else if (m.serverNonce) crypt.setDecryptIV(m.serverNonce);
    else upstream.write(frame(MessageType.cryptSetup, new Writer().bytes(2, crypt.encryptIV).finish()));   // server wants our nonce
  }

  function openUdp() {
    if (udp) { ping(); return; }
    udp = dgram.createSocket(upstream.remoteFamily === 'IPv6' ? 'udp6' : 'udp4');
    udp.on('message', msg => {
      const plain = crypt.decrypt(new Uint8Array(msg));
      if (!plain) return;
      const p = decodeVoice(plain, wireFormat);
      if (p?.kind === 'ping') {
        lastReply = Date.now();
        const sent = Number(BigInt(p.timestamp) / 1000n);
        if (sent > 0 && lastReply - sent < 60_000) rtt = lastReply - sent;
        if (!udpUp) setUdp(true);
        return;
      }
      conn.send(frame(MessageType.udpTunnel, plain), false);
    });
    udp.on('error', e => { console.log(`  udp error ${e.message}`); setUdp(false); });
    ping();
    pingTimer = setInterval(() => {
      ping();
      if (udpUp && Date.now() - lastReply > UDP_TIMEOUT_MS) setUdp(false);
      // Decrypts stalled while UDP is up: ask the server for a fresh nonce, like a native client.
      if (udpUp && crypt.lastGood && Date.now() - crypt.lastGood > RESYNC_MS && Date.now() - lastResyncAsk > RESYNC_MS) {
        lastResyncAsk = Date.now();
        upstream.write(frame(MessageType.cryptSetup, new Uint8Array(0)));
      }
    }, PING_MS);
  }

  function ping() {
    if (!udp || !crypt.isValid || !upstream?.remoteAddress) return;
    const enc = crypt.encrypt(encodePing(BigInt(Date.now()) * 1000n, wireFormat));
    if (enc) udp.send(enc, port, upstream.remoteAddress);
  }

  function setUdp(up) {
    if (udpUp === up) return;
    udpUp = up;
    console.log(`  ${label}: voice over ${up ? `UDP (${rtt} ms)` : 'TCP tunnel'}`);
    conn.send(JSON.stringify({ event: 'udp', up, rtt }), true);
  }

  conn.onClose = () => { clearInterval(pingTimer); udp?.close(); udp = null; upstream?.destroy(); upstream = null; };
}

/// The slice of RFC 6455 this bridge needs: binary/text frames (including fragmented ones —
/// Chrome splits large messages such as inline images), close, ping.
class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = null;      // { opcode, parts } while a fragmented message is in flight
    this.onMessage = () => {};
    this.onClose = () => {};
    socket.on('data', c => this._read(c));
    socket.on('close', () => this.onClose());
    socket.on('error', () => { this.onClose(); socket.destroy(); });
  }

  _read(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      const first = this.buf[0], second = this.buf[1];
      const fin = (first & 0x80) !== 0, opcode = first & 0x0f, masked = (second & 0x80) !== 0;
      let len = second & 0x7f, offset = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); offset = 10; }
      const maskKey = masked ? this.buf.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (this.buf.length < offset + len) return;
      const payload = Buffer.from(this.buf.subarray(offset, offset + len));
      this.buf = this.buf.subarray(offset + len);
      if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this._frame(payload, 0xA); continue; }
      if (opcode === 0xA) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) { this.onMessage(payload, opcode === 0x1); continue; }
        this.fragments = { opcode, parts: [payload] };
      } else if (opcode === 0x0 && this.fragments) {
        this.fragments.parts.push(payload);
        if (fin) { const { opcode: op, parts } = this.fragments; this.fragments = null; this.onMessage(Buffer.concat(parts), op === 0x1); }
      }
    }
  }

  send(data, isText = false) { this._frame(Buffer.from(data), isText ? 0x1 : 0x2); }

  _frame(payload, opcode) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | opcode;
    this.socket.write(Buffer.concat([header, payload]));
  }

  close() { if (!this.socket.destroyed) { this._frame(Buffer.alloc(0), 0x8); this.socket.end(); } }
}

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Mutter  →  ${url}`);
  if (OPEN) openAppWindow(url); else console.log('(running in WSL? Windows reaches this at the same localhost address)');
});

/// Opens Mutter as its own window — Chrome/Edge "app mode": no tabs, no address bar, remembers
/// its size, its own taskbar entry. From WSL this launches the Windows browser. `--no-open` skips it.
function openAppWindow(url) {
  const flags = [`--app=${url}`, '--window-size=1180,760'];
  const wsl = process.platform === 'linux' && /microsoft/i.test(safeRead('/proc/version'));
  const browser = process.env.BROWSER;
  let cmd, args, how;
  if (wsl || process.platform === 'win32') { cmd = 'cmd.exe'; args = ['/c', 'start', browser || 'msedge', ...flags]; how = browser || 'Edge'; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = ['-na', browser || 'Google Chrome', '--args', ...flags]; how = browser || 'Chrome'; }
  else { cmd = browser || ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave'].find(has); args = flags; how = cmd; }
  if (!cmd) { console.log(`Open ${url} in Chrome or Edge (install it from the address bar for an app window).`); return; }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log(`Couldn't launch ${how}; open ${url} in Chrome or Edge.`));
    child.unref();
    console.log(`Opened an app window with ${how}. (--no-open to skip, BROWSER=chrome to pick.)`);
  } catch { console.log(`Couldn't launch ${how}; open ${url} in Chrome or Edge.`); }
}
const safeRead = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const has = bin => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };
