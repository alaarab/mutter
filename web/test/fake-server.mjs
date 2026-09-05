import tls from 'node:tls';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FrameParser,
  MessageType,
  frame,
  decode,
  versionFields,
  versionMessage,
  textMessage,
  permissionQueryMessage,
  channelRemoveMessage,
  pluginDataMessage,
} from '../src/mumble.js';
import { Writer } from '../src/protobuf.js';
import { decodeClientAudio, encodeServerAudio, isPingPacket } from '../src/voice.js';
import { CryptState } from '../src/ocb2.js';

const ALL_PERMISSIONS = 0x1f07ff;
const IDLE_DROP_MS = 30_000;
const UDP_FRESH_MS = 15_000;
const PLUGIN_MAX_BYTES = 1000;
const PLUGIN_BUCKET = { rate: 4, burst: 15 };
const LOOPBACK_TARGET = 31;
const MAX_BANDWIDTH = 558_000;
const FAKE_PORT = 64740;
const WELCOME_HTML = '<b>Welcome</b> to the fake server. Nothing here is real.';

const DenyType = { text: 0, permission: 1, channelName: 3, textTooLong: 4 };
const RejectType = { invalidUsername: 2, wrongServerPassword: 4, usernameInUse: 5 };

const DEFAULT_CHANNELS = [
  { channelId: 0, name: 'Root', description: 'A fake server for testing Mutter Web.', position: 0 },
  { channelId: 1, parent: 0, name: 'Lounge', position: 0 },
  { channelId: 2, parent: 0, name: 'Games', position: 1 },
  { channelId: 3, parent: 2, name: 'Rocket League', position: 0 },
  { channelId: 4, parent: 0, name: 'AFK', position: 2, maxUsers: 4 },
];

export async function startFakeServer({
  port = FAKE_PORT,
  version = process.env.FAKE_VERSION ?? '1.5.735',
  password = null,
  quiet = false,
  udp = process.env.FAKE_UDP !== '0',
} = {}) {
  const server = new FakeMumbleServer({ version, password, quiet, udp });
  await server.listen(port);
  return server;
}

export class FakeMumbleServer extends EventEmitter {
  constructor({ version, password, quiet, udp = true }) {
    super();
    this.udpEnabled = udp;
    this.udpAddresses = new Map();
    const [major, minor, patch] = version.split('.').map(Number);
    this.version = { ...versionFields(major, minor, patch), release: `FakeMumble ${version}` };
    this.legacyVoice = major < 1 || (major === 1 && minor < 5);
    this.voiceFormat = this.legacyVoice ? 'legacy' : 'protobuf';
    this.password = password;
    this.quiet = quiet;
    this.nextSession = 1;
    this.users = new Map();
    this.channels = new Map(DEFAULT_CHANNELS.map((channel) => [channel.channelId, { ...channel }]));
    this.nextChannel = 5;
    this.config = { allowHtml: true, messageLength: 5000, imageMessageLength: 131072, maxUsers: 100 };
    this.dropped = { plugin: 0, text: 0 };
  }

  listen(port) {
    this.tls = tls.createServer(ensureCertificate(), (socket) => this.accept(socket));
    return new Promise((resolve, reject) => {
      this.tls.once('error', reject);
      this.tls.listen(port, '127.0.0.1', () => {
        this.port = this.tls.address().port;
        const voice = this.legacyVoice ? 'legacy' : 'protobuf';
        this.log(`listening on 127.0.0.1:${this.port} (${voice} voice${this.udpEnabled ? ', UDP on' : ', UDP off'})`);
        if (!this.udpEnabled) {
          resolve();
          return;
        }
        this.udp = dgram.createSocket('udp4');
        this.udp.on('message', (datagram, remote) => this.onDatagram(new Uint8Array(datagram), remote));
        this.udp.bind(this.port, '127.0.0.1', () => resolve());
      });
    });
  }

  close() {
    for (const user of this.users.values()) {
      user.socket.destroy();
    }
    this.users.clear();
    this.udp?.close();
    return new Promise((resolve) => this.tls.close(() => resolve()));
  }

  accept(socket) {
    const user = {
      socket,
      parser: new FrameParser(),
      session: null,
      name: undefined,
      synced: false,
      bucket: PLUGIN_BUCKET.burst,
      bucketAt: Date.now(),
      idleTimer: null,
      versionSeen: false,
      crypt: null,
      udpRemote: null,
      udpAt: 0,
    };
    const touch = () => {
      clearTimeout(user.idleTimer);
      user.idleTimer = setTimeout(() => {
        this.log(`${user.name ?? '?'} idle for 30 s — dropping`);
        socket.destroy();
      }, IDLE_DROP_MS);
    };
    touch();
    socket.on('data', (chunk) => {
      touch();
      let frames;
      try {
        frames = user.parser.push(new Uint8Array(chunk));
      } catch (error) {
        this.log(`bad framing from ${user.name}: ${error.message}`);
        socket.destroy();
        return;
      }
      for (const received of frames) {
        try {
          this.handle(user, received);
        } catch (error) {
          this.log(`error handling ${received.type} from ${user.name}: ${error.stack}`);
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(user.idleTimer);
      if (user.session === null || !this.users.has(user.session)) {
        return;
      }
      this.users.delete(user.session);
      this.log(`${user.name} left`);
      this.broadcast(encode.userRemove({ session: user.session }));
      this.emit('disconnect', user.session);
    });
  }

  handle(user, { type, payload }) {
    if (type === MessageType.udpTunnel) {
      this.onVoice(user, payload);
      return;
    }
    const message = decode(type, payload);
    if (type === MessageType.version) {
      user.versionSeen = true;
      return;
    }
    if (type === MessageType.authenticate) {
      this.authenticate(user, message);
      return;
    }
    if (!user.synced) {
      return;
    }
    switch (type) {
      case MessageType.ping:
        this.sendTo(user, frame(MessageType.ping, payload));
        break;
      case MessageType.userState:
        this.onUserState(user, message);
        break;
      case MessageType.textMessage:
        this.onText(user, message);
        break;
      case MessageType.channelState:
        this.onChannelState(user, message);
        break;
      case MessageType.channelRemove:
        this.onChannelRemove(user, message);
        break;
      case MessageType.permissionQuery:
        this.sendTo(user, permissionQueryMessage(message.channelId ?? 0, ALL_PERMISSIONS));
        break;
      case MessageType.userStats:
        this.onUserStats(user, message);
        break;
      case MessageType.pluginDataTransmission:
        this.onPlugin(user, message);
        break;
      case MessageType.cryptSetup:
        this.onCryptSetup(user, message);
        break;
      default:
        break;
    }
  }

  authenticate(user, message) {
    const name = message.username ?? '';
    if (!name || name.length > 64) {
      this.reject(user, RejectType.invalidUsername, 'Invalid username');
      return;
    }
    if ([...this.users.values()].some((other) => other.name === name)) {
      this.reject(user, RejectType.usernameInUse, `Username "${name}" is already in use`);
      return;
    }
    if (this.password && message.password !== this.password) {
      this.reject(user, RejectType.wrongServerPassword, 'Wrong server password');
      return;
    }
    Object.assign(user, {
      session: this.nextSession++,
      name,
      channelId: 0,
      selfMute: false,
      selfDeaf: false,
      mute: false,
      deaf: false,
      since: Date.now(),
    });
    this.users.set(user.session, user);
    this.sendHandshake(user);
    user.synced = true;
    this.broadcast(encode.userState(user, true), user);
    this.log(`${name} joined as session ${user.session}`);
    this.emit('connect', { session: user.session, name });
  }

  sendHandshake(user) {
    this.sendTo(user, versionMessage({ ...this.version, os: 'Node', osVersion: process.version }));
    const key = crypto.randomBytes(16);
    const clientNonce = crypto.randomBytes(16);
    const serverNonce = crypto.randomBytes(16);
    user.crypt = new CryptState();
    user.crypt.setKey(key, serverNonce, clientNonce);
    this.sendTo(user, frame(MessageType.cryptSetup, new Writer().bytes(1, key).bytes(2, clientNonce).bytes(3, serverNonce).finish()));
    this.sendTo(user, frame(MessageType.codecVersion, new Writer().uint(1, 0).uint(2, 0).bool(3, false).bool(4, true).finish()));
    for (const channel of this.channels.values()) {
      this.sendTo(user, encode.channelState(channel));
    }
    this.sendTo(user, permissionQueryMessage(0, ALL_PERMISSIONS));
    for (const other of this.users.values()) {
      if (other !== user) {
        this.sendTo(user, encode.userState(other, true));
      }
    }
    this.sendTo(user, encode.userState(user, true));
    this.sendTo(
      user,
      frame(
        MessageType.serverSync,
        new Writer().uint(1, user.session).uint(2, MAX_BANDWIDTH).string(3, WELCOME_HTML).uint(4, ALL_PERMISSIONS).finish()
      )
    );
    const { allowHtml, messageLength, imageMessageLength, maxUsers } = this.config;
    this.sendTo(
      user,
      frame(
        MessageType.serverConfig,
        new Writer().bool(3, allowHtml).uint(4, messageLength).uint(5, imageMessageLength).uint(6, maxUsers).finish()
      )
    );
  }

  reject(user, type, reason) {
    this.sendTo(user, frame(MessageType.reject, new Writer().uint(1, type).string(2, reason).finish()));
    this.log(`rejected connection: ${reason}`);
    user.socket.end();
  }

  onUserState(actor, message) {
    const target = message.session === undefined ? actor : this.users.get(message.session);
    if (!target) {
      return;
    }
    const delta = { session: target.session, actor: actor.session };
    if (message.channelId !== undefined) {
      const channel = this.channels.get(message.channelId);
      if (!channel) {
        this.deny(actor, DenyType.permission, 'No such channel');
        return;
      }
      const occupants = [...this.users.values()].filter((user) => user.channelId === channel.channelId).length;
      if (channel.maxUsers && occupants >= channel.maxUsers) {
        this.deny(actor, DenyType.permission, 'Channel is full', { channelId: channel.channelId });
        return;
      }
      if (target.channelId !== message.channelId) {
        target.channelId = message.channelId;
        delta.channelId = message.channelId;
      }
    }
    for (const key of ['selfMute', 'selfDeaf', 'mute', 'deaf', 'comment', 'prioritySpeaker']) {
      if (message[key] !== undefined) {
        target[key] = message[key];
        delta[key] = message[key];
      }
    }
    if (target.selfDeaf && !target.selfMute) {
      target.selfMute = true;
      delta.selfMute = true;
    }
    if (message.pluginContext !== undefined) {
      target.pluginContext = message.pluginContext;
    }
    if (message.pluginIdentity !== undefined) {
      target.pluginIdentity = message.pluginIdentity;
    }
    if (Object.keys(delta).length === 2) {
      return;
    }
    this.broadcast(encode.userState(delta));
    this.emit('user-state', delta);
  }

  onChannelState(user, message) {
    if (message.channelId === undefined) {
      this.createChannel(user, message);
      return;
    }
    const channel = this.channels.get(message.channelId);
    if (!channel) {
      return;
    }
    for (const key of ['name', 'description', 'position', 'maxUsers']) {
      if (message[key] !== undefined) {
        channel[key] = message[key];
      }
    }
    this.broadcast(encode.channelState(channel));
  }

  createChannel(user, message) {
    const parent = this.channels.get(message.parent ?? 0);
    if (!parent) {
      this.deny(user, DenyType.permission, 'No such parent');
      return;
    }
    if (!message.name) {
      this.deny(user, DenyType.channelName, 'Channel name is not valid');
      return;
    }
    const channel = {
      channelId: this.nextChannel++,
      parent: parent.channelId,
      name: message.name,
      description: message.description,
      temporary: !!message.temporary,
      position: message.position ?? 0,
    };
    this.channels.set(channel.channelId, channel);
    this.broadcast(encode.channelState(channel));
    if (channel.temporary) {
      user.channelId = channel.channelId;
      this.broadcast(encode.userState({ session: user.session, actor: user.session, channelId: channel.channelId }));
    }
    this.log(`${user.name} created channel "${channel.name}" (#${channel.channelId})`);
  }

  subtree(channelId) {
    const ids = [channelId];
    for (let i = 0; i < ids.length; i++) {
      for (const channel of this.channels.values()) {
        if (channel.parent === ids[i]) {
          ids.push(channel.channelId);
        }
      }
    }
    return ids;
  }

  onChannelRemove(user, message) {
    const channel = this.channels.get(message.channelId);
    if (!channel || channel.channelId === 0) {
      this.deny(user, DenyType.permission, "Can't remove that channel");
      return;
    }
    const doomed = this.subtree(channel.channelId);
    for (const id of doomed) {
      for (const occupant of this.users.values()) {
        if (occupant.channelId === id) {
          occupant.channelId = channel.parent ?? 0;
          this.broadcast(encode.userState({ session: occupant.session, channelId: occupant.channelId }));
        }
      }
      this.channels.delete(id);
    }
    for (const id of doomed.reverse()) {
      this.broadcast(channelRemoveMessage(id));
    }
  }

  recipientsFor(sender, message) {
    const recipients = new Set();
    for (const session of message.sessions ?? []) {
      if (this.users.has(session)) {
        recipients.add(session);
      }
    }
    for (const channelId of message.channelIds ?? []) {
      for (const user of this.users.values()) {
        if (user.channelId === channelId) {
          recipients.add(user.session);
        }
      }
    }
    for (const treeId of message.treeIds ?? []) {
      const tree = this.subtree(treeId);
      for (const user of this.users.values()) {
        if (tree.includes(user.channelId)) {
          recipients.add(user.session);
        }
      }
    }
    recipients.delete(sender.session);
    return recipients;
  }

  onText(sender, message) {
    const html = message.message ?? '';
    if (!this.textAllowed(html)) {
      this.dropped.text++;
      this.deny(sender, DenyType.textTooLong);
      return;
    }
    const recipients = this.recipientsFor(sender, message);
    const outgoing = textMessage({
      actor: sender.session,
      sessions: message.sessions,
      channelIds: message.channelIds,
      treeIds: message.treeIds,
      html,
    });
    for (const session of recipients) {
      this.sendTo(this.users.get(session), outgoing);
    }
    this.emit('text', { from: sender.session, html, recipients: [...recipients] });
  }

  textAllowed(html) {
    const { messageLength, imageMessageLength } = this.config;
    if (html.length <= messageLength) {
      return true;
    }
    if (imageMessageLength && html.length >= imageMessageLength) {
      return false;
    }
    if (!xmlWellFormed(html)) {
      return false;
    }
    const withoutImageData = html.replace(/(<img\b[^>]*?\bsrc\s*=\s*")[^"]*(")/gi, '$1$2');
    return withoutImageData.length <= messageLength;
  }

  onUserStats(user, message) {
    const session = message.session ?? user.session;
    const since = this.users.get(session)?.since ?? Date.now();
    this.sendTo(user, encode.userStats({ session, onlineSecs: Math.round((Date.now() - since) / 1000) }));
  }

  onCryptSetup(user, message) {
    if (message.clientNonce) {
      user.crypt.setDecryptIV(message.clientNonce);
    } else {
      this.sendTo(user, frame(MessageType.cryptSetup, new Writer().bytes(3, user.crypt.encryptIV).finish()));
    }
  }

  onPlugin(user, message) {
    const data = message.data ?? new Uint8Array(0);
    if (data.length > PLUGIN_MAX_BYTES) {
      this.dropped.plugin++;
      this.log(`plugin data from ${user.name} too large (${data.length})`);
      this.emit('drop', { kind: 'plugin-size', from: user.session });
      return;
    }
    const now = Date.now();
    user.bucket = Math.min(PLUGIN_BUCKET.burst, user.bucket + ((now - user.bucketAt) / 1000) * PLUGIN_BUCKET.rate);
    user.bucketAt = now;
    if (user.bucket < 1) {
      this.dropped.plugin++;
      this.log(`plugin data from ${user.name} rate-limited`);
      this.emit('drop', { kind: 'plugin-rate', from: user.session });
      return;
    }
    user.bucket -= 1;
    const receivers = (message.receiverSessions ?? []).filter((session) => this.users.has(session) && session !== user.session);
    const outgoing = pluginDataMessage({ sender: user.session, receivers, data, dataId: message.dataId ?? '' });
    for (const session of receivers) {
      this.sendTo(this.users.get(session), outgoing);
    }
    this.emit('plugin', { from: user.session, dataId: message.dataId, bytes: data.length, receivers });
  }

  onVoice(user, payload, via = 'tcp') {
    const packet = decodeClientAudio(payload, this.voiceFormat);
    if (!packet) {
      return;
    }
    if (via === 'tcp') {
      user.udpRemote = null;
    }
    this.emit('voice', {
      session: user.session,
      target: packet.target,
      frameNumber: packet.frameNumber,
      bytes: packet.opus.length,
      isTerminator: packet.isTerminator,
      via,
    });
    const outgoing = encodeServerAudio({ ...packet, session: user.session, context: 0 }, this.voiceFormat);
    if (packet.target === LOOPBACK_TARGET) {
      this.sendVoice(user, outgoing);
      return;
    }
    if (packet.target !== 0) {
      return;
    }
    for (const listener of this.users.values()) {
      const canHear = listener !== user && listener.synced && listener.channelId === user.channelId;
      if (canHear && !listener.selfDeaf && !listener.deaf) {
        this.sendVoice(listener, outgoing);
      }
    }
  }

  sendVoice(user, packet) {
    if (user.udpRemote && Date.now() - user.udpAt < UDP_FRESH_MS) {
      const encrypted = user.crypt.encrypt(packet);
      if (encrypted) {
        this.udp.send(encrypted, user.udpRemote.port, user.udpRemote.address);
        return;
      }
    }
    this.sendTo(user, frame(MessageType.udpTunnel, packet));
  }

  onDatagram(datagram, remote) {
    const key = `${remote.address}:${remote.port}`;
    let user = this.udpAddresses.get(key);
    let plain = null;
    if (user) {
      plain = user.crypt.decrypt(datagram);
    } else {
      for (const candidate of this.users.values()) {
        if (!candidate.synced) {
          continue;
        }
        plain = candidate.crypt.decrypt(datagram);
        if (plain) {
          user = candidate;
          this.udpAddresses.set(key, candidate);
          break;
        }
      }
    }
    if (!user || !plain) {
      return;
    }
    user.udpRemote = remote;
    user.udpAt = Date.now();
    if (isPingPacket(plain, this.voiceFormat)) {
      const encrypted = user.crypt.encrypt(plain);
      if (encrypted) {
        this.udp.send(encrypted, remote.port, remote.address);
      }
      this.emit('udp-ping', user.session);
      return;
    }
    this.onVoice(user, plain, 'udp');
  }

  deny(user, type, reason, extra = {}) {
    const writer = new Writer();
    if (extra.channelId !== undefined) {
      writer.uint(2, extra.channelId);
    }
    if (reason !== undefined) {
      writer.string(4, reason);
    }
    this.sendTo(user, frame(MessageType.permissionDenied, writer.uint(5, type).finish()));
  }

  sendTo(user, bytes) {
    if (user && !user.socket.destroyed) {
      user.socket.write(bytes);
    }
  }

  broadcast(bytes, except) {
    for (const user of this.users.values()) {
      if (user !== except && user.synced) {
        this.sendTo(user, bytes);
      }
    }
  }

  log(text) {
    if (!this.quiet) {
      console.log(`[fake-mumble] ${text}`);
    }
  }
}

const encode = {
  channelState(channel) {
    const writer = new Writer()
      .uint(1, channel.channelId)
      .uint(2, channel.parent)
      .string(3, channel.name)
      .string(5, channel.description)
      .bool(8, channel.temporary)
      .uint(9, channel.position)
      .uint(11, channel.maxUsers);
    return frame(MessageType.channelState, writer.finish());
  },
  userState(user, full = false) {
    const writer = new Writer().uint(1, user.session).uint(2, user.actor);
    if (full) {
      writer
        .string(3, user.name)
        .uint(5, user.channelId)
        .bool(6, user.mute || undefined)
        .bool(7, user.deaf || undefined)
        .bool(9, user.selfMute || undefined)
        .bool(10, user.selfDeaf || undefined)
        .string(14, user.comment);
    } else {
      writer
        .uint(5, user.channelId)
        .bool(6, user.mute)
        .bool(7, user.deaf)
        .bool(9, user.selfMute)
        .bool(10, user.selfDeaf)
        .string(14, user.comment)
        .bool(18, user.prioritySpeaker);
    }
    return frame(MessageType.userState, writer.finish());
  },
  userRemove({ session, actor, reason, ban }) {
    return frame(MessageType.userRemove, new Writer().uint(1, session).uint(2, actor).string(3, reason).bool(4, ban).finish());
  },
  userStats({ session, onlineSecs }) {
    const mappedLoopback = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1]);
    const writer = new Writer()
      .uint(1, session)
      .uint(7, 42)
      .bytes(14, mappedLoopback)
      .uint(15, 40_000)
      .uint(16, onlineSecs)
      .uint(17, 0)
      .bool(19, true);
    return frame(MessageType.userStats, writer.finish());
  },
};

const XML_TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const BARE_AMPERSAND = /&(?![A-Za-z]+;|#\d+;|#x[0-9A-Fa-f]+;)/;

export function xmlWellFormed(html) {
  const stack = [];
  let position = 0;
  while (position < html.length) {
    const tagStart = html.indexOf('<', position);
    const text = html.slice(position, tagStart === -1 ? html.length : tagStart);
    if (BARE_AMPERSAND.test(text) || />/.test(text)) {
      return false;
    }
    if (tagStart === -1) {
      break;
    }
    XML_TAG.lastIndex = tagStart;
    const match = XML_TAG.exec(html);
    if (!match) {
      return false;
    }
    const [, closing, name, , selfClosing] = match;
    if (closing) {
      if (stack.pop() !== name.toLowerCase()) {
        return false;
      }
    } else if (!selfClosing) {
      stack.push(name.toLowerCase());
    }
    position = XML_TAG.lastIndex;
  }
  return stack.length === 0;
}

function ensureCertificate() {
  const dir = path.join(os.tmpdir(), 'mutter-fake-mumble');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '3650', '-subj', '/CN=Fake Mumble'],
      { stdio: 'ignore' }
    );
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startFakeServer({ port: Number(process.argv[2] ?? FAKE_PORT) });
}
