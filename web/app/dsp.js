// Signal processing shared by the capture worklet and the tests. Plain ES module, no DOM, so
// it runs on the audio render thread and under Node alike.

/// In-place radix-2 complex FFT. `re`/`im` are Float32Arrays whose length is a power of two.
export class FFT {
  constructor(n) {
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1); this.rev[i] = r; }
    this.cos = new Float32Array(n / 2); this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = Math.sin(2 * Math.PI * i / n); }
  }
  transform(re, im, inverse = false) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t], wi = inverse ? sin[t] : -sin[t];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

/// Streaming spectral noise suppressor — a port of NoiseSuppressor.swift from the iOS app.
///
/// 1024-point frames at 48 kHz with 50% overlap and sqrt-Hann windows, a per-bin noise
/// estimate that adapts quickly to noise-like frames and slowly during speech, a
/// decision-directed a-priori SNR (Ephraim–Malah) and a Wiener gain with a floor against
/// musical noise. Bins below ~90 Hz are dropped, which doubles as a rumble filter. Removes
/// stationary noise (hiss, fans, hum) on top of whatever the browser's own suppression does.
export class NoiseSuppressor {
  static LEVELS = {
    off: { gainFloor: 1, overSubtraction: 1 },
    light: { gainFloor: 0.316, overSubtraction: 1.2 },     // floor −10 dB
    strong: { gainFloor: 0.08, overSubtraction: 1.6 },     // floor −22 dB
  };

  constructor(level = 'strong') {
    this.n = 1024; this.hop = 512; this.half = 512; this.lowCutBin = 2;
    this.fft = new FFT(this.n);
    this.window = new Float32Array(this.n);
    for (let k = 0; k < this.n; k++) this.window[k] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * k / this.n));
    this.re = new Float32Array(this.n); this.im = new Float32Array(this.n);
    this.inBuf = new Float32Array(this.n); this.inFill = 0;
    this.overlap = new Float32Array(this.n);
    this.noise = new Float32Array(this.half + 1).fill(1e-6);
    this.prevGain = new Float32Array(this.half + 1).fill(1);
    this.prevPower = new Float32Array(this.half + 1);
    this.gain = new Float32Array(this.half + 1).fill(1);
    this.power = new Float32Array(this.half + 1);
    this.frameCount = 0;
    this.level = level;
    this.hfEnvDb = -60; this.lfEnvDb = -60; this.clickRun = 0;   // click detector state
    this.clicks = 0;
  }

  /// Feed samples in, get processed samples out: a Float32Array whose length is whatever the
  /// overlap-add has completed (multiples of 512, ~10 ms behind). Off passes input straight
  /// through with no delay.
  process(input) {
    if (this.level === 'off') { if (this.inFill) this.reset(); return input; }
    const chunks = [];
    let i = 0;
    while (i < input.length) {
      const take = Math.min(this.n - this.inFill, input.length - i);
      this.inBuf.set(input.subarray(i, i + take), this.inFill);
      this.inFill += take; i += take;
      if (this.inFill === this.n) {
        this._frame();
        chunks.push(this.overlap.slice(0, this.hop));
        this.overlap.copyWithin(0, this.hop); this.overlap.fill(0, this.n - this.hop);
        this.inBuf.copyWithin(0, this.hop); this.inFill = this.n - this.hop;
      }
    }
    if (chunks.length === 1) return chunks[0];
    const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  reset() {
    this.inFill = 0; this.inBuf.fill(0); this.overlap.fill(0);
    this.noise.fill(1e-6); this.prevGain.fill(1); this.prevPower.fill(0); this.frameCount = 0;
    this.hfEnvDb = -60; this.lfEnvDb = -60; this.clickRun = 0;
  }

  _frame() {
    const { n, half, re, im, window, noise, prevGain, prevPower, gain, power } = this;
    const { gainFloor, overSubtraction } = NoiseSuppressor.LEVELS[this.level] ?? NoiseSuppressor.LEVELS.strong;
    for (let k = 0; k < n; k++) { re[k] = this.inBuf[k] * window[k]; im[k] = 0; }
    this.fft.transform(re, im);
    for (let k = 0; k <= half; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    // Keyboard clicks: a sudden broadband burst whose energy sits above 3 kHz while the voice
    // band under 1 kHz barely moved. Spectral subtraction can't see them (they aren't
    // stationary), so on Strong the frame's high band is ducked instead. Voiced speech onsets
    // carry low-band energy and are left alone; an isolated "s" loses at most one 10 ms frame.
    let total = 0, lf = 0, hf = 0;
    for (let k = 1; k <= half; k++) { const p = power[k]; total += p; if (k < 22) lf += p; else if (k >= 64) hf += p; }
    const lfDb = 10 * Math.log10(lf / n + 1e-12), hfDb = 10 * Math.log10(hf / n + 1e-12);
    // The high band jumped ≥12 dB over its own envelope, and either the frame is mostly high band
    // (click in silence) or the voice band held steady (click over speech). Three frames at most,
    // so a sustained "s" is speech, not a click.
    const click = this.level === 'strong' && this.frameCount > 8 && hfDb - this.hfEnvDb > 12 && (hf / (total + 1e-12) > 0.55 || lfDb - this.lfEnvDb < 6) && this.clickRun < 3;
    if (click) { this.clickRun++; this.clicks++; }
    else { this.clickRun = 0; this.hfEnvDb += (hfDb > this.hfEnvDb ? 0.08 : 0.02) * (hfDb - this.hfEnvDb); this.lfEnvDb += (lfDb > this.lfEnvDb ? 0.08 : 0.02) * (lfDb - this.lfEnvDb); }

    const warmingUp = ++this.frameCount <= 8;
    for (let k = 0; k <= half; k++) {
      const p = power[k];
      if (warmingUp) noise[k] = Math.max(p, 1e-8);
      else if (!click) {
        const post = p / Math.max(noise[k], 1e-10);
        noise[k] = Math.max(noise[k] + (post < 3 ? 0.06 : 0.0025) * (p - noise[k]), 1e-8);
      }
      const nEst = noise[k] * overSubtraction;
      const instantaneous = Math.max(p / nEst - 1, 0);
      const prior = 0.98 * (prevGain[k] * prevGain[k] * prevPower[k] / nEst) + 0.02 * instantaneous;
      let g = Math.max(prior / (1 + prior), gainFloor);
      if (k < this.lowCutBin) g = 0;
      gain[k] = g; prevGain[k] = g; prevPower[k] = p;
    }
    let prev = gain[0];
    for (let k = 1; k < half; k++) { const cur = gain[k]; gain[k] = 0.25 * prev + 0.5 * cur + 0.25 * gain[k + 1]; prev = cur; }
    if (click) for (let k = 32; k <= half; k++) gain[k] *= 0.1;       // −20 dB above 1.5 kHz for this frame

    for (let k = 0; k <= half; k++) { re[k] *= gain[k]; im[k] *= gain[k]; }
    for (let k = 1; k < half; k++) { re[n - k] = re[k]; im[n - k] = -im[k]; }   // keep the spectrum Hermitian
    this.fft.transform(re, im, true);
    const scale = 1 / n;
    for (let k = 0; k < n; k++) this.overlap[k] += re[k] * scale * window[k];
  }
}

/// RMS level in dBFS of a Float32Array.
export function dbfs(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return 20 * Math.log10(Math.sqrt(sum / samples.length) + 1e-9);
}
