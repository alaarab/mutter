import assert from 'node:assert/strict';
import { FFT, NoiseSuppressor, dbfs } from '../app/dsp.js';

const SAMPLE_RATE = 48000;

function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
}

function concat(parts) {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function runInBlocks(suppressor, samples, blockSize) {
  const parts = [];
  for (let i = 0; i < samples.length; i += blockSize) {
    parts.push(suppressor.process(samples.subarray(i, i + blockSize)));
  }
  return concat(parts);
}

function levelDrop(before, after) {
  return dbfs(Float32Array.from(before)) - dbfs(Float32Array.from(after));
}

{
  const size = 1024;
  const fft = new FFT(size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const original = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    original[i] = Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9);
    re[i] = original[i];
  }
  fft.transform(re, im);
  fft.transform(re, im, true);
  let error = 0;
  for (let i = 0; i < size; i++) {
    error = Math.max(error, Math.abs(re[i] / size - original[i]));
  }
  assert.ok(error < 1e-4, `round-trip error ${error}`);

  re.fill(0);
  im.fill(0);
  for (let i = 0; i < size; i++) {
    re[i] = Math.sin((2 * Math.PI * 64 * i) / size);
  }
  fft.transform(re, im);
  const magnitude = (bin) => Math.hypot(re[bin], im[bin]);
  assert.ok(magnitude(64) > 400 && magnitude(65) < 1 && magnitude(10) < 1, 'tone not isolated in bin 64');
  console.log(` ok  FFT round trip (max error ${error.toExponential(1)}), tone lands in its bin`);
}

{
  const suppressor = new NoiseSuppressor('off');
  const samples = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 7));
  assert.deepEqual(Array.from(suppressor.process(samples)), Array.from(samples));
  console.log(' ok  off passes samples through untouched');
}

{
  const seconds = 6;
  const total = seconds * SAMPLE_RATE;
  const random = makeRandom(12345);
  const noise = new Float32Array(total);
  const speech = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    noise[i] = random() * 0.02;
    const t = i / SAMPLE_RATE;
    const talking = t % 1.5 > 0.8;
    if (talking) {
      const harmonics =
        Math.sin(2 * Math.PI * 200 * t) + 0.5 * Math.sin(2 * Math.PI * 400 * t) + 0.25 * Math.sin(2 * Math.PI * 1200 * t);
      speech[i] = 0.12 * harmonics * (0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t));
    }
  }
  const mixed = noise.map((value, i) => value + speech[i]);
  const strong = runInBlocks(new NoiseSuppressor('strong'), mixed, 960);
  assert.ok(strong.length >= total - 1024 && strong.length <= total, `unexpected output length ${strong.length}`);

  const gapIn = [];
  const gapOut = [];
  const talkIn = [];
  const talkOut = [];
  for (let i = total / 2; i < strong.length; i++) {
    const phase = (i / SAMPLE_RATE) % 1.5;
    if (phase > 0.1 && phase < 0.7) {
      gapIn.push(mixed[i]);
      gapOut.push(strong[i]);
    }
    if (phase > 0.9 && phase < 1.4) {
      talkIn.push(mixed[i]);
      talkOut.push(strong[i]);
    }
  }
  const gapDrop = levelDrop(gapIn, gapOut);
  const talkDrop = levelDrop(talkIn, talkOut);
  assert.ok(gapDrop > 12, `expected silence to drop by >12 dB, got ${gapDrop.toFixed(1)}`);
  assert.ok(talkDrop < 3, `speech should stay within 3 dB, dropped ${talkDrop.toFixed(1)}`);
  console.log(` ok  strong: hiss between words −${gapDrop.toFixed(1)} dB, speech −${talkDrop.toFixed(1)} dB`);

  const light = runInBlocks(new NoiseSuppressor('light'), mixed, 960);
  const lightGapOut = [];
  for (let i = total / 2; i < light.length; i++) {
    const phase = (i / SAMPLE_RATE) % 1.5;
    if (phase > 0.1 && phase < 0.7) {
      lightGapOut.push(light[i]);
    }
  }
  const lightDrop = levelDrop(gapIn, lightGapOut);
  assert.ok(lightDrop > 6 && lightDrop < gapDrop, `light should sit between off and strong, got ${lightDrop.toFixed(1)}`);
  console.log(` ok  light: hiss −${lightDrop.toFixed(1)} dB`);
}

{
  const total = 6 * SAMPLE_RATE;
  const random = makeRandom(777);
  const samples = new Float32Array(total);
  const clickMask = new Uint8Array(total);
  const voiceMask = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / SAMPLE_RATE;
    samples[i] = random() * 0.004;
    if (t % 2 > 1) {
      samples[i] +=
        0.1 * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.3 * Math.sin(2 * Math.PI * 900 * t));
      voiceMask[i] = 1;
    }
    const clickPhase = t % 0.3;
    if (clickPhase < 0.005) {
      samples[i] += random() * 0.5 * (1 - clickPhase / 0.005);
      clickMask[i] = 1;
    }
  }
  const suppressor = new NoiseSuppressor('strong');
  const output = runInBlocks(suppressor, samples, 960);
  const quietIn = [];
  const quietOut = [];
  const overIn = [];
  const overOut = [];
  const voiceIn = [];
  const voiceOut = [];
  for (let i = total / 3; i < output.length; i++) {
    if (clickMask[i]) {
      if (voiceMask[i]) {
        overIn.push(samples[i]);
        overOut.push(output[i]);
      } else {
        quietIn.push(samples[i]);
        quietOut.push(output[i]);
      }
    } else if (voiceMask[i] && !clickMask[Math.max(0, i - 1200)]) {
      voiceIn.push(samples[i]);
      voiceOut.push(output[i]);
    }
  }
  const quietDrop = levelDrop(quietIn, quietOut);
  const overDrop = levelDrop(overIn, overOut);
  const voiceDrop = levelDrop(voiceIn, voiceOut);
  assert.ok(suppressor.clicks > 10, `detector fired only ${suppressor.clicks} times`);
  assert.ok(quietDrop > 8, `clicks between words should drop by >8 dB, got ${quietDrop.toFixed(1)}`);
  assert.ok(Math.abs(voiceDrop) < 3, `voice should be untouched (same ≤3 dB as without clicks), changed by ${voiceDrop.toFixed(1)} dB`);
  const voiceSign = voiceDrop >= 0 ? '−' : '+';
  console.log(
    ` ok  keyboard clicks: between words −${quietDrop.toFixed(1)} dB, over speech −${overDrop.toFixed(1)} dB (voice itself ${voiceSign}${Math.abs(voiceDrop).toFixed(1)} dB, ${suppressor.clicks} click frames)`
  );
}

{
  const samples = Float32Array.from({ length: SAMPLE_RATE }, (_, i) => Math.sin(i / 11) * 0.1 + (((i * 7919) % 13) - 6) / 600);
  const small = runInBlocks(new NoiseSuppressor('strong'), samples, 128);
  const large = runInBlocks(new NoiseSuppressor('strong'), samples, 960);
  assert.equal(small.length, large.length);
  let difference = 0;
  for (let i = 0; i < small.length; i++) {
    difference = Math.max(difference, Math.abs(small[i] - large[i]));
  }
  assert.ok(difference < 1e-5, `block size changed the output by ${difference}`);
  console.log(' ok  output independent of block size');
}

console.log('\nPASS');
