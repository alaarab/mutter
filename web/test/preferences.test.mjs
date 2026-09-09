import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSettings } from '../app/preferences.js';

test('settings preserve existing appearance and audio choices without sharing mutable defaults', () => {
  assert.equal(normalizeSettings({}).appearance, 'system');
  assert.equal(normalizeSettings({ theme: 'paper' }).appearance, 'light');
  assert.equal(normalizeSettings({ theme: 'plum' }).appearance, 'dark');
  const chosen = normalizeSettings({ theme: 'plum', appearance: 'system', noiseV2: true,
    noiseSuppression: 'off', processing: { noise: true }, bitrate: 64000 });
  assert.equal(chosen.noiseSuppression, 'off');
  assert.equal(chosen.bitrate, 64000);
  assert.equal(chosen.appearance, 'system');
  assert.deepEqual(chosen.processing, { echo: true, noise: true, gain: true });
  const fresh = normalizeSettings({});
  fresh.processing.echo = false;
  fresh.turn.credential = 'session-secret';
  assert.equal(normalizeSettings({}).processing.echo, true);
  assert.equal(normalizeSettings({}).turn.credential, '');
});

test('malformed stored preferences recover to usable settings', () => {
  for (const saved of [null, [], 'invalid', { theme: { toString: null }, transmitMode: 'invalid',
    noiseSuppression: 'invalid', noiseV2: true, processing: null, turn: false, bitrate: 'bad', textSize: null }]) {
    const settings = normalizeSettings(saved);
    assert.equal(settings.theme, 'carbon');
    assert.equal(settings.transmitMode, 'vad');
    assert.equal(settings.noiseSuppression, 'neural');
    assert.equal(settings.bitrate, 40000);
    assert.equal(settings.textSize, 14);
    assert.deepEqual(settings.processing, { echo: true, noise: false, gain: true });
    assert.deepEqual(settings.turn, { url: '', username: '', credential: '' });
  }
});
