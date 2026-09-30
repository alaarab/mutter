import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEnvironment, openClient, sleep } from './harness.mjs';

const DISTANCE_FROM_BOTTOM = `(() => {
  const box = document.getElementById('messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight;
})()`;

const ROW_COUNT = `document.querySelectorAll('#messages .row').length`;

test('the latest message stays in view when the chat shrinks or a picture loads', { timeout: 90_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const reader = await openClient(environment, 'Reader');
  const writer = await openClient(environment, 'Writer');
  const messageCount = 40;

  await writer.eval(`(() => {
    for (let line = 1; line <= ${messageCount}; line++) {
      mutter.client.sendText('Scroll check ' + line);
    }
  })()`);
  await reader.waitFor(`${ROW_COUNT} >= ${messageCount}`, { label: 'every message arrived' });
  await reader.send('Page.bringToFront');
  await sleep(300);
  assert.ok((await reader.eval(DISTANCE_FROM_BOTTOM)) < 2, 'the reader starts at the latest message');

  await reader.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 420, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  assert.ok((await reader.eval(DISTANCE_FROM_BOTTOM)) < 2, 'a shorter window, like an on-screen keyboard, keeps the latest message in view');

  await writer.eval(`(async () => {
    const canvas = new OffscreenCanvas(64, 480);
    const context = canvas.getContext('2d');
    context.fillStyle = '#3a6';
    context.fillRect(0, 0, 64, 480);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const base64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
    mutter.client.sendText('<img src="data:image/png;base64,' + base64 + '">');
  })()`);
  await reader.waitFor(
    `[...document.querySelectorAll('#messages .row img')].some((image) => image.complete && image.naturalHeight === 480)`,
    { timeout: 10_000, label: 'the picture loaded' }
  );
  await sleep(300);
  assert.ok((await reader.eval(DISTANCE_FROM_BOTTOM)) < 2, 'a picture that finishes loading keeps the latest message in view');

  await reader.eval(`document.getElementById('messages').scrollTop = 0`);
  await sleep(200);
  await reader.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  assert.equal(await reader.eval(`document.getElementById('messages').scrollTop`), 0, 'someone reading older messages is left where they are');
  assert.deepEqual(reader.errors(), []);
  assert.deepEqual(writer.errors(), []);
});
