// A small Mumble server for tests — not murmur. TLS, the control-channel handshake, a roster,
// text relay, voice relay over UDPTunnel (target 31 loops back to the sender, as on a real
// server), and plugin data with murmur's limits. It lets the client be exercised end to end
// without pointing test audio at a real server full of real people.
//
//   node web/test/fake-server.mjs [port]         # default 64740
//   FAKE_VERSION=1.4.287 node web/test/fake-server.mjs   # legacy voice wire format
//
// Or from a test:  const s = await startFakeServer({ port: 0 }); ... s.close();

import tls from 'node:tls';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FrameParser, MessageType, frame, decode } from '../src/mumble.js';
import { Reader, Writer } from '../src/protobuf.js';
import { MumbleVarint, OPUS } from '../src/voice.js';
import { CryptState } from '../src/ocb2.js';

const ALL_PERMISSIONS = 0x1F07FF;
const IDLE_DROP_MS = 30_000;
const PLUGIN_MAX_BYTES = 1000;          // murmur: msgPluginDataTransmission
const PLUGIN_BUCKET = { rate: 4, burst: 15 };
const DenyType = { text: 0, permission: 1, textTooLong: 4 };

export async function startFakeServer({ port = 64740, version = process.env.FAKE_VERSION ?? '1.5.735', password = null, quiet = false, udp = process.env.FAKE_UDP !== '0' } = {}) {
  const server = new FakeMumbleServer({ version, password, quiet, udp });
  await server.listen(port);
  return server;
}

export class FakeMumbleServer extends EventEmitter {
  constructor({ version, password, quiet, udp = true }) {
    super();
    this.udpEnabled = udp;
    this.udpAddr = new Map();          // "ip:port" → user, learned from the first datagram that decrypts
    const [major, minor, patch] = version.split('.').map(Number);
    this.version = { major, minor, patch, release: `FakeMumble ${version}` };
    this.legacyVoice = major < 1 || (major === 1 && minor < 5);
    this.password = password;
    this.quiet = quiet;
    this.nextSession = 1;
    this.users = new Map();
    this.channels = new Map([
      [0, { channelId: 0, name: 'Root', description: 'A fake server for testing Mutter Web.', position: 0 }],
      [1, { channelId: 1, parent: 0, name: 'Lounge', position: 0 }],
      [2, { channelId: 2, parent: 0, name: 'Games', position: 1 }],
      [3, { channelId: 3, parent: 2, name: 'Rocket League', position: 0 }],
      [4, { channelId: 4, parent: 0, name: 'AFK', position: 2, maxUsers: 4 }],
    ]);
    this.nextChannel = 5;
    this.config = { allowHtml: true, messageLength: 5000, imageMessageLength: 131072, maxUsers: 100 };
    this.dropped = { plugin: 0, text: 0 };
  }

  listen(port) {
    this.tls = tls.createServer(ensureCert(), socket => this._accept(socket));
    return new Promise((res, rej) => {
      this.tls.once('error', rej);
      this.tls.listen(port, '127.0.0.1', () => {
        this.port = this.tls.address().port;
        this._log(`listening on 127.0.0.1:${this.port} (${this.legacyVoice ? 'legacy' : 'protobuf'} voice${this.udpEnabled ? ', UDP on' : ', UDP off'})`);
        if (!this.udpEnabled) return res();
        this.udp = dgram.createSocket('udp4');
        this.udp.on('message', (msg, rinfo) => this._udp(new Uint8Array(msg), rinfo));
        this.udp.bind(this.port, '127.0.0.1', () => res());
      });
    });
  }

  close() {
    for (const u of this.users.values()) u.socket.destroy();
    this.users.clear();
    this.udp?.close();
    return new Promise(res => this.tls.close(() => res()));
  }

  // ---- connections ----

  _accept(socket) {
    const u = { socket, parser: new FrameParser(), session: null, synced: false, bucket: PLUGIN_BUCKET.burst, bucketAt: Date.now(), idle: null, versionSeen: false };
    const touch = () => { clearTimeout(u.idle); u.idle = setTimeout(() => { this._log(`${u.name ?? '?'} idle for 30 s — dropping`); socket.destroy(); }, IDLE_DROP_MS); };
    touch();
    socket.on('data', chunk => {
      touch();
      let frames;
      try { frames = u.parser.push(new Uint8Array(chunk)); } catch (e) { this._log(`bad framing from ${u.name}: ${e.message}`); return socket.destroy(); }
      for (const f of frames) { try { this._handle(u, f); } catch (e) { this._log(`error handling ${f.type} from ${u.name}: ${e.stack}`); } }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(u.idle);
      if (u.session === null || !this.users.has(u.session)) return;
      this.users.delete(u.session);
      this._log(`${u.name} left`);
      this._broadcast(msg.userRemove({ session: u.session }));
      this.emit('disconnect', u.session);
    });
  }

  _handle(u, { type, payload }) {
    if (type === MessageType.udpTunnel) return this._voice(u, payload);
    const m = decode(type, payload);
    switch (type) {
      case MessageType.version: u.versionSeen = true; return;
      case MessageType.authenticate: return this._authenticate(u, m);
    }
    if (!u.synced) return;
    switch (type) {
      case MessageType.ping: return this._sendTo(u, frame(MessageType.ping, payload));
      case MessageType.userState: return this._userState(u, m);
      case MessageType.textMessage: return this._text(u, m);
      case MessageType.channelState: return this._channelState(u, m);
      case MessageType.channelRemove: return this._channelRemove(u, m);
      case MessageType.permissionQuery: return this._sendTo(u, msg.permissionQuery({ channelId: m.channelId ?? 0, permissions: ALL_PERMISSIONS }));
      case MessageType.userStats: return this._sendTo(u, msg.userStats({ session: m.session ?? u.session, onlineSecs: Math.round((Date.now() - (this.users.get(m.session ?? u.session)?.since ?? Date.now())) / 1000) }));
      case MessageType.pluginDataTransmission: return this._plugin(u, m);
      case MessageType.voiceTarget: return;
      case MessageType.cryptSetup: {
        if (m.clientNonce) u.crypt.setDecryptIV(m.clientNonce);
        else this._sendTo(u, frame(MessageType.cryptSetup, new Writer().bytes(3, u.crypt.encryptIV).finish()));   // resync: here is my nonce
        return;
      }
    }
  }

  _authenticate(u, m) {
    const name = m.username ?? '';
    if (!name || name.length > 64) return this._reject(u, 2, 'Invalid username');
    if ([...this.users.values()].some(x => x.name === name)) return this._reject(u, 5, `Username "${name}" is already in use`);
    if (this.password && m.password !== this.password) return this._reject(u, 4, 'Wrong server password');
    const { major, minor, patch, release } = this.version;
    u.session = this.nextSession++;
    u.name = name; u.channelId = 0; u.selfMute = false; u.selfDeaf = false; u.mute = false; u.deaf = false; u.since = Date.now();
    this.users.set(u.session, u);

    this._sendTo(u, msg.version({ v1: (major << 16) | (minor << 8) | Math.min(patch, 255), v2: (BigInt(major) << 48n) | (BigInt(minor) << 32n) | (BigInt(patch) << 16n), release, os: 'Node', osVersion: process.version }));
    const key = crypto.randomBytes(16), clientNonce = crypto.randomBytes(16), serverNonce = crypto.randomBytes(16);
    u.crypt = new CryptState(); u.crypt.setKey(key, serverNonce, clientNonce);       // the server encrypts with its nonce, decrypts with the client's
    this._sendTo(u, frame(MessageType.cryptSetup, new Writer().bytes(1, key).bytes(2, clientNonce).bytes(3, serverNonce).finish()));
    this._sendTo(u, frame(MessageType.codecVersion, new Writer().uint(1, 0).uint(2, 0).bool(3, false).bool(4, true).finish()));
    for (const c of this.channels.values()) this._sendTo(u, msg.channelState(c));
    this._sendTo(u, msg.permissionQuery({ channelId: 0, permissions: ALL_PERMISSIONS }));
    for (const other of this.users.values()) if (other !== u) this._sendTo(u, msg.userState(other, true));
    const mine = msg.userState(u, true);
    this._sendTo(u, mine);
    this._sendTo(u, frame(MessageType.serverSync, new Writer().uint(1, u.session).uint(2, 558_000).string(3, '<b>Welcome</b> to the fake server. Nothing here is real.').uint(4, ALL_PERMISSIONS).finish()));
    this._sendTo(u, frame(MessageType.serverConfig, new Writer().bool(3, this.config.allowHtml).uint(4, this.config.messageLength).uint(5, this.config.imageMessageLength).uint(6, this.config.maxUsers).finish()));
    u.synced = true;
    this._broadcast(mine, u);
    this._log(`${name} joined as session ${u.session}`);
    this.emit('connect', { session: u.session, name });
  }

  _reject(u, type, reason) {
    this._sendTo(u, frame(MessageType.reject, new Writer().uint(1, type).string(2, reason).finish()));
    this._log(`rejected connection: ${reason}`);
    u.socket.end();
  }

  // ---- state changes ----

  _userState(u, m) {
    const target = m.session === undefined ? u : this.users.get(m.session);
    if (!target) return;
    const delta = { session: target.session, actor: u.session };
    if (m.channelId !== undefined) {
      const c = this.channels.get(m.channelId);
      if (!c) return this._deny(u, DenyType.permission, 'No such channel');
      if (c.maxUsers && [...this.users.values()].filter(x => x.channelId === c.channelId).length >= c.maxUsers) return this._deny(u, DenyType.permission, 'Channel is full', { channelId: c.channelId });
      if (target.channelId !== m.channelId) { target.channelId = m.channelId; delta.channelId = m.channelId; }
    }
    for (const k of ['selfMute', 'selfDeaf', 'mute', 'deaf', 'comment', 'prioritySpeaker']) if (m[k] !== undefined) { target[k] = m[k]; delta[k] = m[k]; }
    if (target.selfDeaf && !target.selfMute) { target.selfMute = true; delta.selfMute = true; }
    if (m.pluginContext !== undefined) target.pluginContext = m.pluginContext;
    if (m.pluginIdentity !== undefined) target.pluginIdentity = m.pluginIdentity;
    if (Object.keys(delta).length === 2) return;
    this._broadcast(msg.userState(delta));
    this.emit('user-state', delta);
  }

  _channelState(u, m) {
    if (m.channelId === undefined) {
      const parent = this.channels.get(m.parent ?? 0);
      if (!parent) return this._deny(u, DenyType.permission, 'No such parent');
      if (!m.name) return this._deny(u, 3, 'Channel name is not valid');
      const c = { channelId: this.nextChannel++, parent: parent.channelId, name: m.name, description: m.description, temporary: !!m.temporary, position: m.position ?? 0 };
      this.channels.set(c.channelId, c);
      this._broadcast(msg.channelState(c));
      if (c.temporary) { u.channelId = c.channelId; this._broadcast(msg.userState({ session: u.session, actor: u.session, channelId: c.channelId })); }
      this._log(`${u.name} created channel "${c.name}" (#${c.channelId})`);
      return;
    }
    const c = this.channels.get(m.channelId);
    if (!c) return;
    for (const k of ['name', 'description', 'position', 'maxUsers']) if (m[k] !== undefined) c[k] = m[k];
    this._broadcast(msg.channelState(c));
  }

  _channelRemove(u, m) {
    const c = this.channels.get(m.channelId);
    if (!c || c.channelId === 0) return this._deny(u, DenyType.permission, "Can't remove that channel");
    const doomed = [c.channelId];
    for (let i = 0; i < doomed.length; i++) for (const x of this.channels.values()) if (x.parent === doomed[i]) doomed.push(x.channelId);
    for (const id of doomed) {
      for (const x of this.users.values()) if (x.channelId === id) { x.channelId = c.parent ?? 0; this._broadcast(msg.userState({ session: x.session, channelId: x.channelId })); }
      this.channels.delete(id);
    }
    for (const id of doomed.reverse()) this._broadcast(msg.channelRemove(id));
  }

  _text(u, m) {
    const html = m.message ?? '';
    if (!this._textAllowed(html)) { this.dropped.text++; return this._deny(u, DenyType.textTooLong); }
    const recipients = new Set();
    for (const s of m.sessions ?? []) if (this.users.has(s)) recipients.add(s);
    for (const cid of m.channelIds ?? []) for (const x of this.users.values()) if (x.channelId === cid) recipients.add(x.session);
    for (const tid of m.treeIds ?? []) {
      const tree = [tid];
      for (let i = 0; i < tree.length; i++) for (const c of this.channels.values()) if (c.parent === tree[i]) tree.push(c.channelId);
      for (const x of this.users.values()) if (tree.includes(x.channelId)) recipients.add(x.session);
    }
    recipients.delete(u.session);
    const out = msg.textMessage({ actor: u.session, sessions: m.sessions, channelIds: m.channelIds, treeIds: m.treeIds, message: html });
    for (const s of recipients) this._sendTo(this.users.get(s), out);
    this.emit('text', { from: u.session, html, recipients: [...recipients] });
  }

  /// murmur's Server::isTextAllowed with allowhtml on: short messages pass unparsed; anything
  /// longer than textmessagelength must be well-formed XML (QXmlStreamReader) and, with the
  /// <img src> values removed, still fit textmessagelength; nothing may exceed imagemessagelength.
  _textAllowed(html) {
    const { messageLength, imageMessageLength } = this.config;
    if (html.length <= messageLength) return true;
    if (imageMessageLength && html.length >= imageMessageLength) return false;
    if (!xmlWellFormed(html)) return false;
    return html.replace(/(<img\b[^>]*?\bsrc\s*=\s*")[^"]*(")/gi, '$1$2').length <= messageLength;
  }

  _plugin(u, m) {
    const data = m.data ?? new Uint8Array(0);
    if (data.length > PLUGIN_MAX_BYTES) { this.dropped.plugin++; this._log(`plugin data from ${u.name} too large (${data.length})`); this.emit('drop', { kind: 'plugin-size', from: u.session }); return; }
    // murmur's leaky bucket: burst then a sustained rate; overflow is silently dropped.
    const now = Date.now();
    u.bucket = Math.min(PLUGIN_BUCKET.burst, u.bucket + (now - u.bucketAt) / 1000 * PLUGIN_BUCKET.rate); u.bucketAt = now;
    if (u.bucket < 1) { this.dropped.plugin++; this._log(`plugin data from ${u.name} rate-limited`); this.emit('drop', { kind: 'plugin-rate', from: u.session }); return; }
    u.bucket -= 1;
    const receivers = (m.receiverSessions ?? []).filter(s => this.users.has(s) && s !== u.session);
    const out = msg.pluginData({ sender: u.session, receivers, data, dataId: m.dataId ?? '' });
    for (const s of receivers) this._sendTo(this.users.get(s), out);
    this.emit('plugin', { from: u.session, dataId: m.dataId, bytes: data.length, receivers });
  }

  // ---- voice ----

  _voice(u, payload, via = 'tcp') {
    const p = parseClientAudio(payload, this.legacyVoice);
    if (!p) return;
    if (via === 'tcp') u.udpRinfo = null;          // murmur: a tunnelled packet switches that client back to TCP
    this.emit('voice', { session: u.session, target: p.target, frameNumber: p.frameNumber, bytes: p.opus.length, isTerminator: p.isTerminator, via });
    const pkt = serverAudio({ ...p, session: u.session, context: 0 }, this.legacyVoice);
    if (p.target === 31) return this._sendVoice(u, pkt);
    if (p.target !== 0) return;
    for (const x of this.users.values()) if (x !== u && x.synced && x.channelId === u.channelId && !x.selfDeaf && !x.deaf) this._sendVoice(x, pkt);
  }

  /// UDP when we've heard from that client over UDP recently, else the TCP tunnel — like murmur.
  _sendVoice(x, pkt) {
    if (x.udpRinfo && Date.now() - x.udpAt < 15_000) { const enc = x.crypt.encrypt(pkt); if (enc) return this.udp.send(enc, x.udpRinfo.port, x.udpRinfo.address); }
    this._sendTo(x, frame(MessageType.udpTunnel, pkt));
  }

  _udp(msg, rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    let u = this.udpAddr.get(key), plain = null;
    if (u) plain = u.crypt.decrypt(msg);
    else for (const x of this.users.values()) { if (!x.synced) continue; plain = x.crypt.decrypt(msg); if (plain) { u = x; this.udpAddr.set(key, x); break; } }
    if (!u || !plain) return;
    u.udpRinfo = rinfo; u.udpAt = Date.now();
    const isPing = this.legacyVoice ? plain[0] >> 5 === 1 : plain[0] === 1;
    if (isPing) { const enc = u.crypt.encrypt(plain); if (enc) this.udp.send(enc, rinfo.port, rinfo.address); this.emit('udp-ping', u.session); return; }
    this._voice(u, plain, 'udp');
  }

  // ---- plumbing ----

  /// PermissionDenied: 1 permission, 2 channel_id, 3 session, 4 reason, 5 type, 6 name.
  _deny(u, type, reason, extra = {}) {
    const w = new Writer();
    if (extra.channelId !== undefined) w.uint(2, extra.channelId);
    if (reason !== undefined) w.string(4, reason);          // murmur sends most types bare
    this._sendTo(u, frame(MessageType.permissionDenied, w.uint(5, type).finish()));
  }
  _sendTo(u, bytes) { if (u && !u.socket.destroyed) u.socket.write(bytes); }
  _broadcast(bytes, except) { for (const x of this.users.values()) if (x !== except && x.synced) this._sendTo(x, bytes); }
  _log(s) { if (!this.quiet) console.log(`[fake-mumble] ${s}`); }
}

// ---- server-side encoders ----

const msg = {
  version: ({ v1, v2, release, os, osVersion }) => frame(MessageType.version, new Writer().uint(1, v1).string(2, release).string(3, os).string(4, osVersion).uint(5, v2).finish()),
  channelState: c => frame(MessageType.channelState, new Writer().uint(1, c.channelId).uint(2, c.parent).string(3, c.name).string(5, c.description).bool(8, c.temporary).uint(9, c.position).uint(11, c.maxUsers).finish()),
  channelRemove: id => frame(MessageType.channelRemove, new Writer().uint(1, id).finish()),
  userState: (u, full = false) => {
    const w = new Writer().uint(1, u.session).uint(2, u.actor);
    if (full) w.string(3, u.name).uint(5, u.channelId).bool(6, u.mute || undefined).bool(7, u.deaf || undefined).bool(9, u.selfMute || undefined).bool(10, u.selfDeaf || undefined).string(14, u.comment);
    else w.uint(5, u.channelId).bool(6, u.mute).bool(7, u.deaf).bool(9, u.selfMute).bool(10, u.selfDeaf).string(14, u.comment).bool(18, u.prioritySpeaker);
    return frame(MessageType.userState, w.finish());
  },
  userRemove: ({ session, actor, reason, ban }) => frame(MessageType.userRemove, new Writer().uint(1, session).uint(2, actor).string(3, reason).bool(4, ban).finish()),
  textMessage: ({ actor, sessions = [], channelIds = [], treeIds = [], message }) => {
    const w = new Writer().uint(1, actor);
    for (const s of sessions) w.uint(2, s);
    for (const c of channelIds) w.uint(3, c);
    for (const t of treeIds) w.uint(4, t);
    return frame(MessageType.textMessage, w.string(5, message).finish());
  },
  permissionQuery: ({ channelId, permissions }) => frame(MessageType.permissionQuery, new Writer().uint(1, channelId).uint(2, permissions).finish()),
  userStats: ({ session, onlineSecs }) => frame(MessageType.userStats, new Writer().uint(1, session).uint(7, 42).bytes(14, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1])).uint(15, 40_000).uint(16, onlineSecs).uint(17, 0).bool(19, true).finish()),
  pluginData: ({ sender, receivers, data, dataId }) => {
    const w = new Writer().uint(1, sender);
    for (const r of receivers) w.uint(2, r);
    return frame(MessageType.pluginDataTransmission, w.bytes(3, data).string(4, dataId).finish());
  },
};

/// A close-enough stand-in for QXmlStreamReader on `<document>html</document>`: every tag must
/// be a proper element with quoted attributes, closed or self-closing, properly nested, and any
/// bare `&` must be an entity. `<img src="…">` without the slash is the classic failure.
export function xmlWellFormed(html) {
  const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
  const stack = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    const text = html.slice(i, lt === -1 ? html.length : lt);
    if (/&(?![A-Za-z]+;|#\d+;|#x[0-9A-Fa-f]+;)/.test(text) || />/.test(text)) return false;
    if (lt === -1) break;
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    if (!m) return false;
    const [, closing, name, , selfClosing] = m;
    if (closing) { if (stack.pop() !== name.toLowerCase()) return false; }
    else if (!selfClosing) stack.push(name.toLowerCase());
    i = TAG.lastIndex;
  }
  return stack.length === 0;
}

/// Client → server audio: protobuf has target/frame/opus; legacy is header, seq, len, opus.
function parseClientAudio(b, legacy) {
  if (!b.length) return null;
  if (legacy) {
    if (b[0] >> 5 !== OPUS) return null;
    let r = MumbleVarint.decode(b, 1); if (!r) return null; const [seq, i1] = r;
    r = MumbleVarint.decode(b, i1); if (!r) return null; const [lenField, i2] = r;
    const len = Number(lenField & 0x1FFFn);
    return { target: b[0] & 0x1F, frameNumber: seq, isTerminator: (lenField & 0x2000n) !== 0n, opus: b.subarray(i2, i2 + len) };
  }
  if (b[0] !== 0) return null;
  const p = { target: 0, frameNumber: 0n, opus: new Uint8Array(0), isTerminator: false };
  new Reader(b.subarray(1)).forEachField(f => {
    if (f.number === 1) p.target = f.uint;
    else if (f.number === 4) p.frameNumber = BigInt(f.uint);
    else if (f.number === 5) p.opus = f.payload;
    else if (f.number === 16) p.isTerminator = f.bool;
  });
  return p;
}

/// Server → client audio, with the sender's session and the context in place of the target.
function serverAudio({ session, context, frameNumber, opus, isTerminator }, legacy) {
  if (legacy) {
    const out = [(OPUS << 5) | (context & 0x1F)];
    MumbleVarint.encode(session, out); MumbleVarint.encode(frameNumber, out);
    MumbleVarint.encode(BigInt(opus.length & 0x1FFF) | (isTerminator ? 0x2000n : 0n), out);
    const pkt = new Uint8Array(out.length + opus.length); pkt.set(out); pkt.set(opus, out.length);
    return pkt;
  }
  const w = new Writer().uint(2, context).uint(3, session).uint(4, frameNumber).bytes(5, opus);
  if (isTerminator) w.bool(16, true);
  const body = w.finish();
  const pkt = new Uint8Array(body.length + 1); pkt[0] = 0; pkt.set(body, 1);
  return pkt;
}

function ensureCert() {
  const dir = path.join(os.tmpdir(), 'mutter-fake-mumble');
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-subj', '/CN=Fake Mumble'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startFakeServer({ port: Number(process.argv[2] ?? 64740) });
}
