// Voice: capture → Opus → Mumble packets, and Mumble packets → Opus → speakers.
// The browser gives us echo cancellation, noise suppression and AGC for free via getUserMedia
// constraints — the same job Apple's voice processing does on iOS.

const FRAME_MS = 20;
const FRAME_SAMPLES = 960;                 // 20 ms at 48 kHz
const FRAMES_PER_PACKET = FRAME_MS / 10;   // Mumble sequence numbers count 10 ms units
const HANGOVER_MS = 400;

export class AudioEngine extends EventTarget {
  constructor(client) {
    super();
    this.client = client;
    this.settings = { transmitMode: 'vad', vadThresholdDb: -38, autoSensitivity: true, bitrate: 40_000, inputGain: 1 };
    this.inputLevelDb = -80;
    this.noiseFloorDb = -60;
    this.effectiveThresholdDb = -38;
    this.isTransmitting = false;
    this.pttPressed = false;
    this.muted = false;
    this.deafened = false;
    this.running = false;
    this._ctx = null; this._mixer = null; this._framer = null; this._stream = null; this._source = null;
    this._encoder = null; this._decoders = new Map(); this._gateOpen = false; this._lastVoiceAt = 0; this._closing = false;
    this._ts = 0; this._levelTick = 0;
    client.addEventListener('voice', e => this._onVoice(e.detail));
    client.addEventListener('users', () => this._pruneDecoders());
  }

  static get supported() { return typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined' && 'audioWorklet' in AudioContext.prototype; }

  /// `source`: omit for the microphone; pass 'tone' for a built-in test signal (no permission needed).
  async start({ source } = {}) {
    if (this.running) return;
    this._ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
    await this._ctx.audioWorklet.addModule('/app/worklets.js');
    this._mixer = new AudioWorkletNode(this._ctx, 'mutter-mixer', { outputChannelCount: [2] });
    this._mixer.connect(this._ctx.destination);
    this._mixer.port.postMessage({ type: 'master', gain: this.deafened ? 0 : 1 });

    if (source === 'tone') {
      const osc = new OscillatorNode(this._ctx, { frequency: 440 });
      const g = new GainNode(this._ctx, { gain: 0.2 });
      osc.connect(g); osc.start(); this._source = g;
    } else {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48_000 },
      });
      this._source = new MediaStreamAudioSourceNode(this._ctx, { mediaStream: this._stream });
    }
    this._framer = new AudioWorkletNode(this._ctx, 'mutter-framer', { numberOfInputs: 1, numberOfOutputs: 0 });
    this._framer.port.onmessage = ({ data }) => this._onFrame(data);
    this._source.connect(this._framer);

    this._encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        const terminator = this._closing;
        this._closing = false;
        this.client.sendAudio(bytes, FRAMES_PER_PACKET, terminator);
        if (terminator) this._setTransmitting(false);
      },
      error: e => this._diag(`encoder error: ${e.message}`),
    });
    this._encoder.configure({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1, bitrate: this.settings.bitrate, opus: { frameDuration: FRAME_MS * 1000, application: 'voip', signal: 'voice' } });
    this.running = true;
    await this._ctx.resume();
    this._diag(`voice started (${source === 'tone' ? 'test tone' : 'microphone'})`);
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
    this._setTransmitting(false);
  }

  setBitrate(bps) { this.settings.bitrate = bps; if (this._encoder?.state === 'configured') this._encoder.configure({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 1, bitrate: bps, opus: { frameDuration: FRAME_MS * 1000, application: 'voip', signal: 'voice' } }); }
  setMuted(on) { this.muted = on; this.client.setSelfMute(on); if (on) this._closeGate(); if (!on) this.setDeafened(false, false); this._emit('state'); }
  setDeafened(on, sync = true) { this.deafened = on; this._mixer?.port.postMessage({ type: 'master', gain: on ? 0 : 1 }); if (sync) this.client.setSelfDeaf(on); if (on) { this.muted = true; this._closeGate(); } this._emit('state'); }
  setPTT(pressed) { this.pttPressed = pressed; this._emit('state'); }
  setUserVolume(session, gain) { const u = this.client.users.get(session); if (u) u.localVolume = gain; this._mixer?.port.postMessage({ type: 'gain', session, gain: u?.localMute ? 0 : gain }); }
  setUserLocalMute(session, on) { const u = this.client.users.get(session); if (u) u.localMute = on; this._mixer?.port.postMessage({ type: 'gain', session, gain: on ? 0 : (u?.localVolume ?? 1) }); }

  // ---- capture path ----

  _onFrame(samples) {
    if (!this.running) return;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) { const v = samples[i] * this.settings.inputGain; sum += v * v; }
    const db = 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
    this.inputLevelDb = db;
    if ((++this._levelTick % 3) === 0) this._emit('level');

    const shouldOpen = this._shouldTransmit(db);
    const now = performance.now();
    if (shouldOpen) { this._lastVoiceAt = now; if (!this._gateOpen) { this._gateOpen = true; this._setTransmitting(true); } }
    else if (this._gateOpen && now - this._lastVoiceAt > HANGOVER_MS) { this._gateOpen = false; this._closing = true; }
    if (!this._gateOpen && !this._closing) {
      // Track the room's noise floor while we're quiet, so auto-sensitivity follows it.
      if (this.settings.autoSensitivity && db > -90) { this.noiseFloorDb = this.noiseFloorDb * 0.97 + db * 0.03; this.effectiveThresholdDb = Math.min(-15, this.noiseFloorDb + 12); }
      return;
    }
    if (this._encoder?.state !== 'configured') return;
    if (this.settings.inputGain !== 1) for (let i = 0; i < samples.length; i++) samples[i] *= this.settings.inputGain;
    this._encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48_000, numberOfFrames: FRAME_SAMPLES, numberOfChannels: 1, timestamp: this._ts, data: samples }));
    this._ts += FRAME_MS * 1000;
  }

  _shouldTransmit(db) {
    if (this.muted || !this.client.isConnected) return false;
    switch (this.settings.transmitMode) {
      case 'continuous': return true;
      case 'ptt': return this.pttPressed;
      default: return db > (this.settings.autoSensitivity ? this.effectiveThresholdDb : this.settings.vadThresholdDb);
    }
  }
  _closeGate() { if (this._gateOpen) { this._gateOpen = false; this._closing = true; } }
  _setTransmitting(on) { if (this.isTransmitting !== on) { this.isTransmitting = on; this._emit('transmit'); } }

  // ---- playout path ----

  _onVoice(p) {
    if (!this.running || this.deafened) return;
    let dec = this._decoders.get(p.session);
    if (!dec) {
      const session = p.session;
      dec = new AudioDecoder({
        output: (audio) => {
          const pcm = new Float32Array(audio.numberOfFrames);
          audio.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
          audio.close();
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
