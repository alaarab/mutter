// Screen share. Video goes peer to peer over WebRTC — one connection from the sharer to each
// viewer — because the Mumble server only gives us a 1000-byte, few-per-second side channel
// (PluginDataTransmission). That channel carries the signaling; see docs/screen-share.md.

import { DATA_ID, encodeSignal, SignalAssembler } from '../src/rtcsignal.js';

const ANNOUNCE_MS = 10_000;      // sharer repeats its announce for late arrivals
const EXPIRE_MS = 25_000;        // viewer forgets a share it hasn't heard about for this long
const GATHER_MS = 1500;          // vanilla ICE: wait this long for candidates, then send one SDP
const CODEC_ORDER = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8'];
// murmur allows a burst of 15 then 4/s; we stay under both so nothing is silently dropped.
const BUCKET = { burst: 12, rate: 3 };

export class ScreenShare extends EventTarget {
  constructor(client, settings) {
    super();
    this.client = client;
    this.settings = settings;
    this.sharing = null;           // { id, stream, title, w, h, audio, contentHint, peers, announced, lastAnnounce }
    this.available = new Map();    // sender session → { id, title, w, h, audio, at }
    this.watching = null;          // { sender, id, pc, stream, state, stats }
    this._assembler = new SignalAssembler();
    this._msgId = 0;
    this._queue = []; this._tokens = BUCKET.burst; this._tokensAt = Date.now(); this._pump = null;
    client.addEventListener('plugin', e => this._onPlugin(e.detail));
    client.addEventListener('users', () => this._onUsers());
    client.addEventListener('state', () => { if (client.state !== 'connected') this._teardown(); });
    setInterval(() => this._tick(), 1000);
  }

  static get supported() { return !!(globalThis.RTCPeerConnection && navigator.mediaDevices?.getDisplayMedia); }

  /// Starts sharing. Omit `stream` to open the browser's picker. `contentHint` 'detail' favours
  /// resolution (text, code); 'motion' favours frame rate (video, games).
  async start({ stream, contentHint = 'detail' } = {}) {
    if (this.sharing) return;
    if (!stream) {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'include',
      });
    }
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('No video track');
    track.contentHint = contentHint;
    const s = track.getSettings();
    this.sharing = {
      id: crypto.randomUUID().slice(0, 8), stream, contentHint, peers: new Map(), announced: new Set(), lastAnnounce: 0,
      title: prettyTitle(track.label), w: s.width ?? 0, h: s.height ?? 0, audio: stream.getAudioTracks().length > 0,
    };
    track.addEventListener('ended', () => this.stop());     // the browser's own "Stop sharing" button
    this._diag(`sharing ${this.sharing.title} ${this.sharing.w}×${this.sharing.h}${this.sharing.audio ? ' with audio' : ''}`);
    this._announce();
    this._emit('state');
  }

  stop() {
    const s = this.sharing;
    if (!s) return;
    this.sharing = null;
    for (const pc of s.peers.values()) pc.close();
    s.stream.getTracks().forEach(t => t.stop());
    this._send([...s.announced], { t: 'stop', id: s.id });
    this._diag('stopped sharing');
    this._emit('state');
  }

  setContentHint(hint) {
    const s = this.sharing;
    if (!s) return;
    s.contentHint = hint;
    s.stream.getVideoTracks()[0].contentHint = hint;
    for (const pc of s.peers.values()) for (const tx of pc.getTransceivers()) if (tx.sender.track?.kind === 'video') this._tune(tx, hint);
    this._emit('state');
  }

  get viewerCount() { return this.sharing ? [...this.sharing.peers.values()].filter(pc => pc.connectionState === 'connected').length : 0; }

  async watch(sender) {
    const a = this.available.get(sender);
    if (!a) return;
    this.unwatch(false);
    const pc = this._pc();
    const w = { sender, id: a.id, pc, stream: new MediaStream(), state: 'connecting', stats: { fps: 0, kbps: 0, w: 0, h: 0, codec: '' }, _bytes: 0, _at: performance.now() };
    this.watching = w;
    pc.ontrack = e => { w.stream.addTrack(e.track); this._emit('stream'); };
    pc.onconnectionstatechange = () => {
      if (this.watching !== w) return;
      w.state = pc.connectionState;
      this._diag(`viewer connection ${w.state}`);
      this._emit('state');
    };
    this._send([sender], { t: 'watch', id: a.id });
    this._emit('state');
  }

  unwatch(emit = true) {
    const w = this.watching;
    if (!w) return;
    this.watching = null;
    w.pc.close();
    this._send([w.sender], { t: 'leave', id: w.id });
    if (emit) this._emit('state');
  }

  // ---- peers ----

  _pc() {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const t = this.settings.turn;
    if (t?.url) iceServers.push({ urls: t.url, username: t.username || undefined, credential: t.credential || undefined });
    return new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  }

  async _offer(viewer, m) {
    const s = this.sharing;
    if (!s || s.id !== m.id) return;
    s.peers.get(viewer)?.close();
    const pc = this._pc();
    s.peers.set(viewer, pc);
    for (const track of s.stream.getTracks()) {
      const tx = pc.addTransceiver(track, { direction: 'sendonly', streams: [s.stream] });
      if (track.kind === 'video') this._tune(tx, s.contentHint);
    }
    pc.onconnectionstatechange = () => {
      if (s.peers.get(viewer) !== pc) return;
      this._diag(`viewer ${viewer} ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') s.peers.delete(viewer);
      this._emit('state');
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      this._send([viewer], { t: 'offer', id: s.id, sdp: pc.localDescription.sdp });
    } catch (e) { this._diag(`offer failed: ${e.message}`); pc.close(); s.peers.delete(viewer); }
  }

  async _answer(sender, m) {
    const w = this.watching;
    if (!w || w.sender !== sender || w.id !== m.id) return;
    try {
      await w.pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await w.pc.setLocalDescription(await w.pc.createAnswer());
      await gathered(w.pc);
      this._send([sender], { t: 'answer', id: m.id, sdp: w.pc.localDescription.sdp });
    } catch (e) { this._diag(`answer failed: ${e.message}`); w.state = 'failed'; this._emit('state'); }
  }

  _tune(tx, hint) {
    try {
      const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
      const preferred = CODEC_ORDER.flatMap(mime => caps.filter(c => c.mimeType === mime));
      const rest = caps.filter(c => !preferred.includes(c));
      if (preferred.length) tx.setCodecPreferences([...preferred, ...rest]);
    } catch {}
    const apply = async () => {
      try {
        const p = tx.sender.getParameters();
        if (!p.encodings?.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = 6_000_000;
        p.encodings[0].maxFramerate = hint === 'motion' ? 60 : 30;
        p.degradationPreference = hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
        await tx.sender.setParameters(p);
      } catch (e) { this._diag(`sender parameters: ${e.message}`); }
    };
    apply();
  }

  // ---- signaling ----

  async _onPlugin({ sender, dataId, data }) {
    if (dataId !== DATA_ID) return;
    const m = await this._assembler.push(sender, data);
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'announce': {
        const fresh = !this.available.has(sender);
        this.available.set(sender, { id: m.id, title: m.title, w: m.w, h: m.h, audio: !!m.audio, at: Date.now() });
        this._emit('available', { sender, fresh });
        break;
      }
      case 'stop':
        if (this.available.get(sender)?.id === m.id) { this.available.delete(sender); this._emit('available', { sender, ended: true }); }
        if (this.watching?.sender === sender) { this.watching.pc.close(); this.watching = null; this._emit('state'); }
        break;
      case 'watch': await this._offer(sender, m); break;
      case 'offer': await this._answer(sender, m); break;
      case 'answer': {
        const pc = this.sharing?.peers.get(sender);
        if (pc && this.sharing.id === m.id) await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch(e => this._diag(`answer rejected: ${e.message}`));
        break;
      }
      case 'leave': {
        const pc = this.sharing?.peers.get(sender);
        if (pc) { pc.close(); this.sharing.peers.delete(sender); this._emit('state'); }
        break;
      }
      case 'ice': {
        const pc = this.watching?.sender === sender ? this.watching.pc : this.sharing?.peers.get(sender);
        if (pc && Array.isArray(m.c)) for (const c of m.c) pc.addIceCandidate(c).catch(() => {});
        break;
      }
    }
  }

  _members() {
    const me = this.client.myUser;
    return me ? this.client.usersIn(me.channelId).filter(u => u.session !== this.client.me).map(u => u.session) : [];
  }

  _announce(to = this._members()) {
    const s = this.sharing;
    if (!s || !to.length) return;
    for (const r of to) s.announced.add(r);
    s.lastAnnounce = Date.now();
    this._send(to, { t: 'announce', id: s.id, title: s.title, w: s.w, h: s.h, audio: s.audio });
  }

  _onUsers() {
    const s = this.sharing;
    if (s) {
      const fresh = this._members().filter(m => !s.announced.has(m));
      if (fresh.length) this._announce(fresh);
      for (const [v, pc] of s.peers) if (!this.client.users.has(v)) { pc.close(); s.peers.delete(v); this._emit('state'); }
    }
    if (this.watching && !this.client.users.has(this.watching.sender)) { this.watching.pc.close(); this.watching = null; this._emit('state'); }
    for (const v of [...this.available.keys()]) if (!this.client.users.has(v)) { this.available.delete(v); this._emit('available', { sender: v, ended: true }); }
  }

  _tick() {
    const now = Date.now();
    if (this.sharing && now - this.sharing.lastAnnounce > ANNOUNCE_MS) this._announce();
    for (const [v, a] of this.available) if (now - a.at > EXPIRE_MS) { this.available.delete(v); this._emit('available', { sender: v, ended: true }); }
    if (this.watching) this._pollStats();
  }

  async _pollStats() {
    const w = this.watching;
    try {
      const report = await w.pc.getStats();
      const codecs = new Map();
      let inbound;
      report.forEach(r => { if (r.type === 'codec') codecs.set(r.id, r.mimeType); if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r; });
      if (!inbound || this.watching !== w) return;
      const now = performance.now(), dt = (now - w._at) / 1000;
      w.stats = {
        fps: Math.round(inbound.framesPerSecond ?? 0), w: inbound.frameWidth ?? 0, h: inbound.frameHeight ?? 0,
        kbps: dt > 0 ? Math.round((inbound.bytesReceived - w._bytes) * 8 / dt / 1000) : 0,
        codec: (codecs.get(inbound.codecId) ?? '').replace('video/', ''),
      };
      w._bytes = inbound.bytesReceived; w._at = now;
      this._emit('stats');
    } catch {}
  }

  /// Rate-limited outbox: fragments go out in order, never faster than the server tolerates.
  async _send(receivers, obj) {
    receivers = receivers.filter(r => this.client.users.has(r));
    if (!receivers.length || !this.client.isConnected) return;
    const fragments = await encodeSignal(obj, this._msgId++);
    for (const data of fragments) this._queue.push({ receivers, data });
    this._drain();
  }

  _drain() {
    const now = Date.now();
    this._tokens = Math.min(BUCKET.burst, this._tokens + (now - this._tokensAt) / 1000 * BUCKET.rate);
    this._tokensAt = now;
    while (this._queue.length && this._tokens >= 1) {
      const m = this._queue.shift();
      this._tokens -= 1;
      this.client.sendPlugin(m.receivers, DATA_ID, m.data);
    }
    if (this._queue.length && !this._pump) this._pump = setTimeout(() => { this._pump = null; this._drain(); }, 1000 / BUCKET.rate);
  }

  _teardown() {
    const s = this.sharing;
    if (s) { this.sharing = null; for (const pc of s.peers.values()) pc.close(); s.stream.getTracks().forEach(t => t.stop()); }
    if (this.watching) { this.watching.pc.close(); this.watching = null; }
    this.available.clear();
    this._queue.length = 0;
    this._emit('state'); this._emit('available', {});
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  _diag(m) { this.client._diag('share', m); }
}

// Chrome labels display tracks "screen:0:0", "window:1234:0", "web-contents-media-stream://…";
// canvas tracks get an opaque id. None of those are titles a person wants to read.
const prettyTitle = label =>
  /^screen/i.test(label) ? 'Screen' : /^window/i.test(label) ? 'Window' : /^web-contents/i.test(label) ? 'Tab'
  : (!label || /^[\w-]{16,}$/.test(label)) ? 'Screen' : label.slice(0, 60);

const gathered = pc => pc.iceGatheringState === 'complete' ? Promise.resolve() : new Promise(resolve => {
  const timer = setTimeout(done, GATHER_MS);
  function done() { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); }
  function check() { if (pc.iceGatheringState === 'complete') done(); }
  pc.addEventListener('icegatheringstatechange', check);
});
