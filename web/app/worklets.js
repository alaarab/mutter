import { NoiseSuppressor, feedBlocks } from './dsp.js';
import { JitterPolicy } from './jitter.js';

const FRAME_SAMPLES = 960;
const RNNOISE_BLOCK = 480;
const RNNOISE_SCALE = 32768;
const NO_VAD = -1;

const SAMPLE_RATE = 48000;
const SAMPLES_PER_MILLISECOND = SAMPLE_RATE / 1000;
const RING_SAMPLES = SAMPLE_RATE;
const MIN_JITTER = FRAME_SAMPLES * 3;
const MAX_JITTER = FRAME_SAMPLES * 10;
const JITTER_GROW = FRAME_SAMPLES;
const JITTER_SHRINK = FRAME_SAMPLES / 2;
const JITTER_DANGER = FRAME_SAMPLES;
const JITTER_CUSHION = FRAME_SAMPLES;
const RUN_AHEAD_CAP = SAMPLE_RATE / 2;
const FADE_SAMPLES = 96;
const RENDER_QUANTUM = 128;
const TICKS_PER_SECOND = SAMPLE_RATE / RENDER_QUANTUM;
const CALM_SECONDS_BEFORE_SHRINK = 15;

class Framer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME_SAMPLES);
    this.frameFill = 0;
    this.vad = 0;
    this.level = 'strong';
    this.suppressor = new NoiseSuppressor('strong');
    this.rnnoise = null;
    this.rnnoiseInput = new Float32Array(RNNOISE_BLOCK);
    this.rnnoiseFill = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'suppress') {
        this.setLevel(data.level);
      } else if (data.type === 'rnnoise') {
        this.loadRnnoise(data.bytes);
      }
    };
    this.port.onmessageerror = () => {
      this.port.postMessage({ type: 'rnnoise', ready: false, error: 'message could not be deserialised' });
    };
  }

  setLevel(level) {
    this.level = level;
    const spectralLevel = level === 'neural' || level === 'off' ? 'off' : level;
    this.suppressor.level = spectralLevel;
    if (spectralLevel === 'off') {
      this.suppressor.reset();
    }
  }

  loadRnnoise(bytes) {
    try {
      const { exports } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
      exports._initialize?.();
      const state = exports.malloc(exports.rnnoise_get_size());
      exports.rnnoise_init(state, 0);
      this.rnnoise = {
        exports,
        state,
        input: exports.malloc(RNNOISE_BLOCK * 4),
        output: exports.malloc(RNNOISE_BLOCK * 4),
      };
      this.port.postMessage({ type: 'rnnoise', ready: true });
    } catch (error) {
      this.port.postMessage({ type: 'rnnoise', ready: false, error: String(error) });
    }
  }

  get usingRnnoise() {
    return this.level === 'neural' && this.rnnoise !== null;
  }

  denoise(samples) {
    const blocks = [];
    this.rnnoiseFill = feedBlocks(samples, this.rnnoiseInput, this.rnnoiseFill, () => {
      blocks.push(this.runRnnoiseBlock());
    });
    if (blocks.length === 1) {
      return blocks[0];
    }
    const all = new Float32Array(blocks.length * RNNOISE_BLOCK);
    blocks.forEach((block, index) => all.set(block, index * RNNOISE_BLOCK));
    return all;
  }

  runRnnoiseBlock() {
    const { exports, state, input, output } = this.rnnoise;
    const memoryIn = new Float32Array(exports.memory.buffer);
    for (let k = 0; k < RNNOISE_BLOCK; k++) {
      memoryIn[input / 4 + k] = this.rnnoiseInput[k] * RNNOISE_SCALE;
    }
    const vad = exports.rnnoise_process_frame(state, output, input);
    this.vad = Math.max(this.vad, vad);
    const memoryOut = new Float32Array(exports.memory.buffer);
    const result = new Float32Array(RNNOISE_BLOCK);
    for (let k = 0; k < RNNOISE_BLOCK; k++) {
      result[k] = memoryOut[output / 4 + k] / RNNOISE_SCALE;
    }
    return result;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) {
      return true;
    }
    const cleaned = this.usingRnnoise ? this.denoise(channel) : this.suppressor.process(channel);
    this.frameFill = feedBlocks(cleaned, this.frame, this.frameFill, () => {
      this.emitFrame();
    });
    return true;
  }

  emitFrame() {
    const vad = this.usingRnnoise ? this.vad : NO_VAD;
    this.port.postMessage({ samples: this.frame.slice(), vad });
    this.vad = 0;
  }
}

class Mixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.users = new Map();
    this.master = 1;
    this.policy = new JitterPolicy({
      minSamples: MIN_JITTER,
      maxSamples: MAX_JITTER,
      growSamples: JITTER_GROW,
      shrinkSamples: JITTER_SHRINK,
      dangerSamples: JITTER_DANGER,
      cushionSamples: JITTER_CUSHION,
      calmSecondsBeforeShrink: CALM_SECONDS_BEFORE_SHRINK,
    });
    this.tick = 0;
    this.underruns = 0;
    this.lowWater = Infinity;
    this.playedThisSecond = false;
    this.capture = null;
    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'push':
          this.push(data.session, data.samples);
          break;
        case 'end':
          this.endStream(data.session);
          break;
        case 'capture':
          this.capture = { blocks: [], remaining: Math.ceil(data.samples / RENDER_QUANTUM) };
          break;
        case 'gain':
          this.setGain(data.session, data.gain);
          break;
        case 'remove':
          this.users.delete(data.session);
          break;
        case 'master':
          this.master = data.gain;
          break;
        default:
          break;
      }
    };
  }

  newUser(gain = 1) {
    return { ring: new Float32Array(RING_SAMPLES), read: 0, write: 0, gain, primed: false, ending: false, fadeIn: 0, lastSample: 0 };
  }

  endStream(session) {
    const user = this.users.get(session);
    if (user) {
      user.ending = true;
    }
  }

  available(user) {
    return (user.write - user.read + RING_SAMPLES) % RING_SAMPLES;
  }

  setGain(session, gain) {
    const user = this.users.get(session);
    if (user) {
      user.gain = gain;
    } else {
      this.users.set(session, this.newUser(gain));
    }
  }

  push(session, samples) {
    let user = this.users.get(session);
    if (!user) {
      user = this.newUser();
      this.users.set(session, user);
    }
    user.ending = false;
    if (this.available(user) + samples.length > RUN_AHEAD_CAP) {
      user.read = (user.write - this.policy.target + RING_SAMPLES) % RING_SAMPLES;
    }
    for (let i = 0; i < samples.length; i++) {
      user.ring[user.write] = samples[i];
      user.write = (user.write + 1) % RING_SAMPLES;
    }
  }

  reportHealth() {
    const decision = this.policy.observe({
      underruns: this.underruns,
      lowWater: this.lowWater === Infinity ? null : this.lowWater,
      active: this.playedThisSecond,
    });
    if (this.underruns || decision.changed) {
      this.port.postMessage({
        type: 'health',
        underruns: this.underruns,
        jitterMs: Math.round(this.policy.target / SAMPLES_PER_MILLISECOND),
        reason: decision.reason,
      });
    }
    this.tick = 0;
    this.underruns = 0;
    this.lowWater = Infinity;
    this.playedThisSecond = false;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] ?? output[0];
    left.fill(0);
    if (++this.tick >= TICKS_PER_SECOND) {
      this.reportHealth();
    }
    for (const user of this.users.values()) {
      const available = this.available(user);
      if (user.primed) {
        this.playedThisSecond = true;
        this.lowWater = Math.min(this.lowWater, available);
      }
      if (!user.primed) {
        const ready = available >= this.policy.target || (user.ending && available > 0);
        if (!ready) {
          this.rampOut(user, left, 0);
          continue;
        }
        user.primed = true;
        user.fadeIn = FADE_SAMPLES;
      }
      if (available >= left.length) {
        this.mixInto(left, user, 0, left.length);
        continue;
      }
      this.mixInto(left, user, 0, available);
      this.rampOut(user, left, available);
      user.primed = false;
      if (user.ending) {
        user.ending = false;
      } else {
        this.underruns++;
      }
    }
    for (let i = 0; i < left.length; i++) {
      left[i] = Math.max(-1, Math.min(1, left[i]));
    }
    if (right !== left) {
      right.set(left);
    }
    if (this.capture) {
      this.recordCapture(left);
    }
    return true;
  }

  mixInto(left, user, offset, count) {
    const gain = user.gain * this.master;
    for (let i = 0; i < count; i++) {
      let sample = user.ring[user.read] * gain;
      if (user.fadeIn > 0) {
        sample *= 1 - user.fadeIn / FADE_SAMPLES;
        user.fadeIn--;
      }
      left[offset + i] += sample;
      user.lastSample = sample;
      user.read = (user.read + 1) % RING_SAMPLES;
    }
  }

  rampOut(user, left, offset) {
    if (user.lastSample === 0) {
      return;
    }
    for (let i = 0; i < FADE_SAMPLES && offset + i < left.length; i++) {
      left[offset + i] += user.lastSample * (1 - i / FADE_SAMPLES);
    }
    user.lastSample = 0;
  }

  recordCapture(block) {
    this.capture.blocks.push(block.slice());
    if (--this.capture.remaining > 0) {
      return;
    }
    const samples = new Float32Array(this.capture.blocks.length * block.length);
    this.capture.blocks.forEach((chunk, index) => samples.set(chunk, index * block.length));
    this.capture = null;
    this.port.postMessage({ type: 'capture', samples }, [samples.buffer]);
  }
}

registerProcessor('mutter-framer', Framer);
registerProcessor('mutter-mixer', Mixer);
