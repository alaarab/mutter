import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEnvironment } from './harness.mjs';

test('certificate approval, cancellation, pin reuse, and changed-certificate warnings', { timeout: 60_000 }, async t => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const { server, browser, bridge } = environment;
  const page = await browser.newPage(`${bridge.url}/?source=tone`);
  await page.type('#host', '127.0.0.1');
  await page.type('#port', String(server.port));
  await page.type('#username', 'TrustTest');
  const pinKey = JSON.stringify(['127.0.0.1', server.port]);
  const pin = () => page.eval(`JSON.parse(localStorage.getItem('mutter.certificates') ?? '{}')[${JSON.stringify(pinKey)}] ?? null`);
  const prompt = () => page.waitFor(`document.getElementById('certificateDialog').open`);
  const connected = () => page.waitFor(`mutter.client.state === 'connected'`);
  const disconnected = () => page.waitFor(`mutter.client.state === 'disconnected'`);

  await page.click('#connectBtn');
  await prompt();
  assert.equal(server.users.size, 0);
  assert.equal(await pin(), null);
  assert.equal(await page.eval(`document.querySelector('#certificateDialog button:focus').value`), 'cancel');
  await page.click('#certificateDialog button[value="cancel"]');
  await disconnected();
  assert.equal(await pin(), null);
  assert.equal(server.users.size, 0);

  await page.click('#connectBtn');
  await prompt();
  if (environment.shots) await page.screenshot(`${environment.shots}/certificate-trust.png`);
  await page.click('#certificateTrustBtn');
  await connected();
  assert.equal(await pin(), server.fingerprint);
  await page.click('#leaveBtn');
  await disconnected();
  await page.click('#connectBtn');
  await connected();
  assert.equal(await page.eval(`document.getElementById('certificateDialog').open`), false);

  await page.click('#leaveBtn');
  await disconnected();
  await page.eval(`localStorage.setItem('mutter.certificates', JSON.stringify({[${JSON.stringify(pinKey)}]: '${'0'.repeat(64)}'}))`);
  await page.click('#connectBtn');
  await prompt();
  assert.equal(await page.eval(`document.getElementById('certificateTitle').textContent`), 'Server certificate changed');
  assert.equal(await page.eval(`document.getElementById('certificatePrevious').hidden`), false);
  await page.click('#certificateDialog button[value="cancel"]');
  await disconnected();
  assert.equal(await pin(), '0'.repeat(64));

  await page.click('#connectBtn');
  await prompt();
  await page.eval('mutter.client.disconnect()');
  await disconnected();
  await page.waitFor(`!document.getElementById('certificateDialog').open`);
  assert.equal(await pin(), '0'.repeat(64));
  assert.deepEqual(page.errors(), []);
});
