import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEnvironment, openClient } from './harness.mjs';

const MARKDOWN = 'Plan for **tonight**:\n- bring `snacks`\n- _maybe_ games\n```\nnpm run raid\n  --loud\n```';

async function sendFromComposer(page, text) {
  await page.eval(`(() => {
    const input = document.getElementById('chatInput');
    input.value = ${JSON.stringify(text)};
    document.getElementById('sendBtn').click();
  })()`);
}

test('Markdown is sent as HTML, shown formatted, copied as text, and own messages show delivery', { timeout: 90_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const reader = await openClient(environment, 'Reader');
  const writer = await openClient(environment, 'Writer');

  await sendFromComposer(writer, MARKDOWN);
  const received = `[...document.querySelectorAll('#messages .row:not(.own) .content')].at(-1)`;
  await reader.waitFor(`!!${received}?.querySelector('pre')`, { label: 'the formatted message arrived' });
  assert.equal(await reader.eval(`${received}.querySelector('b').textContent`), 'tonight');
  assert.deepEqual(await reader.eval(`[...${received}.querySelectorAll('li')].map(item => item.textContent)`), ['bring snacks', 'maybe games']);
  assert.equal(await reader.eval(`${received}.querySelector('li code').textContent`), 'snacks');
  assert.equal(await reader.eval(`${received}.querySelector('.code-block pre').textContent`), 'npm run raid\n  --loud');
  assert.ok(await reader.eval(`!!${received}.querySelector('.code-block .code-copy')`), 'code blocks offer their own Copy button');

  const own = `[...document.querySelectorAll('#messages .row.own')].at(-1)`;
  await writer.waitFor(`!!${own}?.querySelector('.receipt.delivered')`, { label: 'the server confirmed the message' });
  assert.equal(await writer.eval(`${own}.querySelector('.receipt').getAttribute('aria-label')`), 'Delivered to the server');
  assert.equal(await reader.eval(`document.querySelectorAll('#messages .row:not(.own) .receipt').length`), 0, 'only your own messages carry ticks');

  const transcript = await reader.eval(`(async () => {
    const { transcriptText } = await import('/app/messages.js');
    return transcriptText(mutter.client.messages);
  })()`);
  assert.match(transcript, /^Writer · .+\nPlan for tonight:\n- bring snacks\n- maybe games\nnpm run raid\n {2}--loud$/m);
  assert.ok(await reader.eval(`!document.getElementById('copyChatBtn').hidden`), 'the chat header offers Copy conversation');

  environment.server.config.messageLength = 20;
  await sendFromComposer(writer, 'This one is far too long for the server');
  await writer.waitFor(`${own}.classList.contains('failed')`, { label: 'the refused message is marked' });
  assert.equal(await writer.eval(`${own}.querySelector('.receipt')`), null, 'a refused message shows no ticks');
  assert.match(await writer.eval(`${own}.querySelector('.failed-note').textContent`), /^Not delivered/);
  assert.ok(
    await writer.eval(`[...document.querySelectorAll('#messages .row.own')].at(-2).querySelector('.receipt.delivered') !== null`),
    'the refusal is pinned on the message it was about, not an earlier one'
  );
  assert.deepEqual(reader.errors(), []);
  assert.deepEqual(writer.errors(), []);
});
