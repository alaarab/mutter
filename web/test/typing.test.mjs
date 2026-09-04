// The typing indicator between browser tabs: starts and stops relayed through the fake server's
// PluginDataTransmission channel (with murmur's limits), the 3 s repeat rule, DM scoping, and a
// typer who vanishes without a stop. See docs/extensions.md.
//
//   node web/test/typing.test.mjs

import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeServer } from './fake-server.mjs';
import { launch, startBridge } from './browser.mjs';

const server = await startFakeServer({ port: 0, quiet: !process.env.VERBOSE });
const bridge = await startBridge();
const browser = await launch();

const failures = [];
const check = (cond, msg) => { console.log(`${cond ? ' ok ' : 'FAIL'} ${msg}`); if (!cond) failures.push(msg); };
const step = async (msg, fn) => { try { await fn(); check(true, msg); } catch (e) { check(false, `${msg} — ${e.message}`); } };
const plugin = { count: 0, max: 0, drops: 0 };
server.on('plugin', p => { if (p.dataId === 'mutter/typing') { plugin.count++; plugin.max = Math.max(plugin.max, p.bytes); } });
server.on('drop', () => plugin.drops++);

async function open(name) {
  const page = await browser.newPage(`${bridge.url}/?source=tone`);
  await page.type('#host', '127.0.0.1');
  await page.type('#port', String(server.port));
  await page.type('#username', name);
  await page.click('#connectBtn');
  await page.waitFor(`mutter.client.state === 'connected'`, { label: `${name} connected` });
  await page.eval(`mutter.settings.transmitMode = 'ptt'`);
  // app.js doesn't own one yet, so each tab gets its own indicator over the same client.
  await page.eval(`(async () => {
    const { TypingIndicator } = await import('/app/typing.js');
    window.t = new TypingIndicator(mutter.client);
    window.changes = 0;
    t.addEventListener('change', () => window.changes++);
    return true;
  })()`);
  return { page, session: await page.eval('mutter.client.me') };
}

let a, b, c;
try {
  a = await open('Alpha');
  b = await open('Bravo');
  await a.page.waitFor('mutter.client.users.size === 2');

  await step('Alpha typing in the channel shows up for Bravo within 2 s', async () => {
    await a.page.eval(`t.noteTyping({ channelId: 0 })`);
    await b.page.waitFor(`t.typing.size === 1 && t.typing.has(${a.session})`, { timeout: 2000, label: 'Bravo sees Alpha typing' });
    const who = await b.page.eval(`t.who(0)`);
    if (who.join(',') !== 'Alpha') throw new Error(`who(0) = ${JSON.stringify(who)}`);
    if (!(await b.page.eval('changes >= 1'))) throw new Error('no change event');
    if ((await b.page.eval(`t.who({ sessions: [${a.session}] }).length`)) !== 0) throw new Error('channel typing leaked into the DM scope');
  });

  await step('stopped() empties Bravo’s map within 2 s', async () => {
    await a.page.eval('t.stopped()');
    await b.page.waitFor('t.typing.size === 0', { timeout: 2000, label: 'Bravo forgets Alpha' });
    if ((await b.page.eval(`t.who(0).length`)) !== 0) throw new Error('who(0) still lists someone');
  });

  await step('a burst of input events sends one start, not one per keystroke', async () => {
    const before = plugin.count;
    await a.page.eval(`(() => { for (let i = 0; i < 20; i++) t.noteTyping({ channelId: 0 }); return true; })()`);
    await b.page.waitFor('t.typing.size === 1', { timeout: 2000 });
    if (plugin.count - before !== 1) throw new Error(`${plugin.count - before} messages for 20 input events`);
    await a.page.eval('t.stopped()');
    await b.page.waitFor('t.typing.size === 0', { timeout: 2000 });
  });

  c = await open('Charlie');
  await a.page.waitFor('mutter.client.users.size === 3');

  await step('a DM start reaches only its recipient', async () => {
    await a.page.eval(`t.noteTyping({ sessions: [${b.session}] })`);
    await b.page.waitFor(`t.typing.size === 1 && t.typing.get(${a.session}).scope.sessions[0] === mutter.client.me`, { timeout: 2000, label: 'Bravo sees the DM' });
    const who = await b.page.eval(`t.who({ sessions: [${a.session}] })`);
    if (who.join(',') !== 'Alpha') throw new Error(`who(dm) = ${JSON.stringify(who)}`);
    if ((await b.page.eval(`t.who(0).length`)) !== 0) throw new Error('a DM showed as channel typing');
    await sleep(1000);
    if ((await c.page.eval('t.typing.size')) !== 0) throw new Error('Charlie was told about a DM he is not in');
    await a.page.eval('t.stopped()');
    await b.page.waitFor('t.typing.size === 0', { timeout: 2000 });
  });

  await step('a start whose stop never arrives expires 6 s later', async () => {
    await a.page.eval(`t.noteTyping({ channelId: 0 })`);
    await b.page.waitFor(`t.typing.has(${a.session})`, { timeout: 2000 });
    await a.page.eval(`(() => { window.send = mutter.client.sendPlugin; mutter.client.sendPlugin = () => false; return true; })()`);
    await b.page.waitFor('t.typing.size === 0', { timeout: 9000, label: 'Bravo expires a stale typer' });
    await a.page.eval(`(() => { mutter.client.sendPlugin = window.send; t.stopped(); return true; })()`);
  });

  await step('a typer who disconnects without a stop is dropped from the roster', async () => {
    await c.page.eval(`t.noteTyping({ channelId: 0 })`);
    await b.page.waitFor(`t.typing.has(${c.session})`, { timeout: 2000 });
    await c.page.eval('mutter.client.disconnect()');
    await b.page.waitFor('t.typing.size === 0', { timeout: 3000, label: 'Bravo forgets the departed typer' });
  });

  check(plugin.count > 0 && plugin.max <= 1000, `server relayed ${plugin.count} mutter/typing messages (largest ${plugin.max} bytes)`);
  check(plugin.drops === 0, 'nothing was rate-limited or oversized');
  // app.js's showScreen still hides a #session element the redesigned index.html no longer has;
  // e2e and share hit the same one. Not ours — drop the filter once that's fixed.
  for (const [name, p] of [['Alpha', a], ['Bravo', b], ['Charlie', c]]) {
    const errs = (p?.page.errors() ?? []).filter(e => !/showScreen/.test(e));
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
