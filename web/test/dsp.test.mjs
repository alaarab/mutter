// The noise suppressor, in Node: FFT round trip, pass-through when off, and a measurable
// improvement in signal-to-noise on speech-like tone bursts over white noise.
//
//   node web/test/dsp.test.mjs

import assert from 'node:assert/strict';
import { FFT, NoiseSuppressor, dbfs } from '../app/dsp.js';

// 1. FFT round trip
{
  const n = 1024, fft = new FFT(n);
  const re = new Float32Array(n), im = new Float32Array(n), orig = new Float32Array(n);
  for (let i = 0; i < n; i++) orig[i] = re[i] = Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9);
  fft.transform(re, im); fft.transform(re, im, true);
  let err = 0;
  for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] / n - orig[i]));
  assert.ok(err < 1e-4, `round-trip error ${err}`);
  // A pure tone lands in one bin.
  re.fill(0); im.fill(0);
  for (let i = 0; i < n; i++) re[i] = Math.sin(2 * Math.PI * 64 * i / n);
  fft.transform(re, im);
  const mag = k => Math.hypot(re[k], im[k]);
  assert.ok(mag(64) > 400 && mag(65) < 1 && mag(10) < 1, 'tone not isolated in bin 64');
  console.log(` ok  FFT round trip (max error ${err.toExponential(1)}), tone lands in its bin`);
}

const concat = parts => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const run = (s, x, block) => { const parts = []; for (let i = 0; i < x.length; i += block) parts.push(s.process(x.subarray(i, i + block))); return concat(parts); };

// 2. off = pass-through with no delay
{
  const s = new NoiseSuppressor('off');
  const x = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 7));
  assert.deepEqual(Array.from(s.process(x)), Array.from(x));
  console.log(' ok  off passes samples through untouched');
}

// 3. white noise with intermittent 200 Hz+harmonics "speech" bursts: SNR must improve
{
  const seconds = 6, rate = 48000, total = seconds * rate;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const noise = new Float32Array(total), speech = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    noise[i] = rnd() * 0.02;                                            // ≈ −45 dBFS hiss
    const t = i / rate, on = (t % 1.5) > 0.8;                           // talk 0.7 s of every 1.5 s
    if (on) speech[i] = 0.12 * (Math.sin(2 * Math.PI * 200 * t) + 0.5 * Math.sin(2 * Math.PI * 400 * t) + 0.25 * Math.sin(2 * Math.PI * 1200 * t)) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t));
  }
  const mixed = noise.map((v, i) => v + speech[i]);
  const out = run(new NoiseSuppressor('strong'), mixed, 960);
  assert.ok(out.length >= total - 1024 && out.length <= total, `unexpected output length ${out.length}`);

  // Measure over the second half (estimates settled). Silence = the gaps; speech = the bursts.
  // Output sample j is input sample j; the buffering only delays when it becomes available.
  const gapIn = [], gapOut = [], talkIn = [], talkOut = [];
  for (let i = total / 2; i < out.length; i++) {
    const t = i / rate, phase = t % 1.5;
    if (phase > 0.1 && phase < 0.7) { gapIn.push(mixed[i]); gapOut.push(out[i]); }
    if (phase > 0.9 && phase < 1.4) { talkIn.push(mixed[i]); talkOut.push(out[i]); }
  }
  const gapDrop = dbfs(Float32Array.from(gapIn)) - dbfs(Float32Array.from(gapOut));
  const talkDrop = dbfs(Float32Array.from(talkIn)) - dbfs(Float32Array.from(talkOut));
  assert.ok(gapDrop > 12, `expected silence to drop by >12 dB, got ${gapDrop.toFixed(1)}`);
  assert.ok(talkDrop < 3, `speech should stay within 3 dB, dropped ${talkDrop.toFixed(1)}`);
  console.log(` ok  strong: hiss between words −${gapDrop.toFixed(1)} dB, speech −${talkDrop.toFixed(1)} dB`);

  const outL = run(new NoiseSuppressor('light'), mixed, 960);
  const gapOutL = [];
  for (let i = total / 2; i < outL.length; i++) { const phase = (i / rate) % 1.5; if (phase > 0.1 && phase < 0.7) gapOutL.push(outL[i]); }
  const lightDrop = dbfs(Float32Array.from(gapIn)) - dbfs(Float32Array.from(gapOutL));
  assert.ok(lightDrop > 6 && lightDrop < gapDrop, `light should sit between off and strong, got ${lightDrop.toFixed(1)}`);
  console.log(` ok  light: hiss −${lightDrop.toFixed(1)} dB`);
}

// 4. keyboard clicks (5 ms broadband bursts) between and during words are ducked; the voice isn't
{
  const rate = 48000, total = 6 * rate;
  let seed = 777;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  const x = new Float32Array(total), clickMask = new Uint8Array(total), voiceMask = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    x[i] = rnd() * 0.004;                                                       // faint room noise
    const talking = (t % 2) > 1;                                                // 1 s on, 1 s off
    if (talking) { x[i] += 0.1 * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.3 * Math.sin(2 * Math.PI * 900 * t)); voiceMask[i] = 1; }
    const phase = t % 0.3;                                                      // a key every 300 ms
    if (phase < 0.005) { x[i] += rnd() * 0.5 * (1 - phase / 0.005); clickMask[i] = 1; }
  }
  const s = new NoiseSuppressor('strong');
  const out = run(s, x, 960);
  const quietIn = [], quietOut = [], overIn = [], overOut = [], voiceIn = [], voiceOut = [];
  for (let i = total / 3; i < out.length; i++) {
    if (clickMask[i]) { if (voiceMask[i]) { overIn.push(x[i]); overOut.push(out[i]); } else { quietIn.push(x[i]); quietOut.push(out[i]); } }
    else if (voiceMask[i] && !clickMask[Math.max(0, i - 1200)]) { voiceIn.push(x[i]); voiceOut.push(out[i]); }
  }
  const drop = (a, b) => dbfs(Float32Array.from(a)) - dbfs(Float32Array.from(b));
  const quietDrop = drop(quietIn, quietOut), overDrop = drop(overIn, overOut), voiceDrop = drop(voiceIn, voiceOut);
  assert.ok(s.clicks > 10, `detector fired only ${s.clicks} times`);
  assert.ok(quietDrop > 8, `clicks between words should drop by >8 dB, got ${quietDrop.toFixed(1)}`);
  assert.ok(Math.abs(voiceDrop) < 3, `voice should be untouched (same ≤3 dB as without clicks), changed by ${voiceDrop.toFixed(1)} dB`);
  console.log(` ok  keyboard clicks: between words −${quietDrop.toFixed(1)} dB, over speech −${overDrop.toFixed(1)} dB (voice itself ${voiceDrop >= 0 ? '−' : '+'}${Math.abs(voiceDrop).toFixed(1)} dB, ${s.clicks} click frames)`);
}

// 5. odd block sizes (128-sample render quanta) produce the same output as 960-sample blocks
{
  const x = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 11) * 0.1 + ((i * 7919) % 13 - 6) / 600);
  const ya = run(new NoiseSuppressor('strong'), x, 128), yb = run(new NoiseSuppressor('strong'), x, 960);
  assert.equal(ya.length, yb.length);
  let diff = 0;
  for (let i = 0; i < ya.length; i++) diff = Math.max(diff, Math.abs(ya[i] - yb[i]));
  assert.ok(diff < 1e-5, `block size changed the output by ${diff}`);
  console.log(' ok  output independent of block size');
}

console.log('\nPASS');
