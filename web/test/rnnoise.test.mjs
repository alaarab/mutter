// The vendored RNNoise WebAssembly: loads with no imports, runs fast, cuts realistic background
// noise between words, keeps the words, and its voice probability separates the two.
//
//   node web/test/rnnoise.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dbfs } from '../app/dsp.js';

const mod = await WebAssembly.compile(fs.readFileSync(new URL('../app/rnnoise.wasm', import.meta.url)));
assert.deepEqual(WebAssembly.Module.imports(mod), [], 'the module must not need imports');
const { exports: w } = await WebAssembly.instantiate(mod, {});
w._initialize?.();
const st = w.malloc(w.rnnoise_get_size()); w.rnnoise_init(st, 0);
const inP = w.malloc(480 * 4), outP = w.malloc(480 * 4);
console.log(` ok  module loads: ${fs.statSync(new URL('../app/rnnoise.wasm', import.meta.url)).size} bytes, state ${w.rnnoise_get_size()} bytes, no imports`);

// Pink-ish hiss (a few one-pole filters over white noise) plus mains hum, at a realistic level,
// with "words": vibrato harmonics on a 130 Hz voice, 0.8 s on / 0.7 s off.
const rate = 48000, seconds = 8, total = seconds * rate;
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
let b0 = 0, b1 = 0, b2 = 0;
const x = new Float32Array(total), voice = new Uint8Array(total);
for (let i = 0; i < total; i++) {
  const wn = rnd();
  b0 = 0.99765 * b0 + wn * 0.0990460; b1 = 0.96300 * b1 + wn * 0.2965164; b2 = 0.57000 * b2 + wn * 1.0526913;
  const t = i / rate;
  let s = (b0 + b1 + b2 + wn * 0.1848) * 0.02 + 0.01 * Math.sin(2 * Math.PI * 60 * t) + 0.004 * Math.sin(2 * Math.PI * 180 * t);
  const on = (t % 1.5) < 0.8;
  if (on) {
    const f0 = 130 + 15 * Math.sin(2 * Math.PI * 5 * t);
    const env = Math.min(1, Math.min(t % 1.5, 0.8 - (t % 1.5)) / 0.05);
    s += env * 0.12 * (Math.sin(2 * Math.PI * f0 * t) + 0.6 * Math.sin(2 * Math.PI * 2 * f0 * t) + 0.4 * Math.sin(2 * Math.PI * 3 * f0 * t) + 0.25 * Math.sin(2 * Math.PI * 5 * f0 * t) + 0.15 * Math.sin(2 * Math.PI * 9 * f0 * t));
    voice[i] = 1;
  }
  x[i] = s;
}
const out = new Float32Array(total), vad = new Float32Array(total / 480);
const t0 = performance.now();
for (let f = 0; f * 480 < total; f++) {
  const m = new Float32Array(w.memory.buffer);
  for (let i = 0; i < 480; i++) m[inP / 4 + i] = x[f * 480 + i] * 32768;
  vad[f] = w.rnnoise_process_frame(st, outP, inP);
  const m2 = new Float32Array(w.memory.buffer);
  for (let i = 0; i < 480; i++) out[f * 480 + i] = m2[outP / 4 + i] / 32768;
}
const perFrame = (performance.now() - t0) / (total / 480);

// Output lags input by one frame (480). Measure from the second half, well inside each region.
const D = 480, gapIn = [], gapOut = [], talkIn = [], talkOut = [], vadGap = [], vadTalk = [];
for (let i = total / 2; i < total - D; i++) {
  const t = i / rate, ph = t % 1.5, inGap = ph > 0.95 && ph < 1.4, inTalk = ph > 0.15 && ph < 0.65;
  if (inGap) { gapIn.push(x[i]); gapOut.push(out[i + D]); }
  if (inTalk) { talkIn.push(x[i]); talkOut.push(out[i + D]); }
  if (i % 480 === 0) { if (inGap) vadGap.push(vad[Math.floor(i / 480) + 1]); if (inTalk) vadTalk.push(vad[Math.floor(i / 480) + 1]); }
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const gapDrop = dbfs(Float32Array.from(gapIn)) - dbfs(Float32Array.from(gapOut));
const talkDrop = dbfs(Float32Array.from(talkIn)) - dbfs(Float32Array.from(talkOut));
console.log(` ok  ${perFrame.toFixed(3)} ms per 10 ms frame`);
console.log(`     noise between words −${gapDrop.toFixed(1)} dB, words −${talkDrop.toFixed(1)} dB, voice probability ${mean(vadGap).toFixed(2)} in gaps vs ${mean(vadTalk).toFixed(2)} on words`);
assert.ok(perFrame < 1, 'too slow for the audio thread');
assert.ok(gapDrop > 8, `expected >8 dB on the noise, got ${gapDrop.toFixed(1)}`);
assert.ok(talkDrop < 3, `expected the voice kept within 3 dB, lost ${talkDrop.toFixed(1)}`);
// A vibrato tone is not speech, so its probability stays modest; the point is that noise scores ~0.
assert.ok(mean(vadGap) < 0.1 && mean(vadTalk) > mean(vadGap) + 0.1, 'voice probability should separate words from noise');
console.log('\nPASS');
