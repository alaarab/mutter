const FRAME = 1024;
const HOP = 512;
const HALF = 512;
const LOW_CUT_BIN = 2;
const WARMUP_FRAMES = 8;
const LOW_BAND_TOP_BIN = 22;
const HIGH_BAND_FROM_BIN = 64;
const CLICK_DUCK_FROM_BIN = 32;
const CLICK_DUCK_GAIN = 0.1;
const CLICK_JUMP_DB = 12;
const MAX_CLICK_RUN = 3;
const NOISE_FLOOR = 1e-8;

export function feedBlocks(input, block, filled, onFull) {
  let offset = 0;
  while (offset < input.length) {
    const take = Math.min(input.length - offset, block.length - filled);
    block.set(input.subarray(offset, offset + take), filled);
    filled += take;
    offset += take;
    if (filled === block.length) {
      filled = onFull() ?? 0;
    }
  }
  return filled;
}

function swap(array, i, j) {
  const held = array[i];
  array[i] = array[j];
  array[j] = held;
}

export class FFT {
  constructor(size) {
    this.size = size;
    this.reversed = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let reversed = 0;
      for (let bit = 0; bit < bits; bit++) {
        reversed = (reversed << 1) | ((i >> bit) & 1);
      }
      this.reversed[i] = reversed;
    }
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }
  }

  transform(re, im, inverse = false) {
    const { size, reversed, cos, sin } = this;
    for (let i = 0; i < size; i++) {
      const j = reversed[i];
      if (j > i) {
        swap(re, i, j);
        swap(im, i, j);
      }
    }
    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1;
      const step = size / span;
      for (let start = 0; start < size; start += span) {
        for (let k = 0, twiddle = 0; k < half; k++, twiddle += step) {
          const wr = cos[twiddle];
          const wi = inverse ? sin[twiddle] : -sin[twiddle];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

export class NoiseSuppressor {
  static LEVELS = {
    off: { gainFloor: 1, overSubtraction: 1 },
    light: { gainFloor: 0.316, overSubtraction: 1.2 },
    strong: { gainFloor: 0.08, overSubtraction: 1.6 },
  };

  constructor(level = 'strong') {
    this.level = level;
    this.fft = new FFT(FRAME);
    this.window = new Float32Array(FRAME);
    for (let k = 0; k < FRAME; k++) {
      this.window[k] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * k) / FRAME));
    }
    this.re = new Float32Array(FRAME);
    this.im = new Float32Array(FRAME);
    this.inputBuffer = new Float32Array(FRAME);
    this.inputFill = 0;
    this.overlap = new Float32Array(FRAME);
    this.noise = new Float32Array(HALF + 1).fill(1e-6);
    this.prevGain = new Float32Array(HALF + 1).fill(1);
    this.prevPower = new Float32Array(HALF + 1);
    this.gain = new Float32Array(HALF + 1).fill(1);
    this.power = new Float32Array(HALF + 1);
    this.frameCount = 0;
    this.highEnvelopeDb = -60;
    this.lowEnvelopeDb = -60;
    this.clickRun = 0;
    this.clicks = 0;
  }

  process(input) {
    if (this.level === 'off') {
      if (this.inputFill) {
        this.reset();
      }
      return input;
    }
    const chunks = [];
    this.inputFill = feedBlocks(input, this.inputBuffer, this.inputFill, () => {
      this.processFrame();
      chunks.push(this.overlap.slice(0, HOP));
      this.overlap.copyWithin(0, HOP);
      this.overlap.fill(0, FRAME - HOP);
      this.inputBuffer.copyWithin(0, HOP);
      return FRAME - HOP;
    });
    return chunks.length === 1 ? chunks[0] : concatFloat(chunks);
  }

  reset() {
    this.inputFill = 0;
    this.inputBuffer.fill(0);
    this.overlap.fill(0);
    this.noise.fill(1e-6);
    this.prevGain.fill(1);
    this.prevPower.fill(0);
    this.frameCount = 0;
    this.highEnvelopeDb = -60;
    this.lowEnvelopeDb = -60;
    this.clickRun = 0;
  }

  processFrame() {
    const { re, im, window, noise, prevGain, prevPower, gain, power } = this;
    const levels = NoiseSuppressor.LEVELS[this.level] ?? NoiseSuppressor.LEVELS.strong;
    const { gainFloor, overSubtraction } = levels;

    for (let k = 0; k < FRAME; k++) {
      re[k] = this.inputBuffer[k] * window[k];
      im[k] = 0;
    }
    this.fft.transform(re, im);
    for (let k = 0; k <= HALF; k++) {
      power[k] = re[k] * re[k] + im[k] * im[k];
    }

    const click = this.detectClick();
    const warmingUp = ++this.frameCount <= WARMUP_FRAMES;
    for (let k = 0; k <= HALF; k++) {
      const binPower = power[k];
      if (warmingUp) {
        noise[k] = Math.max(binPower, NOISE_FLOOR);
      } else if (!click) {
        const posterior = binPower / Math.max(noise[k], 1e-10);
        const rate = posterior < 3 ? 0.06 : 0.0025;
        noise[k] = Math.max(noise[k] + rate * (binPower - noise[k]), NOISE_FLOOR);
      }
      const noiseEstimate = noise[k] * overSubtraction;
      const instantaneous = Math.max(binPower / noiseEstimate - 1, 0);
      const prior = 0.98 * ((prevGain[k] * prevGain[k] * prevPower[k]) / noiseEstimate) + 0.02 * instantaneous;
      let binGain = Math.max(prior / (1 + prior), gainFloor);
      if (k < LOW_CUT_BIN) {
        binGain = 0;
      }
      gain[k] = binGain;
      prevGain[k] = binGain;
      prevPower[k] = binPower;
    }

    let previous = gain[0];
    for (let k = 1; k < HALF; k++) {
      const current = gain[k];
      gain[k] = 0.25 * previous + 0.5 * current + 0.25 * gain[k + 1];
      previous = current;
    }
    if (click) {
      for (let k = CLICK_DUCK_FROM_BIN; k <= HALF; k++) {
        gain[k] *= CLICK_DUCK_GAIN;
      }
    }

    for (let k = 0; k <= HALF; k++) {
      re[k] *= gain[k];
      im[k] *= gain[k];
    }
    for (let k = 1; k < HALF; k++) {
      re[FRAME - k] = re[k];
      im[FRAME - k] = -im[k];
    }
    this.fft.transform(re, im, true);
    const scale = 1 / FRAME;
    for (let k = 0; k < FRAME; k++) {
      this.overlap[k] += re[k] * scale * window[k];
    }
  }

  detectClick() {
    const { power } = this;
    let total = 0;
    let low = 0;
    let high = 0;
    for (let k = 1; k <= HALF; k++) {
      const binPower = power[k];
      total += binPower;
      if (k < LOW_BAND_TOP_BIN) {
        low += binPower;
      } else if (k >= HIGH_BAND_FROM_BIN) {
        high += binPower;
      }
    }
    const lowDb = 10 * Math.log10(low / FRAME + 1e-12);
    const highDb = 10 * Math.log10(high / FRAME + 1e-12);
    const highJumped = highDb - this.highEnvelopeDb > CLICK_JUMP_DB;
    const mostlyHighBand = high / (total + 1e-12) > 0.55;
    const lowHeldSteady = lowDb - this.lowEnvelopeDb < 6;
    const click =
      this.level === 'strong' &&
      this.frameCount > WARMUP_FRAMES &&
      highJumped &&
      (mostlyHighBand || lowHeldSteady) &&
      this.clickRun < MAX_CLICK_RUN;
    if (click) {
      this.clickRun++;
      this.clicks++;
      return true;
    }
    this.clickRun = 0;
    this.highEnvelopeDb += (highDb > this.highEnvelopeDb ? 0.08 : 0.02) * (highDb - this.highEnvelopeDb);
    this.lowEnvelopeDb += (lowDb > this.lowEnvelopeDb ? 0.08 : 0.02) * (lowDb - this.lowEnvelopeDb);
    return false;
  }
}

function concatFloat(chunks) {
  const out = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function dbfs(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
}
