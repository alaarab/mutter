import { DATA_ID, encodeSignal, SignalAssembler } from '../src/rtcsignal.js';

const GATHER_MS = 2500;
const TRICKLE_MS = 250;
const PROBE_MS = 8000;
const STATS_INTERVAL_MS = 1000;
const MAX_BITRATE = 6_000_000;
const CODEC_ORDER = ['video/H264', 'video/VP9', 'video/AV1', 'video/VP8'];
const BUCKET = { burst: 12, rate: 3 };
const OPAQUE_LABEL = /^[\w+/=-]{16,}$/;

const splitList = (text) => (text ?? '').split(/[\s,]+/).filter(Boolean);

function iceConfig(settings) {
  const iceServers = [];
  const stun = splitList(settings.stun);
  if (stun.length) {
    iceServers.push({ urls: stun });
  }
  const turn = settings.turn;
  if (turn?.url) {
    iceServers.push({
      urls: splitList(turn.url),
      username: turn.username || undefined,
      credential: turn.credential || undefined,
    });
  }
  return { iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
}

export async function probeIce(settings, timeoutMs = PROBE_MS) {
  const connection = new RTCPeerConnection(iceConfig(settings));
  const found = new Map();
  const startedAt = performance.now();
  const hasTurn = !!settings.turn?.url;
  let error = null;
  try {
    connection.createDataChannel('probe');
    const finished = new Promise((resolve) => {
      connection.onicecandidate = (event) => {
        if (!event.candidate) {
          resolve('complete');
          return;
        }
        if (!found.has(event.candidate.type)) {
          found.set(event.candidate.type, event.candidate.address ?? '');
        }
      };
      connection.onicecandidateerror = (event) => {
        if (!error && event.errorCode >= 300) {
          error = `${event.url ?? 'server'} said ${event.errorCode} ${event.errorText ?? ''}`.trim();
        }
      };
      setTimeout(() => resolve('timed out'), timeoutMs);
    });
    await connection.setLocalDescription(await connection.createOffer());
    const how = await finished;
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    return { how, seconds, types: Object.fromEntries(found), error, turn: hasTurn };
  } catch (caught) {
    return { how: 'failed', seconds: '0', types: {}, error: caught.message, turn: hasTurn };
  } finally {
    connection.close();
  }
}

function prettyTitle(label) {
  if (/^screen/i.test(label)) {
    return 'Screen';
  }
  if (/^window/i.test(label)) {
    return 'Window';
  }
  if (/^web-contents/i.test(label)) {
    return 'Tab';
  }
  if (!label || OPAQUE_LABEL.test(label)) {
    return 'Screen';
  }
  return label.slice(0, 60);
}

function waitForGathering(connection) {
  if (connection.iceGatheringState === 'complete') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, GATHER_MS);
    function done() {
      clearTimeout(timer);
      connection.removeEventListener('icegatheringstatechange', check);
      resolve();
    }
    function check() {
      if (connection.iceGatheringState === 'complete') {
        done();
      }
    }
    connection.addEventListener('icegatheringstatechange', check);
  });
}

function videoStats(report, direction, sample) {
  const codecs = new Map();
  let rtp = null;
  report.forEach((entry) => {
    if (entry.type === 'codec') {
      codecs.set(entry.id, entry.mimeType);
    }
    if (entry.type === direction && entry.kind === 'video') {
      rtp = entry;
    }
  });
  if (!rtp) {
    return null;
  }
  const now = performance.now();
  const bytes = direction === 'outbound-rtp' ? rtp.bytesSent : rtp.bytesReceived;
  const seconds = (now - (sample.at || now)) / 1000;
  const stats = {
    fps: Math.round(rtp.framesPerSecond ?? 0),
    w: rtp.frameWidth ?? 0,
    h: rtp.frameHeight ?? 0,
    kbps: seconds > 0 ? Math.round(((bytes - sample.bytes) * 8) / seconds / 1000) : 0,
    codec: (codecs.get(rtp.codecId) ?? '').replace('video/', ''),
  };
  sample.bytes = bytes;
  sample.at = now;
  return { rtp, stats };
}

export class ScreenShare extends EventTarget {
  sharing = null;
  available = new Map();
  watching = null;

  #assembler = new SignalAssembler();
  #peerState = new WeakMap();
  #nextMessageId = 0;
  #queue = [];
  #tokens = BUCKET.burst;
  #tokensAt = Date.now();
  #pump = null;
  #ownSample = { bytes: 0, at: 0, lastLimit: null };
  #viewerSample = { bytes: 0, at: 0 };

  constructor(client, settings) {
    super();
    this.client = client;
    this.settings = settings;
    client.addEventListener('plugin', (event) => this.#onPlugin(event.detail));
    client.addEventListener('users', () => this.#onUsersChanged());
    client.addEventListener('state', () => {
      if (client.state !== 'connected') {
        this.#teardown();
      }
    });
    setInterval(() => this.#tick(), STATS_INTERVAL_MS);
  }

  static get supported() {
    return !!(globalThis.RTCPeerConnection && navigator.mediaDevices?.getDisplayMedia);
  }

  get viewerCount() {
    if (!this.sharing) {
      return 0;
    }
    return [...this.sharing.peers.values()].filter((peer) => peer.connectionState === 'connected').length;
  }

  async start({ stream, contentHint = 'detail' } = {}) {
    if (this.sharing) {
      return;
    }
    if (!stream) {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      });
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      throw new Error('No video track');
    }
    track.contentHint = contentHint;
    const trackSettings = track.getSettings();
    this.sharing = {
      id: crypto.randomUUID().slice(0, 8),
      stream,
      contentHint,
      peers: new Map(),
      announced: new Set(),
      title: prettyTitle(track.label),
      w: trackSettings.width ?? 0,
      h: trackSettings.height ?? 0,
      audio: stream.getAudioTracks().length > 0,
      stats: null,
    };
    this.#ownSample = { bytes: 0, at: 0, lastLimit: null };
    track.addEventListener('ended', () => this.stop());
    const { title, w, h, audio } = this.sharing;
    this.#diag(`sharing ${title} ${w}×${h}${audio ? ' with audio' : ''}`);
    this.#announce();
    this.#emit('state');
  }

  stop() {
    const share = this.sharing;
    if (!share) {
      return;
    }
    this.sharing = null;
    this.#endShare(share);
    this.#send([...share.announced], { t: 'stop', id: share.id });
    this.#diag('stopped sharing');
    this.#emit('state');
  }

  setContentHint(hint) {
    const share = this.sharing;
    if (!share) {
      return;
    }
    share.contentHint = hint;
    share.stream.getVideoTracks()[0].contentHint = hint;
    for (const peer of share.peers.values()) {
      for (const transceiver of peer.getTransceivers()) {
        if (transceiver.sender.track?.kind === 'video') {
          this.#tuneVideo(transceiver, hint);
        }
      }
    }
    this.#emit('state');
  }

  async watch(sender) {
    const offer = this.available.get(sender);
    if (!offer) {
      return;
    }
    this.unwatch(false);
    const connection = this.#newPeer();
    const viewer = {
      sender,
      id: offer.id,
      pc: connection,
      stream: new MediaStream(),
      state: 'connecting',
      stats: { fps: 0, kbps: 0, w: 0, h: 0, codec: '' },
    };
    this.watching = viewer;
    this.#viewerSample = { bytes: 0, at: performance.now() };
    connection.ontrack = (event) => {
      viewer.stream.addTrack(event.track);
      this.#emit('stream');
    };
    connection.onconnectionstatechange = () => {
      if (this.watching !== viewer) {
        return;
      }
      viewer.state = connection.connectionState;
      this.#diag(`viewer connection ${viewer.state}`);
      if (viewer.state === 'connected' || viewer.state === 'failed') {
        this.#explainPath(connection, 'viewer');
      }
      this.#emit('state');
    };
    this.#send([sender], { t: 'watch', id: offer.id });
    this.#emit('state');
  }

  unwatch(emitState = true) {
    const viewer = this.watching;
    if (!viewer) {
      return;
    }
    this.watching = null;
    viewer.pc.close();
    this.#send([viewer.sender], { t: 'leave', id: viewer.id });
    if (emitState) {
      this.#emit('state');
    }
  }

  #endShare(share) {
    for (const peer of share.peers.values()) {
      peer.close();
    }
    share.stream.getTracks().forEach((track) => track.stop());
  }

  #closePeer(share, viewer) {
    share.peers.get(viewer)?.close();
    share.peers.delete(viewer);
  }

  #closeViewer() {
    this.watching?.pc.close();
    this.watching = null;
  }

  #dropViewer() {
    if (!this.watching) {
      return;
    }
    this.#closeViewer();
    this.#emit('state');
  }

  #newPeer() {
    const connection = new RTCPeerConnection(iceConfig(this.settings));
    this.#peerState.set(connection, { sdpSent: false, pendingIce: [] });
    return connection;
  }

  #stateOf(connection) {
    return this.#peerState.get(connection);
  }

  #trickleCandidates(connection, peer, id) {
    let batch = [];
    let timer = null;
    connection.onicecandidate = (event) => {
      if (!event.candidate || !this.#stateOf(connection)?.sdpSent) {
        return;
      }
      batch.push(event.candidate.toJSON());
      if (!timer) {
        timer = setTimeout(() => {
          const candidates = batch;
          batch = [];
          timer = null;
          this.#send([peer], { t: 'ice', id, c: candidates });
        }, TRICKLE_MS);
      }
    };
  }

  #addCandidate(connection, candidate) {
    if (connection.remoteDescription) {
      connection.addIceCandidate(candidate).catch((error) => this.#diag(`candidate rejected: ${error.message}`));
    } else {
      this.#stateOf(connection)?.pendingIce.push(candidate);
    }
  }

  #flushCandidates(connection) {
    const state = this.#stateOf(connection);
    if (!state) {
      return;
    }
    for (const candidate of state.pendingIce) {
      connection.addIceCandidate(candidate).catch(() => {});
    }
    state.pendingIce = [];
  }

  async #explainPath(connection, who) {
    try {
      const report = await connection.getStats();
      const local = {};
      const remote = {};
      const byId = new Map();
      let selectedPair = null;
      report.forEach((entry) => {
        byId.set(entry.id, entry);
        if (entry.type === 'local-candidate') {
          local[entry.candidateType] = (local[entry.candidateType] ?? 0) + 1;
        }
        if (entry.type === 'remote-candidate') {
          remote[entry.candidateType] = (remote[entry.candidateType] ?? 0) + 1;
        }
        if (entry.type === 'transport' && entry.selectedCandidatePairId) {
          selectedPair = entry.selectedCandidatePairId;
        }
      });
      const describe = (counts) =>
        Object.entries(counts)
          .map(([type, count]) => `${type}×${count}`)
          .join(' ') || 'none';
      let path = '';
      const pair = selectedPair && byId.get(selectedPair);
      if (pair) {
        const localType = byId.get(pair.localCandidateId)?.candidateType ?? '?';
        const remoteType = byId.get(pair.remoteCandidateId)?.candidateType ?? '?';
        path = ` · path ${localType} → ${remoteType}`;
      }
      const noRelay = connection.connectionState === 'failed' && !local.relay ? ' · no relay (TURN) configured' : '';
      this.#diag(`${who} ${connection.connectionState}: local ${describe(local)} · remote ${describe(remote)}${path}${noRelay}`);
    } catch {}
  }

  async #offer(viewer, message) {
    const share = this.sharing;
    if (!share || share.id !== message.id) {
      return;
    }
    share.announced.add(viewer);
    this.#closePeer(share, viewer);
    const connection = this.#newPeer();
    share.peers.set(viewer, connection);
    for (const track of [...share.stream.getVideoTracks(), ...share.stream.getAudioTracks()]) {
      const transceiver = connection.addTransceiver(track, { direction: 'sendonly', streams: [share.stream] });
      if (track.kind === 'video') {
        this.#tuneVideo(transceiver, share.contentHint);
      }
    }
    connection.onconnectionstatechange = () => {
      if (share.peers.get(viewer) !== connection) {
        return;
      }
      const state = connection.connectionState;
      this.#diag(`viewer ${viewer} ${state}`);
      if (state === 'connected' || state === 'failed') {
        this.#explainPath(connection, `sharer→${viewer}`);
      }
      if (state === 'failed' || state === 'closed') {
        share.peers.delete(viewer);
      }
      this.#emit('state');
    };
    try {
      this.#trickleCandidates(connection, viewer, share.id);
      await connection.setLocalDescription(await connection.createOffer());
      await waitForGathering(connection);
      this.#stateOf(connection).sdpSent = true;
      this.#send([viewer], { t: 'offer', id: share.id, sdp: connection.localDescription.sdp });
    } catch (error) {
      this.#diag(`offer failed: ${error.message}`);
      this.#closePeer(share, viewer);
    }
  }

  async #answer(sender, message) {
    const viewer = this.watching;
    if (!viewer || viewer.sender !== sender || viewer.id !== message.id) {
      return;
    }
    const connection = viewer.pc;
    try {
      this.#trickleCandidates(connection, sender, message.id);
      await connection.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      this.#flushCandidates(connection);
      if (this.settings.shareAudio === false) {
        for (const transceiver of connection.getTransceivers()) {
          if (transceiver.receiver.track?.kind === 'audio') {
            transceiver.stop();
          }
        }
      }
      await connection.setLocalDescription(await connection.createAnswer());
      await waitForGathering(connection);
      this.#stateOf(connection).sdpSent = true;
      this.#send([sender], { t: 'answer', id: message.id, sdp: connection.localDescription.sdp });
    } catch (error) {
      this.#diag(`answer failed: ${error.message}`);
      viewer.state = 'failed';
      this.#emit('state');
    }
  }

  #tuneVideo(transceiver, hint) {
    try {
      const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
      const preferred = CODEC_ORDER.flatMap((mime) => codecs.filter((codec) => codec.mimeType === mime));
      const rest = codecs.filter((codec) => !preferred.includes(codec));
      if (preferred.length) {
        transceiver.setCodecPreferences([...preferred, ...rest]);
      }
    } catch {}
    this.#applyEncoding(transceiver.sender, hint);
  }

  async #applyEncoding(sender, hint) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) {
        parameters.encodings = [{}];
      }
      parameters.encodings[0].maxBitrate = MAX_BITRATE;
      parameters.encodings[0].maxFramerate = hint === 'motion' ? 60 : 30;
      parameters.degradationPreference = hint === 'motion' ? 'maintain-framerate' : 'balanced';
      await sender.setParameters(parameters);
    } catch (error) {
      this.#diag(`sender parameters: ${error.message}`);
    }
  }

  async #onPlugin({ sender, dataId, data }) {
    if (dataId !== DATA_ID) {
      return;
    }
    const message = await this.#assembler.push(sender, data);
    if (!message || typeof message.t !== 'string') {
      return;
    }
    switch (message.t) {
      case 'announce':
        this.#onAnnounce(sender, message);
        break;
      case 'stop':
        this.#onStop(sender, message);
        break;
      case 'watch':
        await this.#offer(sender, message);
        break;
      case 'offer':
        await this.#answer(sender, message);
        break;
      case 'answer':
        await this.#onAnswer(sender, message);
        break;
      case 'leave':
        this.#onLeave(sender);
        break;
      case 'ice':
        this.#onIce(sender, message);
        break;
      default:
        break;
    }
  }

  #onAnnounce(sender, message) {
    const fresh = !this.available.has(sender);
    this.available.set(sender, {
      id: message.id,
      title: message.title,
      w: message.w,
      h: message.h,
      audio: !!message.audio,
    });
    this.#emit('available', { sender, fresh });
  }

  #onStop(sender, message) {
    if (this.available.get(sender)?.id === message.id) {
      this.available.delete(sender);
      this.#emit('available', { sender, ended: true });
    }
    if (this.watching?.sender === sender) {
      this.#dropViewer();
    }
  }

  async #onAnswer(sender, message) {
    const connection = this.sharing?.peers.get(sender);
    if (!connection || this.sharing.id !== message.id) {
      return;
    }
    await connection
      .setRemoteDescription({ type: 'answer', sdp: message.sdp })
      .catch((error) => this.#diag(`answer rejected: ${error.message}`));
    this.#flushCandidates(connection);
  }

  #onLeave(sender) {
    if (this.sharing?.peers.has(sender)) {
      this.#closePeer(this.sharing, sender);
      this.#emit('state');
    }
  }

  #onIce(sender, message) {
    let connection = null;
    if (this.watching?.sender === sender && this.watching.id === message.id) {
      connection = this.watching.pc;
    } else if (this.sharing?.id === message.id) {
      connection = this.sharing.peers.get(sender);
    }
    if (connection && Array.isArray(message.c)) {
      for (const candidate of message.c) {
        this.#addCandidate(connection, candidate);
      }
    }
  }

  #channelMembers() {
    const me = this.client.myUser;
    if (!me) {
      return [];
    }
    return this.client
      .usersIn(me.channelId)
      .filter((user) => user.session !== this.client.me)
      .map((user) => user.session);
  }

  #announce(recipients = this.#channelMembers()) {
    const share = this.sharing;
    if (!share || !recipients.length) {
      return;
    }
    for (const recipient of recipients) {
      share.announced.add(recipient);
    }
    this.#send(recipients, { t: 'announce', id: share.id, title: share.title, w: share.w, h: share.h, audio: share.audio });
  }

  #onUsersChanged() {
    const share = this.sharing;
    if (share) {
      const newcomers = this.#channelMembers().filter((session) => !share.announced.has(session));
      if (newcomers.length) {
        this.#announce(newcomers);
      }
      for (const viewer of [...share.peers.keys()]) {
        if (!this.client.users.has(viewer)) {
          this.#closePeer(share, viewer);
          this.#emit('state');
        }
      }
    }
    if (this.watching && !this.client.users.has(this.watching.sender)) {
      this.#dropViewer();
    }
    for (const sender of [...this.available.keys()]) {
      if (!this.client.users.has(sender)) {
        this.available.delete(sender);
        this.#emit('available', { sender, ended: true });
      }
    }
  }

  #tick() {
    if (this.watching) {
      this.#pollViewerStats();
    }
    if (this.sharing) {
      this.#pollOwnStats();
    }
  }

  async #pollOwnStats() {
    const share = this.sharing;
    const connection = [...share.peers.values()].find((peer) => peer.connectionState === 'connected');
    if (!connection) {
      if (share.stats) {
        share.stats = null;
        this.#emit('stats');
      }
      return;
    }
    try {
      const report = await connection.getStats();
      if (this.sharing !== share) {
        return;
      }
      const sampled = videoStats(report, 'outbound-rtp', this.#ownSample);
      if (!sampled) {
        return;
      }
      const reason = sampled.rtp.qualityLimitationReason;
      share.stats = {
        ...sampled.stats,
        limited: reason && reason !== 'none' ? reason : null,
        encoder: sampled.rtp.encoderImplementation ?? '',
      };
      if (share.stats.limited && this.#ownSample.lastLimit !== share.stats.limited) {
        this.#diag(`encoder limited by ${share.stats.limited} (${share.stats.encoder || 'unknown encoder'})`);
      }
      this.#ownSample.lastLimit = share.stats.limited;
      this.#emit('stats');
    } catch {}
  }

  async #pollViewerStats() {
    const viewer = this.watching;
    try {
      const report = await viewer.pc.getStats();
      if (this.watching !== viewer) {
        return;
      }
      const sampled = videoStats(report, 'inbound-rtp', this.#viewerSample);
      if (!sampled) {
        return;
      }
      viewer.stats = sampled.stats;
      this.#emit('stats');
    } catch {}
  }

  async #send(receivers, message) {
    const online = receivers.filter((session) => this.client.users.has(session));
    if (!online.length || !this.client.isConnected) {
      return;
    }
    const fragments = await encodeSignal(message, this.#nextMessageId++);
    for (const data of fragments) {
      this.#queue.push({ receivers: online, data });
    }
    this.#drain();
  }

  #drain() {
    const now = Date.now();
    this.#tokens = Math.min(BUCKET.burst, this.#tokens + ((now - this.#tokensAt) / 1000) * BUCKET.rate);
    this.#tokensAt = now;
    while (this.#queue.length && this.#tokens >= 1) {
      const item = this.#queue.shift();
      this.#tokens -= 1;
      this.client.sendPlugin(item.receivers, DATA_ID, item.data);
    }
    if (this.#queue.length && !this.#pump) {
      this.#pump = setTimeout(() => {
        this.#pump = null;
        this.#drain();
      }, 1000 / BUCKET.rate);
    }
  }

  #teardown() {
    const share = this.sharing;
    if (share) {
      this.sharing = null;
      this.#endShare(share);
    }
    this.#closeViewer();
    this.available.clear();
    this.#queue.length = 0;
    this.#emit('state');
    this.#emit('available', {});
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  #diag(message) {
    this.client.diag('share', message);
  }
}
