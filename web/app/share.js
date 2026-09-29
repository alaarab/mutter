import { DATA_ID, encodeSignal, SignalAssembler } from '../src/rtcsignal.js';

const GATHER_MS = 2500;
const TRICKLE_MS = 250;
const PROBE_MS = 8000;
const STATS_INTERVAL_MS = 1000;
const MAX_BITRATE = 6_000_000;
const CAMERA_MAX_BITRATE = 900_000;
const CAMERA_VIDEO = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } };
const CODEC_ORDER = ['video/H264', 'video/VP9', 'video/AV1', 'video/VP8'];
const BUCKET = { burst: 12, rate: 3 };
const WATCH_BUCKET = { burst: 4, rate: 0.5 };
const MAX_QUEUED_FRAGMENTS = 60;
const ENDED_CONNECTION_STATES = new Set(['failed', 'disconnected', 'closed']);
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
  camera = null;
  canFlip = false;
  available = new Map();
  cameras = new Map();
  watching = null;
  feeds = new Map();

  #assembler = new SignalAssembler();
  #peerState = new WeakMap();
  #nextMessageId = 0;
  #queue = [];
  #tokens = BUCKET.burst;
  #tokensAt = Date.now();
  #pump = null;
  #ownSample = { bytes: 0, at: 0, lastLimit: null };
  #viewerSample = { bytes: 0, at: 0 };
  #cameraGeneration = 0;
  #cameraStart = null;
  #flipping = null;
  #watchTokens = new Map();

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

  static get cameraSupported() {
    return !!(globalThis.RTCPeerConnection && navigator.mediaDevices?.getUserMedia);
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
      kind: 'screen',
      maxBitrate: MAX_BITRATE,
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
    this.#announceSource(this.sharing);
    this.#emit('state');
  }

  startCamera() {
    if (this.camera) {
      return Promise.resolve();
    }
    if (!this.#cameraStart) {
      const starting = this.#openCamera().finally(() => {
        if (this.#cameraStart === starting) {
          this.#cameraStart = null;
        }
      });
      this.#cameraStart = starting;
    }
    return this.#cameraStart;
  }

  async #openCamera() {
    const generation = this.#cameraGeneration;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...CAMERA_VIDEO, facingMode: 'user' }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (generation !== this.#cameraGeneration || !track) {
      stream.getTracks().forEach((unused) => unused.stop());
      if (!track) {
        throw new Error('No camera track');
      }
      return;
    }
    track.contentHint = 'motion';
    const camera = {
      id: crypto.randomUUID().slice(0, 8),
      kind: 'camera',
      maxBitrate: CAMERA_MAX_BITRATE,
      stream,
      contentHint: 'motion',
      peers: new Map(),
      announced: new Set(),
      title: 'Camera',
      w: 0,
      h: 0,
      audio: false,
      stats: null,
    };
    this.camera = camera;
    this.#watchTrackEnd(camera, track);
    const canFlip = (await this.#videoInputs()).length > 1;
    if (this.camera !== camera) {
      return;
    }
    this.canFlip = canFlip;
    this.#diag('camera on');
    this.#announceSource(camera);
    this.#emit('state');
  }

  stopCamera() {
    this.#cameraGeneration++;
    this.#cameraStart = null;
    const camera = this.camera;
    if (!camera) {
      return;
    }
    this.camera = null;
    this.#endShare(camera);
    this.#send([...camera.announced], { t: 'stop', id: camera.id });
    this.#diag('camera off');
    this.#emit('state');
  }

  flipCamera() {
    if (!this.#flipping) {
      this.#flipping = this.#flipToNextCamera().finally(() => {
        this.#flipping = null;
      });
    }
    return this.#flipping;
  }

  async #flipToNextCamera() {
    const camera = this.camera;
    if (!camera) {
      return;
    }
    const inputs = await this.#videoInputs();
    if (this.camera !== camera || inputs.length < 2) {
      return;
    }
    const current = camera.stream.getVideoTracks()[0];
    const index = inputs.findIndex((device) => device.deviceId === current?.getSettings().deviceId);
    const next = inputs[(index + 1) % inputs.length];
    const stream = await navigator.mediaDevices.getUserMedia({ video: { ...CAMERA_VIDEO, deviceId: { exact: next.deviceId } }, audio: false });
    const track = stream.getVideoTracks()[0];
    if (this.camera !== camera || !track) {
      stream.getTracks().forEach((unused) => unused.stop());
      return;
    }
    track.contentHint = 'motion';
    const replaced = camera.stream.getVideoTracks()[0];
    if (replaced) {
      camera.stream.removeTrack(replaced);
      replaced.stop();
    }
    camera.stream.addTrack(track);
    this.#watchTrackEnd(camera, track);
    for (const peer of camera.peers.values()) {
      for (const sender of peer.getSenders()) {
        await sender.replaceTrack(track).catch(() => {});
      }
    }
    if (this.camera === camera) {
      this.#emit('state');
    }
  }

  watchCamera(sender) {
    const offer = this.cameras.get(sender);
    if (!offer || this.feeds.has(sender)) {
      return;
    }
    const connection = this.#newPeer();
    const feed = { sender, id: offer.id, pc: connection, stream: new MediaStream(), state: 'connecting' };
    this.feeds.set(sender, feed);
    connection.ontrack = (event) => {
      feed.stream.addTrack(event.track);
      this.#emit('feed', { sender });
    };
    connection.onconnectionstatechange = () => {
      if (this.feeds.get(sender) !== feed) {
        return;
      }
      feed.state = connection.connectionState;
      if (feed.state === 'failed') {
        this.#explainPath(connection, `camera ${sender}`);
      }
      this.#emit('feed', { sender });
    };
    this.#send([sender], { t: 'watch', id: offer.id });
  }

  unwatchCamera(sender, notify = true) {
    const feed = this.feeds.get(sender);
    if (!feed) {
      return;
    }
    this.feeds.delete(sender);
    feed.pc.close();
    if (notify) {
      this.#send([sender], { t: 'leave', id: feed.id });
    }
    this.#emit('feed', { sender });
  }

  unwatchAllCameras() {
    for (const sender of [...this.feeds.keys()]) {
      this.unwatchCamera(sender);
    }
  }

  #watchTrackEnd(camera, track) {
    track.addEventListener('ended', () => {
      if (this.camera === camera && camera.stream.getVideoTracks()[0] === track) {
        this.stopCamera();
      }
    });
  }

  async #videoInputs() {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  #sources() {
    return [this.sharing, this.camera].filter(Boolean);
  }

  #sourceFor(id) {
    return this.#sources().find((source) => source.id === id) ?? null;
  }

  #viewerFor(sender, id) {
    if (this.watching?.sender === sender && this.watching.id === id) {
      return this.watching;
    }
    const feed = this.feeds.get(sender);
    return feed?.id === id ? feed : null;
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
          this.#tuneVideo(transceiver, hint, share.maxBitrate);
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
    const current = this.watching;
    if (current?.sender === sender && current.id === offer.id && !ENDED_CONNECTION_STATES.has(current.state)) {
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
    if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 4096) {
      return;
    }
    if (connection.remoteDescription) {
      connection.addIceCandidate(candidate).catch((error) => this.#diag(`candidate rejected: ${error.message}`));
    } else {
      const pending = this.#stateOf(connection)?.pendingIce;
      if (pending && pending.length < 256) {
        pending.push(candidate);
      }
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
    const source = this.#sourceFor(message.id);
    if (!source) {
      return;
    }
    if (!this.#isChannelMember(viewer)) {
      this.#diag(`ignored a watch request from ${viewer}: not in this channel`);
      return;
    }
    if (!this.#takeWatchToken(viewer)) {
      return;
    }
    source.announced.add(viewer);
    this.#closePeer(source, viewer);
    const connection = this.#newPeer();
    source.peers.set(viewer, connection);
    const isCurrent = () => this.#sourceFor(source.id) === source && source.peers.get(viewer) === connection;
    for (const track of [...source.stream.getVideoTracks(), ...source.stream.getAudioTracks()]) {
      const transceiver = connection.addTransceiver(track, { direction: 'sendonly', streams: [source.stream] });
      if (track.kind === 'video') {
        this.#tuneVideo(transceiver, source.contentHint, source.maxBitrate);
      }
    }
    connection.onconnectionstatechange = () => {
      if (source.peers.get(viewer) !== connection) {
        return;
      }
      const state = connection.connectionState;
      this.#diag(`${source.kind} viewer ${viewer} ${state}`);
      if (state === 'connected' || state === 'failed') {
        this.#explainPath(connection, `${source.kind}→${viewer}`);
      }
      if (state === 'failed' || state === 'closed') {
        source.peers.delete(viewer);
      }
      this.#emit('state');
    };
    try {
      this.#trickleCandidates(connection, viewer, source.id);
      const offer = await connection.createOffer();
      if (!isCurrent()) {
        return;
      }
      await connection.setLocalDescription(offer);
      if (!isCurrent()) {
        return;
      }
      await waitForGathering(connection);
      if (!isCurrent()) {
        return;
      }
      this.#stateOf(connection).sdpSent = true;
      this.#send([viewer], { t: 'offer', id: source.id, sdp: connection.localDescription.sdp }, `offer:${viewer}:${source.id}`);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      this.#diag(`offer failed: ${error.message}`);
      this.#closePeer(source, viewer);
    }
  }

  async #answer(sender, message) {
    const viewer = this.#viewerFor(sender, message.id);
    if (!viewer) {
      return;
    }
    const connection = viewer.pc;
    const isCurrent = () => this.#viewerFor(sender, message.id) === viewer && viewer.pc === connection;
    try {
      this.#trickleCandidates(connection, sender, message.id);
      await connection.setRemoteDescription({ type: 'offer', sdp: message.sdp });
      if (!isCurrent()) {
        return;
      }
      this.#flushCandidates(connection);
      if (this.settings.shareAudio === false) {
        for (const transceiver of connection.getTransceivers()) {
          if (transceiver.receiver.track?.kind === 'audio') {
            transceiver.stop();
          }
        }
      }
      const answer = await connection.createAnswer();
      if (!isCurrent()) {
        return;
      }
      await connection.setLocalDescription(answer);
      if (!isCurrent()) {
        return;
      }
      await waitForGathering(connection);
      if (!isCurrent()) {
        return;
      }
      this.#stateOf(connection).sdpSent = true;
      this.#send([sender], { t: 'answer', id: message.id, sdp: connection.localDescription.sdp }, `answer:${sender}:${message.id}`);
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      this.#diag(`answer failed: ${error.message}`);
      viewer.state = 'failed';
      this.#emit(viewer === this.watching ? 'state' : 'feed', { sender });
    }
  }

  #isChannelMember(session) {
    const me = this.client.myUser;
    const user = this.client.users.get(session);
    return !!me && !!user && session !== this.client.me && (user.channelId ?? 0) === (me.channelId ?? 0);
  }

  #takeWatchToken(viewer) {
    const now = Date.now();
    const bucket = this.#watchTokens.get(viewer) ?? { tokens: WATCH_BUCKET.burst, at: now, warned: false };
    bucket.tokens = Math.min(WATCH_BUCKET.burst, bucket.tokens + ((now - bucket.at) / 1000) * WATCH_BUCKET.rate);
    bucket.at = now;
    this.#watchTokens.set(viewer, bucket);
    if (bucket.tokens < 1) {
      if (!bucket.warned) {
        bucket.warned = true;
        this.#diag(`ignoring watch requests from ${viewer} for a while: too many in a row`);
      }
      return false;
    }
    bucket.tokens -= 1;
    bucket.warned = false;
    return true;
  }

  #tuneVideo(transceiver, hint, maxBitrate) {
    try {
      const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
      const preferred = CODEC_ORDER.flatMap((mime) => codecs.filter((codec) => codec.mimeType === mime));
      const rest = codecs.filter((codec) => !preferred.includes(codec));
      if (preferred.length) {
        transceiver.setCodecPreferences([...preferred, ...rest]);
      }
    } catch {}
    this.#applyEncoding(transceiver.sender, hint, maxBitrate);
  }

  async #applyEncoding(sender, hint, maxBitrate) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) {
        parameters.encodings = [{}];
      }
      parameters.encodings[0].maxBitrate = maxBitrate;
      parameters.encodings[0].maxFramerate = hint === 'motion' ? 60 : 30;
      parameters.degradationPreference = hint === 'motion' ? 'maintain-framerate' : 'balanced';
      await sender.setParameters(parameters);
    } catch (error) {
      this.#diag(`sender parameters: ${error.message}`);
    }
  }

  async #onPlugin({ sender, dataId, data }) {
    if (dataId !== DATA_ID || !this.client.users.has(sender)) {
      return;
    }
    const message = await this.#assembler.push(sender, data);
    if (!message || typeof message.t !== 'string' || typeof message.id !== 'string' || !message.id || message.id.length > 256) {
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
        this.#onLeave(sender, message);
        break;
      case 'ice':
        this.#onIce(sender, message);
        break;
      default:
        break;
    }
  }

  #onAnnounce(sender, message) {
    if (!this.#isChannelMember(sender)) {
      return;
    }
    if (message.kind === 'camera') {
      const fresh = this.cameras.get(sender)?.id !== message.id;
      this.cameras.set(sender, { id: message.id });
      if (fresh) {
        this.unwatchCamera(sender, false);
      }
      this.#emit('cameras', { sender, fresh });
      return;
    }
    const fresh = !this.available.has(sender);
    this.available.set(sender, {
      id: message.id,
      title: typeof message.title === 'string' ? message.title.slice(0, 512) : 'Screen',
      w: message.w,
      h: message.h,
      audio: !!message.audio,
    });
    this.#emit('available', { sender, fresh });
  }

  #onStop(sender, message) {
    if (this.cameras.get(sender)?.id === message.id) {
      this.cameras.delete(sender);
      this.unwatchCamera(sender, false);
      this.#emit('cameras', { sender, ended: true });
      return;
    }
    if (this.available.get(sender)?.id === message.id) {
      this.available.delete(sender);
      this.#emit('available', { sender, ended: true });
    }
    if (this.watching?.sender === sender && this.watching.id === message.id) {
      this.#dropViewer();
    }
  }

  async #onAnswer(sender, message) {
    const connection = this.#sourceFor(message.id)?.peers.get(sender);
    if (!connection) {
      return;
    }
    await connection
      .setRemoteDescription({ type: 'answer', sdp: message.sdp })
      .catch((error) => this.#diag(`answer rejected: ${error.message}`));
    this.#flushCandidates(connection);
  }

  #onLeave(sender, message) {
    for (const source of this.#sources()) {
      if (source.peers.has(sender) && (message.id === undefined || source.id === message.id)) {
        this.#closePeer(source, sender);
        this.#emit('state');
      }
    }
  }

  #onIce(sender, message) {
    const connection = this.#viewerFor(sender, message.id)?.pc ?? this.#sourceFor(message.id)?.peers.get(sender) ?? null;
    if (connection && Array.isArray(message.c)) {
      for (const candidate of message.c.slice(0, 256)) {
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

  #announceSource(source, recipients = this.#channelMembers()) {
    if (!source || !recipients.length) {
      return;
    }
    for (const recipient of recipients) {
      source.announced.add(recipient);
    }
    this.#send(recipients, {
      t: 'announce',
      id: source.id,
      kind: source.kind,
      title: source.title,
      w: source.w,
      h: source.h,
      audio: source.audio,
    });
  }

  #onUsersChanged() {
    for (const session of [...this.#watchTokens.keys()]) {
      if (!this.client.users.has(session)) {
        this.#watchTokens.delete(session);
      }
    }
    if (!this.client.myUser) {
      return;
    }
    const members = new Set(this.#channelMembers());
    for (const source of this.#sources()) {
      const departed = [...source.announced].filter((session) => !members.has(session));
      for (const session of departed) {
        source.announced.delete(session);
      }
      if (departed.length) {
        this.#send(departed, { t: 'stop', id: source.id });
      }
      for (const viewer of [...source.peers.keys()]) {
        if (!members.has(viewer)) {
          this.#closePeer(source, viewer);
          this.#emit('state');
        }
      }
      const newcomers = [...members].filter((session) => !source.announced.has(session));
      if (newcomers.length) {
        this.#announceSource(source, newcomers);
      }
    }
    if (this.watching && !this.#isChannelMember(this.watching.sender)) {
      this.#dropViewer();
    }
    for (const sender of [...this.available.keys()]) {
      if (!this.#isChannelMember(sender)) {
        this.available.delete(sender);
        this.#emit('available', { sender, ended: true });
      }
    }
    for (const sender of [...this.cameras.keys()]) {
      if (!this.#isChannelMember(sender)) {
        this.cameras.delete(sender);
        this.unwatchCamera(sender, false);
        this.#emit('cameras', { sender, ended: true });
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

  async #send(receivers, message, replaces = null) {
    const online = receivers.filter((session) => this.client.users.has(session));
    if (!online.length || !this.client.isConnected) {
      return;
    }
    const messageId = this.#nextMessageId++;
    const fragments = await encodeSignal(message, messageId);
    if (replaces) {
      this.#queue = this.#queue.filter((item) => item.replaces !== replaces);
    }
    for (const data of fragments) {
      this.#queue.push({ receivers: online, data, messageId, replaces });
    }
    this.#trimQueue();
    this.#drain();
  }

  #trimQueue() {
    while (this.#queue.length > MAX_QUEUED_FRAGMENTS) {
      const oldest = this.#queue[0].messageId;
      this.#queue = this.#queue.filter((item) => item.messageId !== oldest);
      this.#diag('signalling backlog full: dropped the oldest queued message');
    }
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
    for (const source of this.#sources()) {
      this.#endShare(source);
    }
    this.#cameraGeneration++;
    this.#cameraStart = null;
    this.#watchTokens.clear();
    this.sharing = null;
    this.camera = null;
    this.#closeViewer();
    for (const feed of this.feeds.values()) {
      feed.pc.close();
    }
    this.feeds.clear();
    this.available.clear();
    this.cameras.clear();
    this.#queue.length = 0;
    this.#emit('state');
    this.#emit('available', {});
    this.#emit('cameras', {});
    this.#emit('feed', {});
  }

  #emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  #diag(message) {
    this.client.diag('share', message);
  }
}
