import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { THEMES } from '../app/theme-data.js';
import { startEnvironment, openClient, sleep } from './harness.mjs';

const rgb = (hex) => `rgb(${hex.slice(1).match(/../g).map((part) => parseInt(part, 16)).join(', ')})`;

test('every theme renders in both appearances without resetting the session or open settings', { timeout: 90_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await openClient(environment, 'Morgan');
  const peer = await openClient(environment, 'Jamie');
  await peer.type('#chatInput', 'The new colors look great. Ready for a quick call?');
  await peer.click('#sendBtn');
  await page.send('Page.bringToFront');
  await page.type('#chatInput', 'Sounds good — see you in Lounge.');
  await page.click('#sendBtn');
  await page.click('#railSettings');
  await page.eval(`document.querySelector('#appearance').scrollIntoView({block: 'start'}); window.themeSession = mutter.client.me; window.themeInput = document.querySelector('#chatInput');`);

  for (const appearance of ['dark', 'light']) {
    await page.click(`#appearance [data-value="${appearance}"]`);
    for (const [name, theme] of Object.entries(THEMES)) {
      await page.click(`#themes [data-theme="${name}"]`);
      await sleep(300);
      const state = await page.eval(`(() => {
        const root = document.documentElement;
        const colors = getComputedStyle(root);
        return {
          theme: root.dataset.theme, appearance: root.dataset.appearance,
          accent: colors.getPropertyValue('--accent').trim(),
          surface: colors.getPropertyValue('--surface').trim(),
          selected: document.querySelector('#themes [aria-pressed="true"]').dataset.theme,
          settingsOpen: !document.querySelector('#settings').hidden,
          sameSession: mutter.client.me === window.themeSession && mutter.client.state === 'connected',
          sameInput: document.querySelector('#chatInput') === window.themeInput,
          overflow: document.querySelector('#settings').scrollWidth > document.querySelector('#settings').clientWidth,
          persisted: JSON.parse(localStorage.getItem('mutter.settings')),
        };
      })()`);
      assert.equal(state.theme, name);
      assert.equal(state.appearance, appearance);
      assert.equal(state.accent, rgb(theme[appearance].accent));
      assert.equal(state.surface, rgb(theme[appearance].surface));
      assert.equal(state.selected, name);
      assert.ok(state.settingsOpen && state.sameSession && state.sameInput);
      assert.equal(state.overflow, false, `${name}/${appearance}: settings overflow`);
      assert.equal(state.persisted.theme, name);
      assert.equal(state.persisted.appearance, appearance);
      if (environment.shots) await page.screenshot(path.join(environment.shots, `${name}-${appearance}.png`));
    }
  }


  await page.click('#settingsClose');
  await page.click('#railSettings');
  await sleep(300);
  assert.equal(await page.eval(`document.querySelector('#settings').hidden`), false);
  for (const width of [390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await page.eval(`document.querySelector('#settings').scrollWidth > document.querySelector('#settings').clientWidth`), false);
    if (environment.shots) await page.screenshot(path.join(environment.shots, `phone-${width}.png`));
  }

  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.click('#settingsClose');
  assert.equal(await page.eval(`document.querySelector('#settings').hidden`), true);
  await page.click('#railSettings');
  await page.click('#appearance [data-value="system"]');
  for (const appearance of ['light', 'dark']) {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: appearance }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.waitFor(`document.documentElement.dataset.appearance === '${appearance}'`);
    assert.equal(await page.eval(`document.documentElement.getAnimations().length`), 0);
  }

  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.click('#themes [data-theme="midnight"]');
  await page.click('#settingsClose');
  if (environment.shots) await page.screenshot(path.join(environment.shots, 'session-midnight.png'));
  await page.click('#voiceBtn');
  if (environment.shots) await page.screenshot(path.join(environment.shots, 'voice-midnight.png'));
  assert.deepEqual(page.errors(), []);


  const picker = await environment.browser.newPage();
  await picker.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 532, deviceScaleFactor: 1, mobile: false });
  await picker.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.picker = {
    choose: id => window.chosenSource = id,
    onSetup: callback => callback({ theme: 'paper', appearance: 'light', sources: [
      {id:'screen:1',kind:'screen',name:'Studio display',thumb:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="%23DAD2C4"/></svg>'},
      {id:'window:1',kind:'window',name:'Mutter',thumb:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="%23252530"/></svg>'}
    ]})
  };` });
  await picker.goto(`${environment.bridge.url}/app/picker.html`);
  await picker.waitFor(`document.querySelectorAll('.src').length === 1`);
  assert.equal(await picker.eval(`document.documentElement.dataset.theme`), 'paper');
  assert.equal(await picker.eval(`document.body.scrollHeight > innerHeight`), false, 'picker actions fit below the native title bar');
  await picker.click('.src');
  await picker.click('[data-kind="window"]');
  assert.equal(await picker.eval(`document.querySelector('#share').disabled`), true);
  await picker.click('.src');
  await picker.click('#share');
  assert.equal(await picker.eval('window.chosenSource'), 'window:1');
  if (environment.shots) { await sleep(300); await picker.screenshot(path.join(environment.shots, 'desktop-picker-paper.png')); }
  assert.deepEqual(picker.errors(), []);
});

test('legacy appearances and unknown themes restore predictably', { timeout: 30_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await environment.browser.newPage(environment.bridge.url);
  for (const [theme, expectedTheme, expectedAppearance] of [['paper', 'paper', 'light'], ['midnight', 'midnight', 'dark'], ['removed-theme', 'carbon', 'dark']]) {
    await page.eval(`localStorage.setItem('mutter.settings', JSON.stringify({theme: '${theme}'}))`);
    await page.goto(environment.bridge.url);
    assert.equal(await page.eval('document.documentElement.dataset.theme'), expectedTheme);
    assert.equal(await page.eval('document.documentElement.dataset.appearance'), expectedAppearance);
  }
});
