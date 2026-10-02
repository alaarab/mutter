import assert from 'node:assert/strict';
import { JitterPolicy } from '../app/jitter.js';

const FRAME = 960;

function policy() {
  return new JitterPolicy({
    minSamples: FRAME * 3,
    maxSamples: FRAME * 10,
    growSamples: FRAME,
    shrinkSamples: FRAME / 2,
    dangerSamples: FRAME,
    cushionSamples: FRAME,
    calmSecondsBeforeShrink: 15,
  });
}

function calm(subject, seconds, lowWater) {
  let last = null;
  for (let second = 0; second < seconds; second++) {
    last = subject.observe({ underruns: 0, lowWater, active: true });
  }
  return last;
}

const idle = policy();
for (let second = 0; second < 600; second++) {
  idle.observe({ underruns: 0, lowWater: null, active: false });
}
assert.equal(idle.target, FRAME * 3);
assert.equal(idle.calmSeconds, 0);
console.log(' ok  a quiet call never trims the buffer, so speech does not come back to an empty one');

const ranDry = policy();
const grown = ranDry.observe({ underruns: 2, lowWater: 0, active: true });
assert.equal(grown.changed, true);
assert.equal(ranDry.target, FRAME * 4);
console.log(' ok  running dry grows the buffer');

const nearMiss = policy();
const warned = nearMiss.observe({ underruns: 0, lowWater: FRAME - 1, active: true });
assert.equal(warned.changed, true);
assert.equal(nearMiss.target, FRAME * 4);
assert.match(warned.reason, /before running dry/);
console.log(' ok  a near miss grows the buffer before anyone hears a gap');

const steady = policy();
steady.observe({ underruns: 1, lowWater: 0, active: true });
assert.equal(steady.target, FRAME * 4);
assert.equal(calm(steady, 14, FRAME * 3).changed, false);
const trimmed = calm(steady, 1, FRAME * 3);
assert.equal(trimmed.changed, true);
assert.equal(steady.target, FRAME * 3.5);
console.log(' ok  a steady stream with real cushion trims latency back down');

const thin = policy();
thin.observe({ underruns: 1, lowWater: 0, active: true });
assert.equal(calm(thin, 120, FRAME + 1).changed, false);
assert.equal(thin.target, FRAME * 4);
console.log(' ok  a stream that keeps running close to empty is never trimmed');

const jumpy = policy();
jumpy.observe({ underruns: 1, lowWater: 0, active: true });
calm(jumpy, 15, FRAME * 3);
assert.equal(jumpy.requiredCalmSeconds, 15);
jumpy.observe({ underruns: 1, lowWater: 0, active: true });
assert.equal(jumpy.requiredCalmSeconds, 30);
assert.equal(calm(jumpy, 29, FRAME * 3).changed, false);
assert.equal(calm(jumpy, 1, FRAME * 3).changed, true);
console.log(' ok  a trim that backfires doubles the patience before trying again');

const settling = policy();
for (let second = 0; second < 3; second++) {
  settling.observe({ underruns: 1, lowWater: 0, active: true });
}
calm(settling, 15, FRAME * 3);
settling.observe({ underruns: 1, lowWater: 0, active: true });
assert.equal(settling.requiredCalmSeconds, 30);
calm(settling, 30, FRAME * 3);
assert.equal(settling.requiredCalmSeconds, 30);
calm(settling, 30, FRAME * 3);
assert.equal(settling.requiredCalmSeconds, 15);
console.log(' ok  trims that hold relax the patience back toward normal');

const capped = policy();
for (let second = 0; second < 20; second++) {
  capped.observe({ underruns: 1, lowWater: 0, active: true });
}
assert.equal(capped.target, FRAME * 10);
const floored = policy();
assert.equal(calm(floored, 200, FRAME * 5).changed, false);
assert.equal(floored.target, FRAME * 3);
console.log(' ok  the buffer stays between its floor and ceiling');

const processors = new Map();
globalThis.AudioWorkletProcessor = class {
  constructor() {
    const sent = [];
    this.port = { sent, onmessage: null, postMessage: (message) => sent.push(message) };
  }
};
globalThis.registerProcessor = (name, processor) => processors.set(name, processor);
await import('../app/worklets.js');
const Mixer = processors.get('mutter-mixer');
const RENDER_QUANTUM = 128;
const SAMPLES_PER_MILLISECOND = 48;
const SPEAKER = 7;

function startMixer() {
  const mixer = new Mixer();
  mixer.renderedSamples = 0;
  mixer.clockSamples = 0;
  return mixer;
}

function render(mixer, milliseconds) {
  const output = [[new Float32Array(RENDER_QUANTUM), new Float32Array(RENDER_QUANTUM)]];
  mixer.clockSamples += milliseconds * SAMPLES_PER_MILLISECOND;
  while (mixer.renderedSamples + RENDER_QUANTUM <= mixer.clockSamples) {
    mixer.process([], output);
    mixer.renderedSamples += RENDER_QUANTUM;
  }
}

function send(mixer, data) {
  mixer.port.onmessage({ data });
}

function speak(mixer, packets) {
  for (let packet = 0; packet < packets; packet++) {
    send(mixer, { type: 'push', session: SPEAKER, samples: new Float32Array(FRAME).fill(0.1) });
    render(mixer, 20);
  }
}

function underrunsCounted(mixer) {
  const reported = mixer.port.sent.filter((message) => message.type === 'health').reduce((sum, message) => sum + message.underruns, 0);
  return reported + mixer.underruns;
}

const withTerminators = startMixer();
for (let spurt = 0; spurt < 6; spurt++) {
  speak(withTerminators, 25);
  send(withTerminators, { type: 'end', session: SPEAKER });
  render(withTerminators, 700);
}
assert.equal(underrunsCounted(withTerminators), 0);
assert.equal(withTerminators.policy.target, FRAME * 3);
console.log(' ok  talk spurts that end with a terminator drain without an underrun');

const lostTerminators = startMixer();
for (let spurt = 0; spurt < 6; spurt++) {
  speak(lostTerminators, 25);
  render(lostTerminators, 700);
}
assert.equal(underrunsCounted(lostTerminators), 0);
assert.equal(lostTerminators.policy.target, FRAME * 3);
console.log(' ok  spurts whose terminator was lost do not count as underruns or grow the buffer');

const delayedSpurt = startMixer();
speak(delayedSpurt, 12);
render(delayedSpurt, 30);
speak(delayedSpurt, 13);
send(delayedSpurt, { type: 'end', session: SPEAKER });
render(delayedSpurt, 1000);
assert.equal(underrunsCounted(delayedSpurt), 0);
assert.equal(delayedSpurt.policy.target, FRAME * 4);
for (let spurt = 0; spurt < 3; spurt++) {
  speak(delayedSpurt, 25);
  render(delayedSpurt, 700);
}
assert.equal(underrunsCounted(delayedSpurt), 0);
assert.equal(delayedSpurt.policy.target, FRAME * 4);
console.log(' ok  delivery gaps within a spurt grow the buffer before an underrun; later quiet endings do not');

const midStreamGap = startMixer();
speak(midStreamGap, 25);
render(midStreamGap, 100);
speak(midStreamGap, 25);
render(midStreamGap, 1000);
assert.equal(underrunsCounted(midStreamGap), 1);
assert.equal(midStreamGap.policy.target, FRAME * 4);
console.log(' ok  a gap in the middle of speech still counts as an underrun and grows the buffer');

console.log('\nPASS');
