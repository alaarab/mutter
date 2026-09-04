// Two browser tabs against the fake server, through the real bridge: connect, roster, chat,
// joining channels, voice in both directions, push-to-talk, mute badges, direct messages,
// images, hostile HTML, leaving, and reconnecting after the server drops us.
//
//   node web/test/e2e.test.mjs                       # protobuf voice (server 1.5)
//   FAKE_VERSION=1.4.287 node web/test/e2e.test.mjs  # legacy voice
//   VERBOSE=1 ... to see page console output; SHOTS=dir to save screenshots.

import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeServer } from './fake-server.mjs';
import { launch, startBridge } from './browser.mjs';

const server = await startFakeServer({ port: 0, quiet: !process.env.VERBOSE });
const bridge = await startBridge();
const browser = await launch();
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

const failures = [];
const check = (cond, msg) => { console.log(`${cond ? ' ok ' : 'FAIL'} ${msg}`); if (!cond) failures.push(msg); };
const step = async (msg, fn) => { try { await fn(); check(true, msg); } catch (e) { check(false, `${msg} — ${e.message}`); } };
const seen = { voice: 0, terminators: 0, plugin: 0 };
server.on('voice', v => { seen.voice++; if (v.isTerminator) seen.terminators++; });
server.on('plugin', () => seen.plugin++);

const findUser = name => `[...mutter.client.users.values()].find(u => u.name === ${JSON.stringify(name)})`;

async function open(name) {
  const page = await browser.newPage(`${bridge.url}/?source=tone`);
  await page.type('#host', '127.0.0.1');
  await page.type('#port', String(server.port));
  await page.type('#username', name);
  if (shots && name === 'Alpha') await page.screenshot(`${shots}/00-connect.png`);
  await page.click('#connectBtn');
  await page.waitFor(`mutter.client.state === 'connected'`, { label: `${name} connected` });
  return page;
}

try {
  const a = await open('Alpha');
  const b = await open('Bravo');
  check(true, 'both tabs connected through the bridge');
  await a.waitFor('mutter.client.users.size === 2');
  await sleep(150);
  check(await a.eval(`[...document.querySelectorAll('.user .name')].map(e => e.textContent).sort().join(',')`) === 'Alpha,Bravo', 'both users in the tree');
  check(await a.eval(`document.querySelectorAll('.ch').length`) === 5, 'five channels rendered');
  check(await a.eval(`document.querySelector('.msg.system')?.textContent.includes('Welcome')`), 'welcome text shown as a system message');
  if (shots) await a.screenshot(`${shots}/01-session.png`);

  await step('channel chat delivered and own bubble shown', async () => {
    await a.type('#chatInput', 'hello from alpha');
    await a.click('#sendBtn');
    await b.waitFor(`[...document.querySelectorAll('.msg .text')].some(e => e.textContent.includes('hello from alpha'))`);
    if (await a.eval(`document.querySelectorAll('.msg.own').length`) !== 1) throw new Error('own bubble missing');
    if (await a.eval(`document.getElementById('chatInput').value`) !== '') throw new Error('input not cleared');
  });

  await step('join arrow moves Alpha to Lounge; dock and chat title follow', async () => {
    await a.eval(`(() => { const row = [...document.querySelectorAll('.ch')].find(r => r.querySelector('.name').textContent === 'Lounge'); row.querySelector('.join').click(); })()`);
    await b.waitFor(`${findUser('Alpha')}?.channelId === 1`);
    await a.waitFor(`mutter.client.myChannel?.channelId === 1 && document.getElementById('meChannel').textContent === 'Lounge'`);
    await a.waitFor(`document.getElementById('chatTitle').textContent === 'Lounge'`);
  });

  await step('voice flows Alpha → Bravo once both are in Lounge', async () => {
    await b.eval('mutter.client.joinChannel(1)');
    await a.waitFor('mutter.client.usersIn(1).length === 2');
    await b.eval(`mutter.settings.transmitMode = 'ptt'`);          // Bravo listens only
    await a.eval(`mutter.settings.transmitMode = 'continuous'`);
    await a.waitFor('mutter.audio.isTransmitting', { label: 'Alpha transmitting' });
    await b.waitFor('mutter.audio.stats.packetsIn > 25', { label: 'Bravo receiving packets', timeout: 8000 });
    await b.waitFor('mutter.audio.stats.samplesOut > 960 * 20', { label: 'Bravo decoding audio' });
    await b.waitFor(`${findUser('Alpha')}.talking === true && !!document.querySelector('.user.talking')`, { label: 'talking ring on Alpha' });
    await b.waitFor(`!mutter.audio.isTransmitting && !document.getElementById('meterFill').classList.contains('open')`, { label: 'Bravo (push-to-talk, idle) is not transmitting and its meter is not green', timeout: 3000 });
    if (shots) await b.screenshot(`${shots}/02-talking.png`);
  });

  await step('gate closes with a terminator when Alpha stops', async () => {
    await a.eval(`mutter.settings.transmitMode = 'ptt'`);
    await a.waitFor('!mutter.audio.isTransmitting', { timeout: 3000 });
    await b.waitFor(`${findUser('Alpha')}.talking === false`, { timeout: 3000 });
    if (!seen.terminators) throw new Error('server never saw a terminator packet');
  });

  await step('holding Space transmits, releasing stops', async () => {
    await a.eval('document.activeElement?.blur()');
    await a.key('Space', ' ', { up: false });
    await a.waitFor('mutter.audio.isTransmitting', { timeout: 3000 });
    await a.key('Space', ' ', { down: false });
    await a.waitFor('!mutter.audio.isTransmitting', { timeout: 3000 });
  });

  await step('mute shows on the other side', async () => {
    await a.click('#muteBtn');
    await b.waitFor(`${findUser('Alpha')}.selfMute === true`);
    await b.waitFor(`!!document.querySelector('.user .badge[title="Muted"]')`);
    await a.waitFor(`document.getElementById('muteBtn').classList.contains('active')`);
  });

  await step('deafen implies mute; undeafen clears both', async () => {
    await a.click('#deafBtn');
    await b.waitFor(`${findUser('Alpha')}.selfDeaf === true`);
    await a.click('#deafBtn');
    await b.waitFor(`${findUser('Alpha')}.selfDeaf === false`);
    await a.click('#muteBtn');
    await b.waitFor(`${findUser('Alpha')}.selfMute === false`);
  });

  await step('direct message arrives tagged "direct"', async () => {
    await b.eval(`mutter.client.sendText('psst', { sessions: [${findUser('Alpha')}.session] })`);
    await a.waitFor(`[...document.querySelectorAll('.msg')].some(e => e.textContent.includes('psst') && e.querySelector('.tag')?.textContent === 'direct')`);
  });

  await step('image is shrunk to the server limit and rendered inline', async () => {
    await a.eval(`(async () => {
      const c = new OffscreenCanvas(1600, 1200); const x = c.getContext('2d');
      for (let i = 0; i < 400; i++) { x.fillStyle = \`hsl(\${i * 7 % 360} 80% 50%)\`; x.fillRect(Math.random() * 1600, Math.random() * 1200, 90, 90); }
      const blob = await c.convertToBlob({ type: 'image/png' });
      const { imageToHtml } = await import('/app/chat.js');
      const html = await imageToHtml(new File([blob], 'x.png', { type: 'image/png' }), mutter.client.serverInfo.imageMessageLength);
      if (html.length > mutter.client.serverInfo.imageMessageLength) throw new Error('too big: ' + html.length);
      mutter.client.sendText(html, { channelId: 1 });
    })()`);
    await b.waitFor(`!!document.querySelector('.msg .text img')`);
    if (shots) await b.screenshot(`${shots}/03-image.png`);
  });

  await step('desktop Mumble’s percent-encoded data URI image decodes', async () => {
    // Log::imageToImg splits the base64 into 72-char lines, percent-encodes each (+ / =), and
    // joins them with newlines; the subtype comes out uppercase.
    await b.eval(`(async () => {
      const c = new OffscreenCanvas(48, 32); const x = c.getContext('2d'); x.fillStyle = '#0f0'; x.fillRect(0, 0, 48, 32);
      const blob = await c.convertToBlob({ type: 'image/png' });
      const b64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
      const enc = b64.match(/.{1,72}/g).map(encodeURIComponent).join('\\n');
      mutter.client.sendText('<img src="data:image/PNG;base64,' + enc + '" />', { channelId: 1 });
    })()`);
    await a.waitFor(`(() => { const img = [...document.querySelectorAll('.msg .text img')].find(i => i.src.startsWith('data:image/PNG')); return img && img.complete && img.naturalWidth === 48; })()`, { timeout: 5000 });
  });

  await step('hostile HTML is neutralised', async () => {
    await b.eval(`mutter.client.sendText('<b>bold</b><script>window.pwned=1</script><img src="x" onerror="window.pwned=2"><a href="javascript:alert(1)">j</a> see https://example.com/x', { channelId: 1 })`);
    await a.waitFor(`[...document.querySelectorAll('.msg .text b')].some(e => e.textContent === 'bold')`);
    const ok = await a.eval(`!window.pwned && !document.querySelector('.msg script') && !document.querySelector('.msg a[href^="javascript"]') && !document.querySelector('.msg img[onerror]') && !!document.querySelector('.msg a[href="https://example.com/x"]')`);
    if (!ok) throw new Error('something dangerous survived, or linkify failed');
  });

  await step('permission denied surfaces as a toast', async () => {
    await a.eval(`mutter.client.joinChannel(999)`);
    await a.waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('No such channel'))`, { timeout: 3000 });
  });

  await step('leave returns to the connect screen and the other side sees it', async () => {
    await a.click('#leaveBtn');
    await b.waitFor('mutter.client.users.size === 1');
    await a.waitFor(`!document.getElementById('connect').hidden && document.getElementById('dock').hidden`);
    if (await a.eval('mutter.audio.running')) throw new Error('audio still running after leave');
  });

  await step('server drop → reconnecting overlay → back with a fresh session', async () => {
    const before = await b.eval('mutter.client.me');
    for (const u of server.users.values()) if (u.name === 'Bravo') u.socket.destroy();
    await b.waitFor(`mutter.client.state === 'reconnecting' && !document.getElementById('overlay').hidden`, { timeout: 3000 });
    await b.waitFor(`mutter.client.state === 'connected' && document.getElementById('overlay').hidden`, { timeout: 10_000 });
    const after = await b.eval('mutter.client.me');
    if (after === before) throw new Error('session id did not change');
    if (await b.eval('mutter.client.users.size') !== 1) throw new Error('ghost user after reconnect');
  });

  check(seen.voice > 50, `server relayed voice (${seen.voice} packets)`);
  for (const [name, p] of [['Alpha', a], ['Bravo', b]]) {
    const errs = p.errors();
    check(errs.length === 0, `${name}: no page exceptions${errs.length ? `\n      ${errs.join('\n      ')}` : ''}`);
  }
} catch (e) {
  check(false, `aborted: ${e.stack}`);
} finally {
  await browser.close();
  bridge.close();
  await server.close();
}

if (failures.length) { console.error(`\n${failures.length} failure(s)`); process.exit(1); }
console.log('\nPASS');
