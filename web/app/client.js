// The Mumble session: connection lifecycle, roster, chat, voice plumbing, and our plugin channel.
// Mirrors MumbleClient + ServerSession on iOS, including the hard-won reconnect behaviour:
// silence watchdog, roster reset on reconnect (no ghost "old me"), and username-in-use recovery.

import {
  FrameParser, MessageType, decode, versionMessage, authenticateMessage, pingMessage,
  userStateMessage, textMessage, udpTunnel, pluginDataMessage, createChannelMessage,
  permissionQueryMessage, userStatsRequest, REJECT_REASONS,
} from '../src/mumble.js';
import { encodeAudio, decodeVoice, wireFormatFor } from '../src/voice.js';

const REJECT_USERNAME_IN_USE = 5;
const WATCHDOG_MS = 20_000;
const MAX_RECONNECTS = 6;

// PermissionDenied.DenyType. Only `text` carries a reason string; the rest arrive bare.
const DenyType = { text: 0, permission: 1, superUser: 2, channelName: 3, textTooLong: 4, h9k: 5, temporaryChannel: 6, missingCertificate: 7, userName: 8, channelFull: 9, nestingLimit: 10, channelCountLimit: 11, channelListenerLimit: 12, userListenerLimit: 13 };
const DENY_TEXT = {
  1: 'You don’t have permission for that', 2: 'Only the SuperUser can do that', 3: 'That channel name isn’t allowed',
  4: 'Message too long for this server', 6: 'Not allowed in a temporary channel', 7: 'A certificate is required',
  8: 'That username isn’t allowed', 9: 'Channel is full', 10: 'Channels are nested too deep', 11: 'Too many channels',
  12: 'Channel listener limit reached', 13: 'You’re listening to too many channels',
};

export class MumbleClient extends EventTarget {
  constructor() {
    super();
    this.state = 'disconnected';
    this.channels = new Map();
    this.users = new Map();
    this.messages = [];
    this.me = null;
    this.serverInfo = {};
    this.wireFormat = 'protobuf';
    this.stats = { tcpPingMs: 0, samples: [], udp: null, stalls: 0 };
    this._lastPacket = new Map();
    this.log = [];
    this._ws = null;
    this._parser = null;
    this._target = null;
    this._intentional = false;
    this._reconnectAttempt = 0;
    this._usernameInUseRetries = 0;
    this._usernameOverride = null;
    this._frameNumber = 0;
    this._talkers = new Map();
    this._lastRx = 0;
    this._timers = {};
  }

  // ---- public API ----

  connect(target) {
    this._target = { port: 64738, ...target };
    this._intentional = false;
    this._reconnectAttempt = 0;
    this._usernameInUseRetries = 0;
    this._usernameOverride = null;
    this.messages = [];
    this._resetRoster();
    this._open();
  }

  disconnect() {
    this._intentional = true;
    this._teardown();
    this._setState('disconnected');
  }

  get isConnected() { return this.state === 'connected'; }
  get myUser() { return this.users.get(this.me); }
  get myChannel() { return this.channels.get(this.myUser?.channelId ?? 0); }
  get rootChannel() { return this.channels.get(0); }
  children(channelId) {
    return [...this.channels.values()].filter(c => c.parent === channelId && c.channelId !== channelId)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.name ?? '').localeCompare(b.name ?? ''));
  }
  usersIn(channelId) {
    return [...this.users.values()].filter(u => (u.channelId ?? 0) === channelId)
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }
  path(channelId) {
    const out = [];
    let c = this.channels.get(channelId);
    while (c) { out.unshift(c); c = c.channelId === 0 ? null : this.channels.get(c.parent); }
    return out;
  }

  sendText(html, scope = { channelId: this.myUser?.channelId ?? 0 }) {
    if (!this.isConnected) { this._note('Not connected — message not sent.'); return false; }
    this._send(textMessage({ html, channelIds: scope.channelId !== undefined ? [scope.channelId] : [], treeIds: scope.treeId !== undefined ? [scope.treeId] : [], sessions: scope.sessions ?? [] }));
    this._pushMessage({ senderSession: this.me, senderName: this.myUser?.name ?? 'Me', html, scope, own: true });
    return true;
  }

  joinChannel(channelId) { this._send(userStateMessage({ session: this.me, channelId })); }
  setSelfMute(on) { this._send(userStateMessage({ session: this.me, selfMute: on, ...(on ? {} : { selfDeaf: false }) })); }
  setSelfDeaf(on) { this._send(userStateMessage({ session: this.me, selfDeaf: on, ...(on ? { selfMute: true } : {}) })); }
  createChannel(parent, name, temporary = true) { this._send(createChannelMessage({ parent, name, temporary })); }
  queryPermissions(channelId) { this._send(permissionQueryMessage(channelId)); }
  requestStats(session) { this._send(userStatsRequest(session)); }

  /// Opus frame(s) → voice packet → tunnelled over TCP.
  sendAudio(opus, frameCount = 1, isTerminator = false, target = 0) {
    if (!this.isConnected) return;
    const pkt = encodeAudio({ target, frameNumber: this._frameNumber, opus, isTerminator }, this.wireFormat);
    this._frameNumber += Math.max(1, frameCount);
    this._send(udpTunnel(pkt));
  }

  /// Our extension channel: ≤1000 bytes, ~4 msg/s, receivers must be explicit.
  sendPlugin(receivers, dataId, data) {
    if (!this.isConnected || !receivers.length) return false;
    this._send(pluginDataMessage({ receivers, dataId, data }));
    return true;
  }

  // ---- connection ----

  _open() {
    this._setState(this._reconnectAttempt ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`ws://${location.host}`);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;
    this._parser = new FrameParser();
    ws.onopen = () => ws.send(JSON.stringify({ host: this._target.host, port: this._target.port }));
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.event === 'open') this._handshake();
        else if (msg.event === 'error') this._fail(msg.message);
        else if (msg.event === 'udp') { this.stats.udp = { up: msg.up, rtt: msg.rtt }; this._diag('voice', msg.up ? `voice over UDP through the bridge (${msg.rtt} ms)` : 'voice over the TCP tunnel'); this._emit('stats'); }
        return;
      }
      this._lastRx = Date.now();
      let frames;
      try { frames = this._parser.push(new Uint8Array(ev.data)); } catch (e) { this._fail(e.message); return; }
      for (const f of frames) this._handle(f);
    };
    ws.onclose = () => { if (this._ws === ws) this._fail(this._intentional ? null : 'Connection closed'); };
    ws.onerror = () => {};
  }

  _handshake() {
    this._setState('authenticating');
    this._send(versionMessage({ v1: (1 << 16) | (5 << 8), v2: (1n << 48n) | (5n << 32n), release: 'Mutter Web', os: 'Web', osVersion: navigator.platform || '1' }));
    this._send(authenticateMessage({ username: this._usernameOverride ?? this._target.username, password: this._target.password, tokens: this._target.tokens ?? [] }));
  }

  _send(bytes) { if (this._ws?.readyState === 1) this._ws.send(bytes); }

  _teardown() {
    for (const t of Object.values(this._timers)) clearInterval(t);
    this._timers = {};
    const ws = this._ws; this._ws = null;
    try { ws?.close(); } catch {}
    this._talkers.clear(); this._lastPacket.clear();
    this._frameNumber = 0;
    this.stats.udp = null;
  }

  _fail(message) {
    const wasSynced = this.state === 'connected';
    const reconnecting = this._reconnectAttempt > 0;
    this._teardown();
    if (this._intentional) { this._setState('disconnected'); return; }
    const canRetry = (wasSynced || reconnecting) && this._reconnectAttempt < MAX_RECONNECTS;
    if (message) this._note(message);
    if (!canRetry) { this._setState('disconnected'); this.dispatchEvent(new CustomEvent('error', { detail: message ?? 'Disconnected' })); return; }
    this._reconnectAttempt++;
    const delay = Math.min(30_000, 2 ** this._reconnectAttempt * 1000);
    this._resetRoster();           // the server issues a new session id; keeping the old roster shows a ghost "old me"
    this._setState('reconnecting');
    this._diag('connection', `reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})`);
    setTimeout(() => { if (!this._intentional && !this._ws) this._open(); }, delay);
  }

  _resetRoster() { this.channels.clear(); this.users.clear(); this.me = null; this._emit('channels'); this._emit('users'); }

  _startTimers() {
    this._lastRx = Date.now();
    this._timers.ping = setInterval(() => {
      this._send(pingMessage(Date.now() * 1000));
      // Silence watchdog: the socket won't always error when we walk out of range.
      if (Date.now() - this._lastRx > WATCHDOG_MS) { this._diag('connection', 'server went silent — dropping'); this._fail('The server stopped responding.'); }
    }, 5000);
    this._timers.talk = setInterval(() => {
      const now = Date.now();
      for (const [s, t] of this._talkers) if (now - t > 250) this._setTalking(s, false);
    }, 100);
  }

  // ---- inbound ----

  _handle({ type, payload }) {
    if (type === MessageType.udpTunnel) return this._voice(payload);
    const m = decode(type, payload);
    switch (type) {
      case MessageType.version:
        this.serverInfo.version = m; this.wireFormat = wireFormatFor(m);
        this._diag('connection', `server ${m.release ?? ''} (${this.wireFormat} voice)`); break;
      case MessageType.reject: {
        const reason = m.reason || REJECT_REASONS[m.type] || 'Rejected';
        // Our own ghost session usually still holds the name after an unclean drop.
        if (m.type === REJECT_USERNAME_IN_USE && this._reconnectAttempt > 0) {
          this._usernameInUseRetries++;
          if (this._usernameInUseRetries >= 2) this._usernameOverride = `${this._target.username}${this._usernameInUseRetries}`;
          this._fail(reason); return;
        }
        this._intentional = true; this._teardown(); this._setState('disconnected');
        this.dispatchEvent(new CustomEvent('error', { detail: reason })); return;
      }
      case MessageType.channelState: {
        const prev = this.channels.get(m.channelId) ?? {};
        this.channels.set(m.channelId, { ...prev, ...m, parent: m.parent ?? prev.parent ?? (m.channelId === 0 ? undefined : 0) });
        this._emit('channels'); break;
      }
      case MessageType.channelRemove: this.channels.delete(m.channelId); this._emit('channels'); break;
      case MessageType.userState: {
        const prev = this.users.get(m.session);
        const next = { ...prev, ...m, channelId: m.channelId ?? prev?.channelId ?? 0 };
        this.users.set(m.session, next);
        if (this.isConnected) {
          if (!prev) this._notice(`${next.name} connected`, 'join');
          else if (m.channelId !== undefined && prev.channelId !== m.channelId) this._notice(`${next.name} moved to ${this.channels.get(m.channelId)?.name ?? 'a channel'}`, 'move');
        }
        this._emit('users'); break;
      }
      case MessageType.userRemove: {
        const gone = this.users.get(m.session);
        this.users.delete(m.session); this._talkers.delete(m.session);
        if (gone && this.isConnected) this._notice(`${gone.name} ${m.ban ? 'was banned' : m.actor !== undefined ? 'was kicked' : 'disconnected'}`, 'leave');
        this._emit('users'); break;
      }
      case MessageType.serverSync:
        this.me = m.session;
        this._reconnectAttempt = 0; this._usernameInUseRetries = 0; this._usernameOverride = null;
        Object.assign(this.serverInfo, { welcomeText: m.welcomeText, maxBandwidth: m.maxBandwidth, permissions: m.permissions });
        this._setState('connected');
        this._startTimers();
        if (m.welcomeText) this._pushMessage({ senderName: 'Server', html: m.welcomeText, scope: { system: true } });
        this._emit('users'); this._emit('channels');
        break;
      case MessageType.serverConfig: Object.assign(this.serverInfo, m); this._emit('server'); break;
      case MessageType.codecVersion: this.serverInfo.opus = m.opus; break;
      case MessageType.permissionQuery: {
        const c = this.channels.get(m.channelId); if (c) { c.permissions = m.permissions; this._emit('channels'); } break;
      }
      case MessageType.textMessage: {
        const sender = this.users.get(m.actor);
        this._pushMessage({ senderSession: m.actor, senderName: sender?.name ?? 'Server', html: m.message ?? '', scope: m.sessions?.length ? { sessions: m.sessions } : m.treeIds?.length ? { treeId: m.treeIds[0] } : { channelId: m.channelIds?.[0] ?? 0 }, own: false });
        break;
      }
      case MessageType.permissionDenied: {
        const what = m.type === DenyType.text ? (m.reason || 'Not allowed') : `${DENY_TEXT[m.type] ?? 'Not allowed'}${m.reason ? ` — ${m.reason}` : ''}`;
        this._note(what);
        // murmur answers an oversized TextMessage with TextTooLong and nothing else, so the
        // bubble we echoed locally is the one that never went out.
        if (m.type === DenyType.textTooLong && this._lastOwn) { this._lastOwn.failed = what; this._emit('text-failed', this._lastOwn); }
        break;
      }
      case MessageType.ping: {
        if (m.timestamp) { const rtt = Date.now() - Number(BigInt(m.timestamp) / 1000n); if (rtt >= 0 && rtt < 60000) { this.stats.samples.push(rtt); if (this.stats.samples.length > 10) this.stats.samples.shift(); this.stats.tcpPingMs = Math.round(this.stats.samples.reduce((a, b) => a + b, 0) / this.stats.samples.length); this._emit('stats'); } }
        break;
      }
      case MessageType.userStats: this.dispatchEvent(new CustomEvent('user-stats', { detail: m })); break;
      case MessageType.pluginDataTransmission:
        if (m.data) this.dispatchEvent(new CustomEvent('plugin', { detail: { sender: m.senderSession, dataId: m.dataId, data: m.data } }));
        break;
    }
  }

  _voice(payload) {
    const p = decodeVoice(payload, this.wireFormat);
    if (!p || p.kind !== 'audio') return;
    const u = this.users.get(p.session);
    if (!u || u.localMute) return;
    // A long arrival gap while the sender's frame counter kept climbing is a delivery stall
    // (TCP retransmit, blocked main thread), not a pause in speech.
    const now = Date.now(), last = this._lastPacket.get(p.session), frame = Number(p.frameNumber);
    if (last && now - last.at > 250 && frame - last.frame >= 20) { this.stats.stalls++; this._diag('voice', `${u.name}: ${now - last.at} ms delivery stall (${frame - last.frame} frames arrived late)`); }
    this._lastPacket.set(p.session, { at: now, frame });
    this._talkers.set(p.session, Date.now());
    if (!u.talking) this._setTalking(p.session, true);
    this.dispatchEvent(new CustomEvent('voice', { detail: p }));
    if (p.isTerminator) this._setTalking(p.session, false);
  }

  _setTalking(session, on) {
    const u = this.users.get(session);
    if (!u || !!u.talking === on) { if (!on) this._talkers.delete(session); return; }
    u.talking = on;
    if (!on) this._talkers.delete(session);
    this.dispatchEvent(new CustomEvent('talking', { detail: { session, talking: on } }));
  }

  // ---- state / events ----

  _setState(s) { if (this.state !== s) { this.state = s; this._diag('connection', `state → ${s}`); this._emit('state'); } }
  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  _pushMessage(m) {
    const msg = { id: crypto.randomUUID(), date: new Date(), ...m };
    if (msg.own) this._lastOwn = msg;
    this.messages.push(msg);
    if (this.messages.length > 2000) this.messages.shift();
    this.dispatchEvent(new CustomEvent('text', { detail: msg }));
  }
  /// A toast is gone in three seconds, so who came and went also goes into the timeline as a
  /// system line and into the diagnostics log, which is where you look afterwards.
  _notice(text, kind) {
    this.dispatchEvent(new CustomEvent('notice', { detail: { text, kind } }));
    if (kind === 'join' || kind === 'leave' || kind === 'move') {
      this._diag('presence', text);
      this._pushMessage({ senderName: 'Server', html: text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])), scope: { system: true } });
    }
  }
  _note(text) { this._notice(text, 'info'); this._diag('connection', text); }
  _diag(tag, message) {
    this.log.push({ date: new Date(), tag, message });
    if (this.log.length > 400) this.log.shift();
    this.dispatchEvent(new CustomEvent('log'));
  }
}
