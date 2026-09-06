import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { launch, startBridge } from './browser.mjs';

test('saved servers, settings, and certificate pins survive browser and bridge restarts', { timeout: 30_000 }, async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-persistence-'));
  let bridge;
  let browser;
  t.after(async () => {
    await bridge?.close();
    try { await browser?.close(); }
    finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
  bridge = await startBridge({ port: 8789 });
  browser = await launch({ profile });
  let page = await browser.newPage(bridge.url);
  await page.eval(`(async () => {
    const store = await import('/app/store.js');
    store.settings.pttKey = 'KeyK';
    store.saveSettings();
    store.rememberServer({host:'saved.example', port:64738, username:'SavedUser'});
    store.rememberCertificate({host:'saved.example', port:64738, fingerprint:'${'a'.repeat(64)}'});
  })()`);
  await browser.close();
  browser = null;
  await bridge.close();
  bridge = null;
  bridge = await startBridge({ port: 8789 });
  browser = await launch({ profile });
  page = await browser.newPage(bridge.url);
  const restored = await page.eval(`(async () => {
    const store = await import('/app/store.js');
    return {key:store.settings.pttKey, server:store.servers[0], fingerprint:store.certificateFor('saved.example', 64738)};
  })()`);
  assert.equal(restored.key, 'KeyK');
  assert.equal(restored.server.host, 'saved.example');
  assert.equal(restored.server.username, 'SavedUser');
  assert.equal(restored.fingerprint, 'a'.repeat(64));
});
