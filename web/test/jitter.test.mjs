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
assert.match(warned.reason, /close to running dry/);
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

const capped = policy();
for (let second = 0; second < 20; second++) {
  capped.observe({ underruns: 1, lowWater: 0, active: true });
}
assert.equal(capped.target, FRAME * 10);
const floored = policy();
assert.equal(calm(floored, 200, FRAME * 5).changed, false);
assert.equal(floored.target, FRAME * 3);
console.log(' ok  the buffer stays between its floor and ceiling');

console.log('\nPASS');
