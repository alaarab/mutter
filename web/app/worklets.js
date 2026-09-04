// AudioWorklet processors. Runs on the audio render thread, so: no allocation in process(),
// no DOM, messages only.

import { NoiseSuppressor } from './dsp.js';

/// Cleans the microphone and turns the 128-sample render quanta into 20 ms frames (960 samples
/// at 48 kHz) for Opus. The suppressor runs here, before framing, so the level meter and the
/// voice gate both see the cleaned signal.
class Framer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(960);
    this.fill = 0;
    this.suppressor = new NoiseSuppressor('strong');
    this.port.onmessage = ({ data }) => {
      if (data.type === 'suppress') { this.suppressor.level = data.level; if (data.level === 'off') this.suppressor.reset(); }
    };
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const cleaned = this.suppressor.process(ch);
    let i = 0;
    while (i < cleaned.length) {
      const n = Math.min(cleaned.length - i, 960 - this.fill);
      this.frame.set(cleaned.subarray(i, i + n), this.fill);
      this.fill += n; i += n;
      if (this.fill === 960) {
        this.port.postMessage(this.frame, [this.frame.buffer]);   // transfer, then re-allocate once
        this.frame = new Float32Array(960);
        this.fill = 0;
      }
    }
    return true;
  }
}

/// Mixes every remote speaker into one output with per-user gain and a small jitter buffer.
/// Each user's audio lives in a 1 s ring; playback of a user starts only once ~40 ms is
/// buffered, and re-primes after an underrun instead of stuttering through it.
class Mixer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.users = new Map();      // session -> { buf, read, write, gain, primed }
    this.master = 1;
    this.jitter = 960 * 2;       // 40 ms before a stream starts
    this.cap = 48000 / 2;        // drop to 500 ms if a stream runs ahead of us
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
    for (const u of this.users.values()) {
      const avail = this.available(u);
      if (!u.primed) { if (avail >= this.jitter) u.primed = true; else continue; }
      if (avail < L.length) { u.primed = false; continue; }          // underrun: go quiet, re-prime
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
