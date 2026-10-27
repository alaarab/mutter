import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { startEnvironment, openClient, sleep } from './harness.mjs';

const LOST = 'Lost on the way, send me again';
const own = `[...document.querySelectorAll('#messages .row.own')].at(-1)`;
const rowsWith = (text) => `[...document.querySelectorAll('#messages .row .content')].filter((content) => content.textContent === ${JSON.stringify(text)}).length`;

async function sendFromComposer(page, text) {
  await page.eval(`(() => {
    const input = document.getElementById('chatInput');
    input.value = ${JSON.stringify(text)};
    document.getElementById('sendBtn').click();
  })()`);
}

async function shoot(environment, page, name) {
  if (!environment.shots) return;
  for (const appearance of ['light', 'dark']) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: appearance }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.waitFor(`document.documentElement.dataset.appearance === '${appearance}'`);
    await sleep(200);
    await page.screenshot(path.join(environment.shots, `retry-${name}-${appearance}.png`));
  }
}

test('a message lost with the connection can be sent again once reconnected, and only once', { timeout: 90_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const reader = await openClient(environment, 'Reader');
  const writer = await openClient(environment, 'Writer');
  await writer.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 760, deviceScaleFactor: 1, mobile: false });

  await sendFromComposer(writer, 'This one makes it');
  await writer.waitFor(`!!${own}?.querySelector('.receipt.delivered')`, { label: 'the first message was confirmed' });

  environment.server.stall('Writer');
  await sendFromComposer(writer, LOST);
  await writer.waitFor(`${own}.querySelector('.content').textContent === ${JSON.stringify(LOST)}`);
  const lostId = await writer.eval(`${own}.dataset.id`);
  environment.server.drop('Writer');
  await writer.waitFor(`${own}.classList.contains('failed')`, { label: 'the unconfirmed message failed with the connection' });
  assert.match(await writer.eval(`${own}.querySelector('.failed-note').textContent`), /^Not delivered · connection lost before the server confirmed it/);
  assert.equal(await writer.eval(`${own}.querySelector('.failed-note .retry').getAttribute('aria-label')`), 'Try again, message not delivered');
  assert.ok(await writer.eval(`!!${own}.querySelector('.tools .retry')`), 'the hover toolbar offers Retry too');
  await writer.waitFor(`mutter.client.state === 'reconnecting'`);
  await writer.waitFor(`[...${own}.querySelectorAll('.retry')].every((button) => button.disabled)`, { label: 'Retry waits for the connection' });
  assert.equal(await writer.eval(`mutter.client.retryText(mutter.client.messages.find((message) => message.id === ${JSON.stringify(lostId)}))`), false);

  await writer.waitFor(`mutter.client.state === 'connected'`, { timeout: 20_000, label: 'the client reconnected by itself' });
  await writer.waitFor(`[...${own}.querySelectorAll('.retry')].every((button) => !button.disabled)`, { label: 'Retry is ready once connected' });
  await writer.eval(`${own}.querySelector('.failed-note .retry').focus()`);
  await shoot(environment, writer, 'failed');

  await writer.eval(`(() => {
    const button = ${own}.querySelector('.failed-note .retry');
    button.click();
    button.click();
  })()`);
  await writer.waitFor(`!!${own}?.querySelector('.receipt.delivered')`, { label: 'the resent message was confirmed' });
  assert.equal(await writer.eval(`document.querySelector('#messages [data-id="${lostId}"]')`), null, 'the failed row is gone');
  assert.equal(await writer.eval(`${own}.querySelector('.content').textContent`), LOST, 'the resend is the newest message');
  assert.equal(await writer.eval(`document.querySelectorAll('#messages .row.failed').length`), 0);
  assert.equal(await writer.eval(rowsWith(LOST)), 1);
  assert.equal(await writer.eval(`mutter.client.messages.filter((message) => message.html.includes('Lost on the way')).length`), 1);
  assert.equal(await writer.eval(`document.querySelectorAll('#messages .divider.day').length`), 1, 'no stray day divider');

  await reader.waitFor(`${rowsWith(LOST)} === 1`, { label: 'the reader got the resend' });
  await sleep(500);
  assert.equal(await reader.eval(rowsWith(LOST)), 1, 'the reader got it exactly once');
  await writer.eval(`document.activeElement?.blur()`);
  await shoot(environment, writer, 'resent');

  environment.server.config.messageLength = 20;
  await sendFromComposer(writer, 'This one is far too long for the server');
  await writer.waitFor(`${own}.classList.contains('failed')`, { label: 'the refused message is marked' });
  assert.equal(await writer.eval(`${own}.querySelectorAll('.retry').length`), 0, 'a refusal cannot be retried');
  assert.equal(await writer.eval(`mutter.client.retryText(mutter.client.messages.at(-1))`), false);

  assert.deepEqual(reader.errors(), []);
  assert.deepEqual(writer.errors(), []);
});
