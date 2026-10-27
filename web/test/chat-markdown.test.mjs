import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEnvironment, openClient } from './harness.mjs';

const PYTHON = [
  'import sys',
  '',
  'def greet(name):',
  '    print("hello", name)',
  '',
  'for index in range(3):  # loop',
  ...Array.from({ length: 14 }, (_, line) => `    greet(${line})`),
].join('\n');
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
  assert.equal(await reader.eval(`${received}.querySelector('.code-lang').textContent`), 'bash', 'an unlabelled npm command is guessed as shell');
  assert.equal(await reader.eval(`${received}.querySelector('.code-toggle').getAttribute('aria-expanded')`), 'true', 'short blocks start open');

  const own = `[...document.querySelectorAll('#messages .row.own')].at(-1)`;
  await writer.waitFor(`!!${own}?.querySelector('.receipt.delivered')`, { label: 'the first message was confirmed' });
  await sendFromComposer(writer, 'Try this:\n```python\n' + PYTHON + '\n```');
  await reader.waitFor(`!!${received}?.querySelector('code.language-python')`, { label: 'the python block arrived with its language' });
  const block = `${received}.querySelector('.code-block')`;
  assert.equal(await reader.eval(`${block}.querySelector('.code-lang').textContent`), 'python');
  assert.equal(await reader.eval(`${block}.querySelector('.code-lines').textContent`), '20 lines');
  assert.deepEqual(
    await reader.eval(`[...${block}.querySelectorAll('.tok-keyword')].slice(0, 3).map(span => span.textContent)`),
    ['import', 'def', 'for'],
    'keywords are coloured'
  );
  assert.ok(await reader.eval(`${block}.querySelector('.tok-string')?.textContent === '"hello"'`), 'strings are coloured');
  assert.ok(await reader.eval(`${block}.querySelector('.tok-comment')?.textContent === '# loop'`), 'comments are coloured');
  assert.equal(await reader.eval(`${block}.querySelector('pre').textContent`), PYTHON, 'colouring keeps the code exactly');
  assert.ok(await reader.eval(`${block}.classList.contains('collapsed')`), 'long blocks start folded');
  assert.equal(await reader.eval(`${block}.querySelector('.code-toggle').getAttribute('aria-expanded')`), 'false');
  assert.equal(await reader.eval(`${block}.querySelector('.code-more').textContent`), 'Show all 20 lines');
  const folded = await reader.eval(`${block}.querySelector('.code-body').getBoundingClientRect().height`);
  const copied = await reader.eval(`(async () => {
    let copied = null;
    navigator.clipboard.writeText = async text => { copied = text; };
    ${block}.querySelector('.code-copy').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    return copied;
  })()`);
  assert.equal(copied, PYTHON, 'Copy copies the whole code even while folded');
  await reader.eval(`${block}.querySelector('.code-more').click()`);
  await reader.waitFor(`${block}.querySelector('.code-toggle').getAttribute('aria-expanded') === 'true'`, { label: 'Show all opens the block' });
  await reader.waitFor(`!${block}.getAnimations({ subtree: true }).length`, { label: 'the opening animation finished' });
  const open = await reader.eval(`${block}.querySelector('.code-body').getBoundingClientRect().height`);
  assert.ok(open > folded * 2, `the open block shows every line (${folded} -> ${open})`);
  assert.ok(
    await reader.eval(`${block}.querySelector('.code-head').getBoundingClientRect().top >= document.getElementById('messages').getBoundingClientRect().top - 1`),
    'opening the newest block keeps its header in view'
  );
  assert.ok(await reader.eval(`${block}.querySelector('.code-more').hidden`));
  await reader.eval(`${block}.querySelector('.code-toggle').click()`);
  assert.equal(await reader.eval(`${block}.querySelector('.code-toggle').getAttribute('aria-expanded')`), 'false', 'the header folds it again');

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
