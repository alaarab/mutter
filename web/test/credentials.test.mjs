import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEnvironment } from './harness.mjs';

test('browser migrates legacy passwords into memory and never persists replacements', { timeout: 60_000 }, async t => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await environment.browser.newPage(environment.bridge.url);
  await page.eval(`localStorage.setItem('mutter.settings',JSON.stringify({theme:'carbon',turn:{url:'turn:example.invalid',username:'relay',credential:'legacy-turn-secret'}}));
    localStorage.setItem('mutter.servers',JSON.stringify([{host:'example.invalid',port:64738,username:'Test',password:'legacy-server-secret'}]));`);
  await page.goto(environment.bridge.url);
  await page.waitFor('!!window.mutter');
  const read = () => page.eval(`(async () => {
    const store = await import('/app/store.js');
    return { password: store.servers[0].password ?? null, turn: store.settings.turn.credential,
      publicData: JSON.stringify({...localStorage}), label: document.getElementById('rememberLabel').textContent };
  })()`);
  const migrated = await read();
  assert.equal(migrated.password, 'legacy-server-secret');
  assert.equal(migrated.turn, 'legacy-turn-secret');
  assert.ok(!migrated.publicData.includes('legacy-server-secret'));
  assert.ok(!migrated.publicData.includes('legacy-turn-secret'));
  assert.match(migrated.label, /this session/);
  await page.eval(`(async () => {
    const store = await import('/app/store.js');
    store.settings.turn.credential = 'replacement-turn-secret';
    await store.saveSettings();
    await store.rememberServer({host:'example.invalid',port:64738,username:'Test',password:'replacement-server-secret',remember:true});
  })()`);
  assert.ok(!(await read()).publicData.includes('replacement-'));
  await page.goto(environment.bridge.url);
  await page.waitFor('!!window.mutter');
  assert.equal((await read()).password, null);
  assert.equal((await read()).turn, '');
  assert.deepEqual(page.errors(), []);
});

test('browser recovers malformed saved data and treats server hostnames consistently', { timeout: 60_000 }, async t => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await environment.browser.newPage(environment.bridge.url);
  await page.eval(`localStorage.setItem('mutter.settings', JSON.stringify({ theme: {toString: null}, transmitMode: 42, processing: null, turn: [] }));
    localStorage.setItem('mutter.servers', JSON.stringify({host: 'broken'}));
    localStorage.setItem('mutter.certificates', '[]');
    localStorage.setItem('mutter.collapsed', JSON.stringify({'example.invalid': 42}));`);
  await page.goto(environment.bridge.url);
  await page.waitFor('!!window.mutter');
  assert.deepEqual(await page.eval(`(async () => {
    const store = await import('/app/store.js');
    return {servers: store.servers, mode: store.settings.transmitMode,
      collapsed: [...store.collapsedFor('example.invalid').set]};
  })()`), {servers: [], mode: 'vad', collapsed: []});
  await page.eval(`localStorage.setItem('mutter.servers', JSON.stringify([
    null, [], {}, {host: 'bad.invalid', port: -1, username: 'Test'},
    {host: 'Example.invalid', port: 64738, username: 'First'},
    {host: 'example.invalid', port: 64738, username: 'Duplicate'}
  ]));`);
  await page.goto(environment.bridge.url);
  await page.waitFor('!!window.mutter');
  assert.deepEqual(await page.eval(`(async () => {
    const store = await import('/app/store.js');
    const restored = store.servers.map(server => server.username);
    await store.rememberServer({host: 'EXAMPLE.invalid', port: 64738, username: 'Updated'});
    const updated = store.servers.map(server => server.username);
    await store.forgetServer('example.invalid', 64738);
    return {restored, updated, remaining: store.servers.length};
  })()`), {restored: ['First'], updated: ['Updated'], remaining: 0});
  assert.deepEqual(page.errors(), []);
});
