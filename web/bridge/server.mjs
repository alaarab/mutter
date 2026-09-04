// Mutter Web bridge. Serves the client and relays its WebSocket to the Mumble server's TLS
// socket, because browsers cannot open raw TCP. Deliberately dependency-free: on a locked-down
// work machine this runs with `node server.mjs` and nothing else — no npm install, no admin.
//
// Browser (Windows)  ──ws://localhost:8788──▶  this (WSL)  ──TLS:64738──▶  Mumble server

import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8788);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The brand faces live with the iOS app; mount them so the web client looks like Mutter.
const FONTS = path.join(ROOT, '..', 'Mutter', 'Resources', 'Fonts');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png' };

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
  let upstream = null;
  const conn = new WSConnection(ws);

  conn.onMessage = (data, isText) => {
    if (isText && !upstream) {
      // First message names the server to dial.
      let target;
      try { target = JSON.parse(data.toString()); } catch { return conn.close(); }
      const { host, port = 64738 } = target;
      if (!host) return conn.close();
      console.log(`→ dialing ${host}:${port}`);
      upstream = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        console.log(`  connected ${host}:${port}`);
        conn.send(JSON.stringify({ event: 'open' }), true);
      });
      upstream.on('data', chunk => conn.send(chunk, false));
      upstream.on('error', e => { conn.send(JSON.stringify({ event: 'error', message: e.message }), true); conn.close(); });
      upstream.on('close', () => conn.close());
      return;
    }
    if (upstream && !isText) upstream.write(data);   // raw Mumble frames, straight through
  };

  conn.onClose = () => { upstream?.destroy(); upstream = null; };
}

/// The slice of RFC 6455 this bridge needs: binary/text frames, close, ping.
class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
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
      const opcode = first & 0x0f, masked = (second & 0x80) !== 0;
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
      if (opcode === 0x1 || opcode === 0x2) this.onMessage(payload, opcode === 0x1);
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
  console.log(`Mutter Web  →  http://localhost:${PORT}`);
  console.log('(running in WSL? Windows reaches this at the same localhost address)');
});
