// AudioWorklet processors. Runs on the audio render thread, so: no allocation in process(),
// no DOM, messages only.

import { NoiseSuppressor } from './dsp.js';

/// Cleans the microphone and turns the 128-sample render quanta into 20 ms frames (960 samples
/// at 48 kHz) for Opus. Cleaning runs here, before framing, so the level meter and the voice
/// gate both see the cleaned signal. Two cleaners: the spectral suppressor (Light/Strong) or
/// RNNoise (Neural) — a recurrent network compiled to WebAssembly, fed 10 ms blocks in 16-bit
/// scale, which also returns a voice probability per block that rides along with the frame.
class Framer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(960);
    this.fill = 0;
    this.vad = 0;
    this.level = 'strong';
    this.suppressor = new NoiseSuppressor('strong');
    this.rnn = null; this.rnnIn = new Float32Array(480); this.rnnFill = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'suppress') this.setLevel(data.level);
      else if (data.type === 'rnnoise') this.loadRnn(data.bytes);
    };
    this.port.onmessageerror = () => this.port.postMessage({ type: 'rnnoise', ready: false, error: 'message could not be deserialised' });
  }
  setLevel(level) {
    this.level = level;
    this.suppressor.level = level === 'neural' || level === 'off' ? 'off' : level;
    if (this.suppressor.level === 'off') this.suppressor.reset();
  }
  loadRnn(bytes) {
    try {
      // Synchronous compile + instantiate, the documented pattern for wasm in AudioWorklets: a
      // WebAssembly.Module can't be posted here and async instantiate doesn't settle on the
      // rendering thread. 125 KB compiles in a few milliseconds, once, before voice flows.
      const { exports: w } = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
      w._initialize?.();
      const st = w.malloc(w.rnnoise_get_size()); w.rnnoise_init(st, 0);
      this.rnn = { w, st, inP: w.malloc(480 * 4), outP: w.malloc(480 * 4) };
      this.port.postMessage({ type: 'rnnoise', ready: true });
    } catch (e) { this.port.postMessage({ type: 'rnnoise', ready: false, error: String(e) }); }
  }
  /// Runs RNNoise over `ch`, returning the denoised samples that have completed (multiples of 480).
  denoise(ch) {
    const out = [];
    let i = 0;
    while (i < ch.length) {
      const n = Math.min(ch.length - i, 480 - this.rnnFill);
      this.rnnIn.set(ch.subarray(i, i + n), this.rnnFill);
      this.rnnFill += n; i += n;
      if (this.rnnFill === 480) {
        const { w, st, inP, outP } = this.rnn;
        const mem = new Float32Array(w.memory.buffer);
        for (let k = 0; k < 480; k++) mem[inP / 4 + k] = this.rnnIn[k] * 32768;
        const vad = w.rnnoise_process_frame(st, outP, inP);
        this.vad = Math.max(this.vad, vad);
        const res = new Float32Array(480), m2 = new Float32Array(w.memory.buffer);
        for (let k = 0; k < 480; k++) res[k] = m2[outP / 4 + k] / 32768;
        out.push(res);
        this.rnnFill = 0;
      }
    }
    if (out.length === 1) return out[0];
    const all = new Float32Array(out.length * 480);
    out.forEach((r, k) => all.set(r, k * 480));
    return all;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const cleaned = this.level === 'neural' && this.rnn ? this.denoise(ch) : this.suppressor.process(ch);
    let i = 0;
    while (i < cleaned.length) {
      const n = Math.min(cleaned.length - i, 960 - this.fill);
      this.frame.set(cleaned.subarray(i, i + n), this.fill);
      this.fill += n; i += n;
      if (this.fill === 960) {
        // `vad` is the best voice probability across this frame's two RNNoise blocks; -1 = no RNNoise.
        this.port.postMessage({ samples: this.frame, vad: this.level === 'neural' && this.rnn ? this.vad : -1 }, [this.frame.buffer]);
        this.frame = new Float32Array(960);
        this.fill = 0; this.vad = 0;
      }
    }
    return true;
  }
}

/// Mixes every remote speaker into one output with per-user gain and an adaptive jitter buffer.
/// Each user's audio lives in a 1 s ring; playback of a user starts only once the buffer target is
/// met, and re-primes after an underrun instead of stuttering through it. The target starts at
/// 40 ms, grows 20 ms per underrun up to 200 ms — a jittery link earns a deeper buffer — and
/// creeps back down after fifteen clean seconds, so latency is only ever paid while it's needed.
class Mixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.users = new Map();      // session -> { buf, read, write, gain, primed }
    this.master = 1;
    this.jitter = 960 * 2;       // 40 ms before a stream starts…
    this.minJitter = 960 * 2; this.maxJitter = 960 * 10;   // …never below that, never above 200 ms
    this.cap = 48000 / 2;        // drop to 500 ms if a stream runs ahead of us
    this.tick = 0; this.underruns = 0; this.stable = 0;
    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'push': this.push(data.session, data.samples); break;
        case 'gain': { const u = this.users.get(data.session); if (u) u.gain = data.gain; else this.users.set(data.session, this.fresh(data.gain)); break; }
        case 'remove': this.users.delete(data.session); break;
        case 'master': this.master = data.gain; break;
      }
    };
  }
  fresh(gain = 1) { return { buf: new Float32Array(48000), read: 0, write: 0, gain, primed: false }; }
  available(u) { return (u.write - u.read + u.buf.length) % u.buf.length; }
  push(session, samples) {
    let u = this.users.get(session);
    if (!u) { u = this.fresh(); this.users.set(session, u); }
    if (this.available(u) + samples.length > this.cap) u.read = (u.write - this.jitter + u.buf.length) % u.buf.length;   // too far behind: skip ahead
    for (let i = 0; i < samples.length; i++) { u.buf[u.write] = samples[i]; u.write = (u.write + 1) % u.buf.length; }
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] ?? out[0];
    L.fill(0);
    if (++this.tick >= 375) {                                                       // once a second
      if (this.underruns) { this.port.postMessage({ type: 'health', underruns: this.underruns, jitterMs: this.jitter / 48 }); this.stable = 0; }
      else if (++this.stable >= 15 && this.jitter > this.minJitter) { this.jitter -= 480; this.stable = 0; }   // quiet for a while: give 10 ms back
      this.tick = 0; this.underruns = 0;
    }
    for (const u of this.users.values()) {
      const avail = this.available(u);
      if (!u.primed) { if (avail >= this.jitter) u.primed = true; else continue; }
      if (avail < L.length) { u.primed = false; this.underruns++; if (this.jitter < this.maxJitter) this.jitter += 960; continue; }   // underrun: go quiet, deepen, re-prime
      const g = u.gain * this.master;
      for (let i = 0; i < L.length; i++) { L[i] += u.buf[u.read] * g; u.read = (u.read + 1) % u.buf.length; }
    }
    for (let i = 0; i < L.length; i++) { const v = L[i]; L[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
    if (R !== L) R.set(L);
    return true;
  }
}

registerProcessor('mutter-framer', Framer);
registerProcessor('mutter-mixer', Mixer);
