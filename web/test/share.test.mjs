// Screen share between two tabs: signaling through the fake server's PluginDataTransmission
// relay (with murmur's limits), WebRTC video peer to peer, the stage UI, stop/leave, and
// nothing rate-limited or oversized. Headless Chromium has no screen to capture, so the sharer
// feeds a canvas stream through the same start() path the picker uses.
//
//   node web/test/share.test.mjs

import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeServer } from './fake-server.mjs';
import { launch, startBridge } from './browser.mjs';

const server = await startFakeServer({ port: 0, quiet: !process.env.VERBOSE });
const bridge = await startBridge();
// Same-machine WebRTC: host candidates must not be hidden behind mDNS names.
const browser = await launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const shots = process.env.SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

const failures = [];
const check = (cond, msg) => { console.log(`${cond ? ' ok ' : 'FAIL'} ${msg}`); if (!cond) failures.push(msg); };
const step = async (msg, fn) => { try { await fn(); check(true, msg); } catch (e) { check(false, `${msg} — ${e.message}`); } };
const plugin = { count: 0, bytes: 0, max: 0, drops: 0 };
server.on('plugin', p => { plugin.count++; plugin.bytes += p.bytes; plugin.max = Math.max(plugin.max, p.bytes); });
server.on('drop', () => plugin.drops++);

async function open(name) {
  const page = await browser.newPage(`${bridge.url}/?source=tone`);
  await page.type('#host', '127.0.0.1');
  await page.type('#port', String(server.port));
  await page.type('#username', name);
  await page.click('#connectBtn');
  await page.waitFor(`mutter.client.state === 'connected'`, { label: `${name} connected` });
  await page.eval(`mutter.settings.transmitMode = 'ptt'`);
  return page;
}

try {
  const a = await open('Alpha');
  const b = await open('Bravo');
  await a.waitFor('mutter.client.users.size === 2');

  await step('Alpha starts sharing a 640×360 canvas stream with an audio track', async () => {
    await a.eval(`(() => {
      const c = document.createElement('canvas'); c.width = 640; c.height = 360;
      const x = c.getContext('2d'); let n = 0;
      setInterval(() => { x.fillStyle = \`hsl(\${n++ % 360} 70% 50%)\`; x.fillRect(0, 0, 640, 360); x.fillStyle = '#fff'; x.font = '48px sans-serif'; x.fillText('frame ' + n, 40, 200); }, 33);
      const stream = c.captureStream(30);
      const ac = new AudioContext(); const osc = new OscillatorNode(ac); const dest = new MediaStreamAudioDestinationNode(ac); osc.connect(dest); osc.start();
      stream.addTrack(dest.stream.getAudioTracks()[0]);
      return mutter.share.start({ stream, contentHint: 'motion' });
    })()`);
    await a.waitFor('!!mutter.share.sharing && mutter.share.sharing.audio === true');
    await a.waitFor(`document.getElementById('shareBtn').classList.contains('active') && !document.getElementById('tabScreen').hidden && document.body.dataset.tab === 'screen'`);
  });

  await step('Bravo is offered the share (announce arrived, card and badge shown)', async () => {
    await b.waitFor('mutter.share.available.size === 1', { timeout: 5000 });
    await b.waitFor(`!!document.querySelector('.offer .watch') && !!document.querySelector('.user .live-badge') && !document.getElementById('tabScreen').hidden`);
    await b.waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('started sharing'))`, { timeout: 3000 });
  });

  await step('Watch → WebRTC connects and frames arrive with stats', async () => {
    // A canvas source only produces frames while its tab is visible (a real screen capture
    // doesn't care), so keep the sharer in front while we measure.
    await a.send('Page.bringToFront');
    await b.eval('mutter.settings.shareAudio = false');          // decline the audio m-line, as the iOS viewer always does
    await b.click('.offer .watch');
    await b.waitFor(`mutter.share.watching?.state === 'connected'`, { timeout: 15_000, label: 'peer connection connected' });
    // A declined m-section is either port 0 or a=inactive (Chrome answers a stopped transceiver
    // with the latter). The sharer must keep video going either way.
    const audio = await a.eval(`(() => { const sdp = [...mutter.share.sharing.peers.values()][0].remoteDescription.sdp; const sec = sdp.split(/(?=m=)/).find(s => s.startsWith('m=audio')) ?? ''; return { port: Number(sec.split(' ')[1]), inactive: /a=inactive/.test(sec), video: /m=video/.test(sdp) }; })()`);
    if (!audio.video || !(audio.port === 0 || audio.inactive)) throw new Error(`viewer did not decline audio: ${JSON.stringify(audio)}`);
    await b.waitFor(`mutter.share.watching?.stats.w === 640 && mutter.share.watching.stats.h === 360`, { timeout: 15_000, label: 'video stats report 640×360' });
    await b.waitFor(`(() => { const v = document.querySelector('#stage video'); return v && v.videoWidth === 640 && v.getVideoPlaybackQuality().totalVideoFrames > 2; })()`, { timeout: 8000, label: 'video element decoding frames' });
    await b.waitFor(`document.getElementById('shareStats')?.textContent.includes('640×360')`);
    if (await b.eval(`document.querySelector('.stage-bar .title .sub')?.textContent`) !== 'Screen') throw new Error('opaque track label leaked into the title');
    await a.waitFor(`mutter.share.viewerCount === 1`, { timeout: 5000 });
    if (shots) { await b.send('Page.bringToFront'); await b.screenshot(`${shots}/04-watching.png`); await a.send('Page.bringToFront'); await a.screenshot(`${shots}/05-sharing.png`); }
  });

  await step('sharer can switch content hint while live', async () => {
    await a.eval(`mutter.share.setContentHint('detail')`);
    await sleep(300);
    if (await b.eval(`mutter.share.watching?.state`) !== 'connected') throw new Error('connection dropped');
  });

  await step('Stop watching closes the sharer’s peer', async () => {
    await b.eval(`document.querySelector('.stage-bar .icon[title="Stop watching"]').click()`);
    await b.waitFor('!mutter.share.watching');
    await a.waitFor('mutter.share.sharing.peers.size === 0', { timeout: 5000 });
    if (!(await b.eval(`!!document.querySelector('.offer .watch')`))) throw new Error('offer card should return');
  });

  await step('a newcomer to the channel is announced to immediately', async () => {
    const c = await open('Charlie');
    await c.waitFor('mutter.share.available.size === 1', { timeout: 4000 });
    await c.eval('mutter.client.disconnect()');
    await a.waitFor('mutter.client.users.size === 2');
  });

  await step('Stop sharing clears the offer everywhere', async () => {
    await a.click('#shareBtn');
    await a.waitFor('!mutter.share.sharing');
    await b.waitFor('mutter.share.available.size === 0 && document.getElementById("tabScreen").hidden && document.body.dataset.tab !== "screen"', { timeout: 4000 });
  });

  check(plugin.count > 0 && plugin.max <= 1000, `server relayed ${plugin.count} plugin messages (${plugin.bytes} bytes, largest ${plugin.max})`);
  check(plugin.drops === 0, 'nothing was rate-limited or oversized');
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
