// Voice: capture → Opus → Mumble packets, and Mumble packets → Opus → speakers.
// The browser gives us echo cancellation, noise suppression and AGC for free via getUserMedia
// constraints — the same job Apple's voice processing does on iOS.

const FRAME_MS = 20;
const FRAME_SAMPLES = 960;                 // 20 ms at 48 kHz
const FRAMES_PER_PACKET = FRAME_MS / 10;   // Mumble sequence numbers count 10 ms units
const HANGOVER_MS = 400;

const DEFAULTS = { transmitMode: 'vad', vadThresholdDb: -38, autoSensitivity: true, bitrate: 40_000, inputGain: 1, inputDeviceId: '', noiseSuppression: 'strong' };
const OPEN_FRAMES = 2;             // consecutive frames above threshold before the gate opens

export class AudioEngine extends EventTarget {
  /// `settings` is kept by reference so the app can persist it; missing keys get defaults.
  constructor(client, settings = {}) {
    super();
    this.client = client;
    for (const [k, v] of Object.entries(DEFAULTS)) settings[k] ??= v;
    this.settings = settings;
    this.inputLevelDb = -80;
    this.noiseFloorDb = -60;
    this.effectiveThresholdDb = -38;
    this.isTransmitting = false;
    this.pttPressed = false;
    this.muted = false;
    this.deafened = false;
    this.running = false;
    this.captureError = null;
    this.stats = { packetsOut: 0, packetsIn: 0, samplesOut: 0 };
    this._ctx = null; this._mixer = null; this._framer = null; this._stream = null; this._source = null;
    this._encoder = null; this._decoders = new Map(); this._gateOpen = false; this._lastVoiceAt = 0; this._closing = false;
    this._pending = []; this._ts = 0; this._levelTick = 0; this._openFrames = 0;
    client.addEventListener('voice', e => this._onVoice(e.detail));
    client.addEventListener('users', () => this._pruneDecoders());
  }

  static get supported() { return typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined' && 'audioWorklet' in AudioContext.prototype; }

  /// `source`: omit for the microphone; pass 'tone' for a built-in test signal (no permission needed).
  /// If the microphone is unavailable the engine still runs for playback and sets `captureError`.
  async start({ source } = {}) {
    if (this.running) return;
    this._ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await this._ctx.audioWorklet.addModule('/app/worklets.js');
    this._mixer = new AudioWorkletNode(this._ctx, 'mutter-mixer', { outputChannelCount: [2] });
    this._mixer.connect(this._ctx.destination);
    this._mixer.port.postMessage({ type: 'master', gain: this.deafened ? 0 : 1 });
    this._mixer.port.onmessage = ({ data }) => { if (data.type === 'health' && data.underruns) { this.stats.underruns = (this.stats.underruns ?? 0) + data.underruns; this._diag(`playback ran dry ${data.underruns}× in the last second`); } };
    this._framer = new AudioWorkletNode(this._ctx, 'mutter-framer', { numberOfInputs: 1, numberOfOutputs: 0 });
    this._framer.port.onmessage = ({ data }) => this._onFrame(data);
    this._framer.port.postMessage({ type: 'suppress', level: this.settings.noiseSuppression });

    this._encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        // One Opus packet per frame, in order, so the flag queued at encode() time is this chunk's.
        const terminator = this._pending.shift() ?? false;
        this.client.sendAudio(bytes, FRAMES_PER_PACKET, terminator);
        this.stats.packetsOut++;
        if (terminator) this._setTransmitting(false);
      },
      error: e => this._diag(`encoder error: ${e.message}`),
    });
    this._encoder.configure(this._encoderConfig());
    this.running = true;
    await this._ctx.resume();

    if (source === 'tone') {
      const osc = new OscillatorNode(this._ctx, { frequency: 440 });
      const g = new GainNode(this._ctx, { gain: 0.2 });
      osc.connect(g); osc.start(); this._source = g;
      this._source.connect(this._framer);
      this._diag('voice started (test tone)');
    } else {
      await this._openMicrophone();
    }
    this._emit('state');
  }

  async _openMicrophone() {
    this._source?.disconnect(); this._stream?.getTracks().forEach(t => t.stop());
    this._source = this._stream = null; this.captureError = null;
    const id = this.settings.inputDeviceId;
    try {
      // voiceIsolation is the platform's ML isolation where Chrome exposes it (ignored elsewhere).
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true, channelCount: 1, sampleRate: 48_000, ...(id ? { deviceId: { exact: id } } : {}) },
      });
    } catch (e) {
      if (id) { this.settings.inputDeviceId = ''; return this._openMicrophone(); }   // the remembered device is gone
      this.captureError = e.name === 'NotAllowedError' ? 'Microphone blocked' : e.name === 'NotFoundError' ? 'No microphone' : e.message;
      this._diag(`microphone unavailable: ${e.name} ${e.message} — playback only`);
      this._emit('state');
      return;
    }
    this._source = new MediaStreamAudioSourceNode(this._ctx, { mediaStream: this._stream });
    this._source.connect(this._framer);
    this._stream.getAudioTracks()[0].onended = () => { this._diag('microphone track ended'); this.captureError = 'Microphone lost'; this._emit('state'); };
    this._diag(`voice started (${this._stream.getAudioTracks()[0].label || 'microphone'})`);
    this._emit('state');
  }

  /// Switch microphones without touching playback.
  async setInputDevice(deviceId) {
    this.settings.inputDeviceId = deviceId;
    if (this.running) await this._openMicrophone();
  }

  async inputDevices() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput'); } catch { return []; }
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this._source?.disconnect(); this._framer?.disconnect();
    this._stream?.getTracks().forEach(t => t.stop());
    try { this._encoder?.close(); } catch {}
    for (const d of this._decoders.values()) { try { d.close(); } catch {} }
    this._decoders.clear();
    await this._ctx?.close();
    this._ctx = this._mixer = this._framer = this._stream = this._source = this._encoder = null;
    this._gateOpen = false; this._closing = false; this._pending = [];
    this._setTransmitting(false);
    this._emit('state');
  }

  _encoderConfig() { return { codec: 'opus', sampleRate: 48_000, numberOfChannels: 1, bitrate: this.settings.bitrate, opus: { frameDuration: FRAME_MS * 1000, application: 'voip', signal: 'voice' } }; }
  setBitrate(bps) { this.settings.bitrate = bps; if (this._encoder?.state === 'configured') this._encoder.configure(this._encoderConfig()); }
  setNoiseSuppression(level) { this.settings.noiseSuppression = level; this._framer?.port.postMessage({ type: 'suppress', level }); this._emit('state'); }
  setMuted(on) { this.muted = on; this.client.setSelfMute(on); if (on) this._closeGate(); if (!on) this.setDeafened(false, false); this._emit('state'); }
  setDeafened(on, sync = true) { this.deafened = on; this._mixer?.port.postMessage({ type: 'master', gain: on ? 0 : 1 }); if (sync) this.client.setSelfDeaf(on); if (on) { this.muted = true; this._closeGate(); } this._emit('state'); }
  setPTT(pressed) { this.pttPressed = pressed; this._emit('state'); }
  setUserVolume(session, gain) { const u = this.client.users.get(session); if (u) u.localVolume = gain; this._mixer?.port.postMessage({ type: 'gain', session, gain: u?.localMute ? 0 : gain }); }
  setUserLocalMute(session, on) { const u = this.client.users.get(session); if (u) u.localMute = on; this._mixer?.port.postMessage({ type: 'gain', session, gain: on ? 0 : (u?.localVolume ?? 1) }); }

  /// Tell the server our mute/deaf state again, e.g. after a reconnect issued a new session.
  resync() { if (this.deafened) this.client.setSelfDeaf(true); else if (this.muted) this.client.setSelfMute(true); }

  // ---- capture path ----

  _onFrame(samples) {
    if (!this.running) return;
    // Frames come every 20 ms; a gap means this thread was busy and the frames queued up.
    const t = performance.now();
    if (this._lastFrameAt && t - this._lastFrameAt > 150 && t - (this._lastStallLog ?? 0) > 2000) { this._lastStallLog = t; this.stats.captureStalls = (this.stats.captureStalls ?? 0) + 1; this._diag(`capture stalled ${Math.round(t - this._lastFrameAt)} ms — the page was busy`); }
    this._lastFrameAt = t;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) { const v = samples[i] * this.settings.inputGain; sum += v * v; }
    const db = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
    this.inputLevelDb = db;
    if ((++this._levelTick % 3) === 0) this._emit('level');

    // Noise floor (same rule as iOS): drops instantly to any quieter frame, rises at ~0.5 dB/s
    // while the gate is closed, and the auto threshold sits 12 dB above it.
    if (!this._gateOpen && db > -90) {
      this.noiseFloorDb = db < this.noiseFloorDb ? db : Math.min(db, this.noiseFloorDb + 0.5 * FRAME_MS / 1000);
      this.effectiveThresholdDb = Math.min(-15, Math.max(-60, this.noiseFloorDb + 12));
    }
    const wants = this._shouldTransmit(db);
    const now = performance.now();
    // Voice activity needs two consecutive frames above threshold, so a click doesn't open the gate.
    this._openFrames = wants ? this._openFrames + 1 : 0;
    const shouldOpen = wants && (this._gateOpen || this._openFrames >= OPEN_FRAMES || this.settings.transmitMode !== 'vad' || this.pttPressed);
    if (shouldOpen) { this._lastVoiceAt = now; if (!this._gateOpen) { this._gateOpen = true; this._setTransmitting(true); } }
    else if (this._gateOpen && now - this._lastVoiceAt > HANGOVER_MS) { this._gateOpen = false; this._closing = true; }
    if (!this._gateOpen && !this._closing) return;
    if (this._encoder?.state !== 'configured') return;
    if (this.settings.inputGain !== 1) for (let i = 0; i < samples.length; i++) samples[i] *= this.settings.inputGain;
    this._pending.push(this._closing);
    this._closing = false;
    this._encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48_000, numberOfFrames: FRAME_SAMPLES, numberOfChannels: 1, timestamp: this._ts, data: samples }));
    this._ts += FRAME_MS * 1000;
  }

  get thresholdDb() { return this.settings.autoSensitivity ? this.effectiveThresholdDb : this.settings.vadThresholdDb; }

  _shouldTransmit(db) {
    if (this.muted || !this.client.isConnected) return false;
    switch (this.settings.transmitMode) {
      case 'continuous': return true;
      case 'ptt': return this.pttPressed;
      default: return this.pttPressed || db > this.thresholdDb;
    }
  }
  _closeGate() { if (this._gateOpen) { this._gateOpen = false; this._closing = true; } }
  _setTransmitting(on) { if (this.isTransmitting !== on) { this.isTransmitting = on; this._emit('transmit'); } }

  // ---- playout path ----

  _onVoice(p) {
    if (!this.running || this.deafened) return;
    this.stats.packetsIn++;
    let dec = this._decoders.get(p.session);
    if (!dec) {
      const session = p.session;
      dec = new AudioDecoder({
        output: (audio) => {
          const pcm = new Float32Array(audio.numberOfFrames);
          audio.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
          audio.close();
          this.stats.samplesOut += pcm.length;
          this._mixer?.port.postMessage({ type: 'push', session, samples: pcm }, [pcm.buffer]);
        },
        error: e => { this._diag(`decoder ${session}: ${e.message}`); this._decoders.delete(session); },
      });
      dec.configure({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1 });
      this._decoders.set(p.session, dec);
      const u = this.client.users.get(p.session);
      this._mixer?.port.postMessage({ type: 'gain', session: p.session, gain: u?.localMute ? 0 : (u?.localVolume ?? 1) });
    }
    if (p.opus.length && dec.state === 'configured') {
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Number(p.frameNumber) * 10_000, data: p.opus }));
    }
  }
  _pruneDecoders() {
    for (const s of [...this._decoders.keys()]) if (!this.client.users.has(s)) { try { this._decoders.get(s).close(); } catch {} this._decoders.delete(s); this._mixer?.port.postMessage({ type: 'remove', session: s }); }
  }

  _emit(n) { this.dispatchEvent(new CustomEvent(n)); }
  _diag(m) { this.client._diag('audio', m); }
}
