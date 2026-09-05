const SAMPLE_RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = 960;
const FRAMES_PER_PACKET = FRAME_MS / 10;
const MICROS_PER_SEQUENCE_UNIT = 10_000;
const HANGOVER_MS = 400;
const OPEN_FRAMES = 2;
const VAD_OPEN = 0.5;
const VAD_HOLD = 0.3;
const NO_VAD = -1;
const FLOOR_RISE_DB_PER_FRAME = (0.5 * FRAME_MS) / 1000;
const THRESHOLD_ABOVE_FLOOR_DB = 12;
const VAD_LEVEL_ABOVE_FLOOR_DB = 6;
const SILENCE_DB = -90;
const LEVEL_EVENT_EVERY_FRAMES = 3;
const CAPTURE_STALL_MS = 150;
const STALL_LOG_INTERVAL_MS = 2000;
const DEVICE_LIST_TIMEOUT_MS = 2000;
const MAX_CONCEALED_PACKETS = 3;
const CONCEAL_DECAY = 0.6;
const OPUS_COMPLEXITY = 10;
const EXPECTED_PACKET_LOSS_PERCENT = 10;

const DEFAULTS = {
  transmitMode: 'vad',
  vadThresholdDb: -38,
  autoSensitivity: true,
  bitrate: 40_000,
  inputGain: 1,
  inputDeviceId: '',
  outputDeviceId: '',
  noiseSuppression: 'neural',
  processing: { echo: true, noise: false, gain: true },
};

function rmsDb(samples, gain) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] * gain;
    sum += value * value;
  }
  return 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
}

function captureErrorText(error) {
  if (error.name === 'NotAllowedError') {
    return 'Microphone blocked';
  }
  if (error.name === 'NotFoundError') {
    return 'No microphone';
  }
  return error.message;
}

export class AudioEngine extends EventTarget {
  inputLevelDb = -80;
  noiseFloorDb = -60;
  effectiveThresholdDb = -38;
  isTransmitting = false;
  pttPressed = false;
  muted = false;
  deafened = false;
  running = false;
  captureError = null;
  neural = undefined;
  vadProb = NO_VAD;
  stats = { packetsOut: 0, packetsIn: 0, samplesOut: 0, concealed: 0, underruns: 0, captureStalls: 0 };

  #context = null;
  #mixer = null;
  #framer = null;
  #stream = null;
  #source = null;
  #encoder = null;
  #decoders = new Map();
  #receivers = new Map();
  #gateOpen = false;
  #closing = false;
  #lastVoiceAt = 0;
  #pendingTerminators = [];
  #timestamp = 0;
  #levelTick = 0;
  #openFrames = 0;
  #lastFrameAt = 0;
  #lastStallLogAt = 0;
  #rnnoiseBytes = null;

  constructor(client, settings = {}) {
    super();
    this.client = client;
    for (const [key, value] of Object.entries(DEFAULTS)) {
      settings[key] ??= value;
    }
    this.settings = settings;
    client.addEventListener('voice', (event) => this.#onVoice(event.detail));
    client.addEventListener('users', () => this.#pruneDecoders());
  }

  static get supported() {
    return (
      typeof AudioEncoder !== 'undefined' &&
      typeof AudioDecoder !== 'undefined' &&
      'audioWorklet' in AudioContext.prototype
    );
  }

  static get canPickOutput() {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  get thresholdDb() {
    return this.settings.autoSensitivity ? this.effectiveThresholdDb : this.settings.vadThresholdDb;
  }

  async start({ source } = {}) {
    if (this.running) {
      return;
    }
    this.#context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await this.#context.audioWorklet.addModule('/app/worklets.js');
    this.#createMixer();
    this.#createFramer();
    this.#createEncoder();
    this.running = true;
    await this.#applySink();
    await this.#context.resume();
    if (source === 'tone') {
      this.#startTestTone();
    } else {
      await this.#openMicrophone();
    }
    this.#emit('state');
  }

  async stop() {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.#source?.disconnect();
    this.#framer?.disconnect();
    this.#stopStream();
    this.#closeQuietly(this.#encoder);
    for (const decoder of this.#decoders.values()) {
      this.#closeQuietly(decoder);
    }
    this.#decoders.clear();
    await this.#context?.close();
    this.#context = null;
    this.#mixer = null;
    this.#framer = null;
    this.#stream = null;
    this.#source = null;
    this.#encoder = null;
    this.#gateOpen = false;
    this.#closing = false;
    this.#pendingTerminators = [];
    this.#setTransmitting(false);
    this.#emit('state');
  }

  async setProcessing(patch) {
    this.settings.processing = { ...(this.settings.processing ?? DEFAULTS.processing), ...patch };
    if (this.running) {
      await this.#openMicrophone();
    }
  }

  async setInputDevice(deviceId) {
    this.settings.inputDeviceId = deviceId;
    if (this.running) {
      await this.#openMicrophone();
    }
  }

  async devices(kind) {
    try {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), DEVICE_LIST_TIMEOUT_MS));
      const all = await Promise.race([navigator.mediaDevices.enumerateDevices(), timeout]);
      if (!all) {
        this.#diag('the browser did not answer enumerateDevices()');
        return [];
      }
      return all.filter((device) => device.kind === kind);
    } catch {
      return [];
    }
  }

  inputDevices() {
    return this.devices('audioinput');
  }

  outputDevices() {
    return this.devices('audiooutput');
  }

  async setOutputDevice(deviceId) {
    this.settings.outputDeviceId = deviceId;
    await this.#applySink();
    this.#emit('state');
  }

  applySink(element) {
    const id = this.settings.outputDeviceId;
    if (id && element?.setSinkId) {
      element.setSinkId(id).catch(() => {});
    }
  }

  setBitrate(bitsPerSecond) {
    this.settings.bitrate = bitsPerSecond;
    if (this.#encoder?.state === 'configured') {
      this.#encoder.configure(this.#encoderConfig());
    }
  }

  setNoiseSuppression(level) {
    this.settings.noiseSuppression = level;
    this.#framer?.port.postMessage({ type: 'suppress', level });
    this.#emit('state');
  }

  setMuted(on) {
    this.muted = on;
    this.client.setSelfMute(on);
    if (on) {
      this.#closeGate();
    } else {
      this.setDeafened(false, false);
    }
    this.#emit('state');
  }

  setDeafened(on, syncWithServer = true) {
    this.deafened = on;
    this.#mixer?.port.postMessage({ type: 'master', gain: on ? 0 : 1 });
    if (syncWithServer) {
      this.client.setSelfDeaf(on);
    }
    if (on) {
      this.muted = true;
      this.#closeGate();
    }
    this.#emit('state');
  }

  setPTT(pressed) {
    this.pttPressed = pressed;
    this.#emit('state');
  }

  setUserVolume(session, gain) {
    const user = this.client.users.get(session);
    if (user) {
      user.localVolume = gain;
    }
    this.#mixer?.port.postMessage({ type: 'gain', session, gain: user?.localMute ? 0 : gain });
  }

  setUserLocalMute(session, on) {
    const user = this.client.users.get(session);
    if (user) {
      user.localMute = on;
    }
    this.#mixer?.port.postMessage({ type: 'gain', session, gain: on ? 0 : (user?.localVolume ?? 1) });
  }

  resync() {
    if (this.deafened) {
      this.client.setSelfDeaf(true);
    } else if (this.muted) {
      this.client.setSelfMute(true);
    }
  }

  #createMixer() {
    this.#mixer = new AudioWorkletNode(this.#context, 'mutter-mixer', { outputChannelCount: [2] });
    this.#mixer.connect(this.#context.destination);
    this.#mixer.port.postMessage({ type: 'master', gain: this.deafened ? 0 : 1 });
    this.#mixer.port.onmessage = ({ data }) => {
      if (data.type === 'health' && data.underruns) {
        this.stats.underruns += data.underruns;
        this.#diag(`playback ran dry ${data.underruns}× in the last second; buffer now ${data.jitterMs} ms`);
      }
    };
  }

  #createFramer() {
    this.#framer = new AudioWorkletNode(this.#context, 'mutter-framer', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.#framer.port.onmessage = ({ data }) => {
      if (data.type === 'rnnoise') {
        this.#onRnnoiseStatus(data);
      } else {
        this.#onFrame(data.samples, data.vad);
      }
    };
    this.#framer.port.postMessage({ type: 'suppress', level: this.settings.noiseSuppression });
    this.#loadRnnoise();
  }

  #onRnnoiseStatus({ ready, error }) {
    this.neural = ready;
    this.#diag(ready ? 'RNNoise ready' : `RNNoise failed: ${error}`);
    if (!ready && this.settings.noiseSuppression === 'neural') {
      this.setNoiseSuppression('strong');
    }
    this.#emit('state');
  }

  async #loadRnnoise() {
    if (this.neural === false) {
      return;
    }
    try {
      this.#rnnoiseBytes ??= await (await fetch('/app/rnnoise.wasm')).arrayBuffer();
      const copy = this.#rnnoiseBytes.slice(0);
      this.#framer?.port.postMessage({ type: 'rnnoise', bytes: copy }, [copy]);
    } catch (error) {
      this.neural = false;
      this.#diag(`RNNoise unavailable: ${error.message}`);
      if (this.settings.noiseSuppression === 'neural') {
        this.setNoiseSuppression('strong');
      }
    }
  }

  #createEncoder() {
    this.#encoder = new AudioEncoder({
      output: (chunk) => this.#onEncodedChunk(chunk),
      error: (error) => this.#diag(`encoder error: ${error.message}`),
    });
    this.#encoder.configure(this.#encoderConfig());
  }

  #encoderConfig() {
    return {
      codec: 'opus',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate: this.settings.bitrate,
      opus: {
        frameDuration: FRAME_MS * 1000,
        application: 'voip',
        signal: 'voice',
        complexity: OPUS_COMPLEXITY,
        useinbandfec: true,
        packetlossperc: EXPECTED_PACKET_LOSS_PERCENT,
      },
    };
  }

  #onEncodedChunk(chunk) {
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    const isTerminator = this.#pendingTerminators.shift() ?? false;
    this.client.sendAudio(bytes, FRAMES_PER_PACKET, isTerminator);
    this.stats.packetsOut++;
    if (isTerminator) {
      this.#setTransmitting(false);
    }
  }

  #startTestTone() {
    const oscillator = new OscillatorNode(this.#context, { frequency: 440 });
    const gain = new GainNode(this.#context, { gain: 0.2 });
    oscillator.connect(gain);
    oscillator.start();
    this.#source = gain;
    this.#source.connect(this.#framer);
    this.#diag('voice started (test tone)');
  }

  #microphoneConstraints() {
    const processing = this.settings.processing ?? DEFAULTS.processing;
    const id = this.settings.inputDeviceId;
    return {
      echoCancellation: processing.echo !== false,
      noiseSuppression: !!processing.noise,
      autoGainControl: processing.gain !== false,
      voiceIsolation: !!processing.noise,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
      ...(id ? { deviceId: { exact: id } } : {}),
    };
  }

  #stopStream() {
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
  }

  async #openMicrophone() {
    this.#source?.disconnect();
    this.#stopStream();
    this.#source = null;
    this.captureError = null;
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({ audio: this.#microphoneConstraints() });
    } catch (error) {
      if (this.settings.inputDeviceId) {
        this.settings.inputDeviceId = '';
        return this.#openMicrophone();
      }
      this.captureError = captureErrorText(error);
      this.#diag(`microphone unavailable: ${error.name} ${error.message} — playback only`);
      this.#emit('state');
      return;
    }
    const track = this.#stream.getAudioTracks()[0];
    this.#source = new MediaStreamAudioSourceNode(this.#context, { mediaStream: this.#stream });
    this.#source.connect(this.#framer);
    track.onended = () => {
      this.#diag('microphone track ended');
      this.captureError = 'Microphone lost';
      this.#emit('state');
    };
    this.#diag(`voice started (${track.label || 'microphone'})`);
    this.#emit('state');
  }

  async #applySink() {
    const id = this.settings.outputDeviceId;
    if (!this.#context?.setSinkId) {
      return;
    }
    try {
      await this.#context.setSinkId(id || '');
      this.#diag(`output → ${id ? id.slice(0, 8) : 'system default'}`);
    } catch (error) {
      this.#diag(`output device rejected: ${error.message}`);
      this.settings.outputDeviceId = '';
    }
  }

  #noteCaptureStall() {
    const now = performance.now();
    const gap = now - this.#lastFrameAt;
    const stalled = this.#lastFrameAt && gap > CAPTURE_STALL_MS;
    if (stalled && now - this.#lastStallLogAt > STALL_LOG_INTERVAL_MS) {
      this.#lastStallLogAt = now;
      this.stats.captureStalls++;
      this.#diag(`capture stalled ${Math.round(gap)} ms — the page was busy`);
    }
    this.#lastFrameAt = now;
  }

  #trackNoiseFloor(db) {
    if (this.#gateOpen || db <= SILENCE_DB) {
      return;
    }
    if (db < this.noiseFloorDb) {
      this.noiseFloorDb = db;
    } else {
      this.noiseFloorDb = Math.min(db, this.noiseFloorDb + FLOOR_RISE_DB_PER_FRAME);
    }
    this.effectiveThresholdDb = Math.min(-15, Math.max(-60, this.noiseFloorDb + THRESHOLD_ABOVE_FLOOR_DB));
  }

  #onFrame(samples, vad = NO_VAD) {
    if (!this.running) {
      return;
    }
    this.vadProb = vad;
    this.#noteCaptureStall();
    const db = rmsDb(samples, this.settings.inputGain);
    this.inputLevelDb = db;
    if (++this.#levelTick % LEVEL_EVENT_EVERY_FRAMES === 0) {
      this.#emit('level');
    }
    this.#trackNoiseFloor(db);
    this.#updateGate(this.#wantsToTransmit(db, vad));
    if (!this.#gateOpen && !this.#closing) {
      return;
    }
    if (this.#encoder?.state !== 'configured') {
      return;
    }
    this.#encodeFrame(samples);
  }

  #updateGate(wants) {
    const now = performance.now();
    this.#openFrames = wants ? this.#openFrames + 1 : 0;
    const bypassesDebounce = this.settings.transmitMode !== 'vad' || this.pttPressed;
    const shouldOpen = wants && (this.#gateOpen || this.#openFrames >= OPEN_FRAMES || bypassesDebounce);
    if (shouldOpen) {
      this.#lastVoiceAt = now;
      if (!this.#gateOpen) {
        this.#gateOpen = true;
        this.#setTransmitting(true);
      }
    } else if (this.#gateOpen && now - this.#lastVoiceAt > HANGOVER_MS) {
      this.#closeGate();
    }
  }

  #encodeFrame(samples) {
    if (this.settings.inputGain !== 1) {
      for (let i = 0; i < samples.length; i++) {
        samples[i] *= this.settings.inputGain;
      }
    }
    this.#pendingTerminators.push(this.#closing);
    this.#closing = false;
    this.#encoder.encode(
      new AudioData({
        format: 'f32-planar',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: FRAME_SAMPLES,
        numberOfChannels: 1,
        timestamp: this.#timestamp,
        data: samples,
      })
    );
    this.#timestamp += FRAME_MS * 1000;
  }

  #wantsToTransmit(db, vad) {
    if (this.muted || !this.client.isConnected) {
      return false;
    }
    switch (this.settings.transmitMode) {
      case 'continuous':
        return true;
      case 'ptt':
        return this.pttPressed;
      default:
        if (this.pttPressed) {
          return true;
        }
        if (vad >= 0) {
          const vadThreshold = this.#gateOpen ? VAD_HOLD : VAD_OPEN;
          const levelFloor = Math.min(this.thresholdDb, this.noiseFloorDb + VAD_LEVEL_ABOVE_FLOOR_DB);
          return vad >= vadThreshold && db > levelFloor;
        }
        return db > this.thresholdDb;
    }
  }

  #closeGate() {
    if (this.#gateOpen) {
      this.#gateOpen = false;
      this.#closing = true;
    }
  }

  #setTransmitting(on) {
    if (this.isTransmitting !== on) {
      this.isTransmitting = on;
      this.#emit('transmit');
    }
  }

  #onVoice(packet) {
    if (!this.running || this.deafened) {
      return;
    }
    this.stats.packetsIn++;
    const decoder = this.#decoderFor(packet.session);
    if (packet.opus.length && decoder.state === 'configured') {
      this.#conceal(packet);
      const timestamp = Number(packet.frameNumber) * MICROS_PER_SEQUENCE_UNIT;
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: packet.opus }));
    }
  }

  #decoderFor(session) {
    let decoder = this.#decoders.get(session);
    if (decoder) {
      return decoder;
    }
    decoder = new AudioDecoder({
      output: (audio) => this.#onDecoded(session, audio),
      error: (error) => {
        this.#diag(`decoder ${session}: ${error.message}`);
        this.#decoders.delete(session);
      },
    });
    decoder.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
    this.#decoders.set(session, decoder);
    const user = this.client.users.get(session);
    const gain = user?.localMute ? 0 : (user?.localVolume ?? 1);
    this.#mixer?.port.postMessage({ type: 'gain', session, gain });
    return decoder;
  }

  #onDecoded(session, audio) {
    const pcm = new Float32Array(audio.numberOfFrames);
    audio.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
    audio.close();
    this.stats.samplesOut += pcm.length;
    const receiver = this.#receivers.get(session);
    if (receiver) {
      receiver.lastPcm = pcm.slice();
    }
    this.#mixer?.port.postMessage({ type: 'push', session, samples: pcm }, [pcm.buffer]);
  }

  #conceal(packet) {
    const sequence = Number(packet.frameNumber);
    let receiver = this.#receivers.get(packet.session);
    if (!receiver) {
      receiver = { lastSequence: null, lastPcm: null };
      this.#receivers.set(packet.session, receiver);
    }
    if (receiver.lastSequence !== null && receiver.lastPcm) {
      const missing = Math.round((sequence - receiver.lastSequence) / FRAMES_PER_PACKET) - 1;
      if (missing > 0 && missing <= MAX_CONCEALED_PACKETS) {
        for (let step = 1; step <= missing; step++) {
          const decay = CONCEAL_DECAY ** step;
          const fill = receiver.lastPcm.map((value) => value * decay);
          this.#mixer?.port.postMessage({ type: 'push', session: packet.session, samples: fill }, [fill.buffer]);
        }
        this.stats.concealed += missing;
      }
    }
    receiver.lastSequence = sequence;
  }

  #pruneDecoders() {
    for (const session of [...this.#decoders.keys()]) {
      if (this.client.users.has(session)) {
        continue;
      }
      this.#closeQuietly(this.#decoders.get(session));
      this.#decoders.delete(session);
      this.#receivers.delete(session);
      this.#mixer?.port.postMessage({ type: 'remove', session });
    }
  }

  #closeQuietly(codec) {
    try {
      codec?.close();
    } catch {}
  }

  #emit(name) {
    this.dispatchEvent(new CustomEvent(name));
  }

  #diag(message) {
    this.client.diag('audio', message);
  }
}
