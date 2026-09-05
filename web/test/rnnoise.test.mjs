import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dbfs } from '../app/dsp.js';

const SAMPLE_RATE = 48000;
const BLOCK = 480;
const SCALE = 32768;
const wasmPath = new URL('../app/rnnoise.wasm', import.meta.url);

const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
assert.deepEqual(WebAssembly.Module.imports(module), [], 'the module must not need imports');
const { exports } = await WebAssembly.instantiate(module, {});
exports._initialize?.();
const state = exports.malloc(exports.rnnoise_get_size());
exports.rnnoise_init(state, 0);
const inputPointer = exports.malloc(BLOCK * 4);
const outputPointer = exports.malloc(BLOCK * 4);
console.log(
  ` ok  module loads: ${fs.statSync(wasmPath).size} bytes, state ${exports.rnnoise_get_size()} bytes, no imports`
);

const seconds = 8;
const total = seconds * SAMPLE_RATE;
let seed = 7;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296 - 0.5;
};
let pink0 = 0;
let pink1 = 0;
let pink2 = 0;
const input = new Float32Array(total);
const voiceMask = new Uint8Array(total);
for (let i = 0; i < total; i++) {
  const white = random();
  pink0 = 0.99765 * pink0 + white * 0.099046;
  pink1 = 0.963 * pink1 + white * 0.2965164;
  pink2 = 0.57 * pink2 + white * 1.0526913;
  const t = i / SAMPLE_RATE;
  let sample =
    (pink0 + pink1 + pink2 + white * 0.1848) * 0.02 +
    0.01 * Math.sin(2 * Math.PI * 60 * t) +
    0.004 * Math.sin(2 * Math.PI * 180 * t);
  const talking = t % 1.5 < 0.8;
  if (talking) {
    const pitch = 130 + 15 * Math.sin(2 * Math.PI * 5 * t);
    const envelope = Math.min(1, Math.min(t % 1.5, 0.8 - (t % 1.5)) / 0.05);
    const harmonics =
      Math.sin(2 * Math.PI * pitch * t) +
      0.6 * Math.sin(2 * Math.PI * 2 * pitch * t) +
      0.4 * Math.sin(2 * Math.PI * 3 * pitch * t) +
      0.25 * Math.sin(2 * Math.PI * 5 * pitch * t) +
      0.15 * Math.sin(2 * Math.PI * 9 * pitch * t);
    sample += envelope * 0.12 * harmonics;
    voiceMask[i] = 1;
  }
  input[i] = sample;
}

const output = new Float32Array(total);
const vad = new Float32Array(total / BLOCK);
const startedAt = performance.now();
for (let block = 0; block * BLOCK < total; block++) {
  const memoryIn = new Float32Array(exports.memory.buffer);
  for (let i = 0; i < BLOCK; i++) {
    memoryIn[inputPointer / 4 + i] = input[block * BLOCK + i] * SCALE;
  }
  vad[block] = exports.rnnoise_process_frame(state, outputPointer, inputPointer);
  const memoryOut = new Float32Array(exports.memory.buffer);
  for (let i = 0; i < BLOCK; i++) {
    output[block * BLOCK + i] = memoryOut[outputPointer / 4 + i] / SCALE;
  }
}
const millisPerFrame = (performance.now() - startedAt) / (total / BLOCK);

const delay = BLOCK;
const gapIn = [];
const gapOut = [];
const talkIn = [];
const talkOut = [];
const vadInGaps = [];
const vadOnWords = [];
for (let i = total / 2; i < total - delay; i++) {
  const phase = (i / SAMPLE_RATE) % 1.5;
  const inGap = phase > 0.95 && phase < 1.4;
  const inTalk = phase > 0.15 && phase < 0.65;
  if (inGap) {
    gapIn.push(input[i]);
    gapOut.push(output[i + delay]);
  }
  if (inTalk) {
    talkIn.push(input[i]);
    talkOut.push(output[i + delay]);
  }
  if (i % BLOCK === 0) {
    const nextBlock = Math.floor(i / BLOCK) + 1;
    if (inGap) {
      vadInGaps.push(vad[nextBlock]);
    }
    if (inTalk) {
      vadOnWords.push(vad[nextBlock]);
    }
  }
}
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const gapDrop = dbfs(Float32Array.from(gapIn)) - dbfs(Float32Array.from(gapOut));
const talkDrop = dbfs(Float32Array.from(talkIn)) - dbfs(Float32Array.from(talkOut));
console.log(` ok  ${millisPerFrame.toFixed(3)} ms per 10 ms frame`);
console.log(
  `     noise between words −${gapDrop.toFixed(1)} dB, words −${talkDrop.toFixed(1)} dB, voice probability ${mean(vadInGaps).toFixed(2)} in gaps vs ${mean(vadOnWords).toFixed(2)} on words`
);
assert.ok(millisPerFrame < 1, 'too slow for the audio thread');
assert.ok(gapDrop > 8, `expected >8 dB on the noise, got ${gapDrop.toFixed(1)}`);
assert.ok(talkDrop < 3, `expected the voice kept within 3 dB, lost ${talkDrop.toFixed(1)}`);
assert.ok(
  mean(vadInGaps) < 0.1 && mean(vadOnWords) > mean(vadInGaps) + 0.1,
  'voice probability should separate words from noise'
);
console.log('\nPASS');
