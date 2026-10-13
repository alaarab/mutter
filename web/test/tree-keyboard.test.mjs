import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEnvironment, openClient } from './harness.mjs';

const focusedRowText = `document.activeElement.closest('[role="treeitem"]')?.querySelector('.name')?.textContent.replace('you', '')`;

async function press(page, key) {
  const virtualKeyCodes = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 };
  const event = { key, code: key, windowsVirtualKeyCode: virtualKeyCodes[key] };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
}

async function pressUntilFocused(page, key, name) {
  for (let step = 0; step < 10; step++) {
    if ((await page.eval(focusedRowText)) === name) {
      return;
    }
    await press(page, key);
  }
  assert.fail(`never reached ${name}`);
}

test('the channel tree is operable by keyboard and keeps focus across roster updates', { timeout: 30_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await openClient(environment, 'Morgan');
  const peer = await openClient(environment, 'Edward');
  await page.send('Page.bringToFront');
  await page.waitFor(`document.querySelectorAll('#tree .user').length === 2`);

  const tabbable = await page.eval(`[...document.querySelectorAll('#tree [role="treeitem"]')].filter((row) => row.tabIndex === 0).length`);
  assert.equal(tabbable, 1, 'exactly one tree row is in the tab order');

  await page.eval(`document.querySelector('#tree [role="treeitem"][tabindex="0"]').focus()`);
  await pressUntilFocused(page, 'ArrowDown', 'Games');
  assert.equal(await page.eval(`document.activeElement.getAttribute('aria-expanded')`), 'true');

  await press(page, 'ArrowLeft');
  await page.waitFor(`document.activeElement.getAttribute('aria-expanded') === 'false'`, { label: 'Games collapsed with focus kept' });
  assert.equal(await page.eval(focusedRowText), 'Games');
  assert.equal(await page.eval(`[...document.querySelectorAll('#tree .ch .name')].some((name) => name.textContent === 'Rocket League')`), false);

  await press(page, 'ArrowRight');
  await page.waitFor(`document.activeElement.getAttribute('aria-expanded') === 'true'`, { label: 'Games expanded with focus kept' });
  await press(page, 'ArrowRight');
  assert.equal(await page.eval(focusedRowText), 'Rocket League');
  await press(page, 'ArrowLeft');
  assert.equal(await page.eval(focusedRowText), 'Games');

  await pressUntilFocused(page, 'ArrowUp', 'Edward');
  await peer.eval(`mutter.client.joinChannel(1)`);
  await page.waitFor(`document.querySelector('#tree .user:not(.me)')?.getAttribute('aria-level') === '3' && document.querySelector('#tree .user:not(.me)').previousElementSibling.textContent.includes('Lounge')`, { label: 'Edward moved to Lounge' });
  assert.equal(await page.eval(focusedRowText), 'Edward', 'focus follows the moved user row');

  await press(page, 'Enter');
  await page.waitFor(`!document.querySelector('#popover').hidden && document.querySelector('#popover').contains(document.activeElement)`, { label: 'profile opened with focus inside' });
  await press(page, 'Escape');
  await page.waitFor(`document.querySelector('#popover').hidden`);
  assert.equal(await page.eval(focusedRowText), 'Edward', 'Escape returns focus to the row');

  const unnamedButtons = await page.eval(`[...document.querySelectorAll('[data-tip]')].filter((element) => !element.getAttribute('aria-label') && !element.textContent.trim()).map((element) => element.id || element.className)`);
  assert.deepEqual(unnamedButtons, [], 'every icon-only tooltip button has an accessible name');
  assert.deepEqual(page.errors(), []);
});
