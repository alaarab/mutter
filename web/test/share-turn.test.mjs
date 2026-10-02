import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { launch, startBridge } from './browser.mjs';
import { startFakeServer } from './fake-server.mjs';
import { openClient, sleep } from './harness.mjs';

const turnserver = process.env.TURN_SERVER || process.env.PATH.split(path.delimiter)
  .map(directory => path.join(directory, 'turnserver')).find(file => fs.existsSync(file));

async function startRelay(t) {
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-turn-'));
  const credential = crypto.randomBytes(16).toString('hex');
  const relay = spawn(turnserver, ['-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1',
    `--listening-port=${port}`, '--no-tls', '--no-dtls', '--no-cli', '--fingerprint', '--lt-cred-mech',
    '--realm=mutter-test', `--user=viewer:${credential}`, '--allow-loopback-peers', '--no-multicast-peers',
    '--relay-threads=1', '--log-file=stdout', '--simple-log', `--pidfile=${directory}/turn.pid`]);
  let diagnostics = '';
  relay.stdout.on('data', bytes => diagnostics = (diagnostics + bytes).slice(-8000));
  relay.stderr.on('data', bytes => diagnostics = (diagnostics + bytes).slice(-8000));
  const exited = once(relay, 'exit');
  t.after(async () => {
    relay.kill();
    await exited;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 100 && relay.exitCode === null; attempt++) {
    ready = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) break;
    await sleep(50);
  }
  assert.ok(ready, `TURN server did not start: ${diagnostics}`);

  // Delay each client's actual TURN exchange past the 2.5-second SDP deadline.
  // This exercises late allocations; no candidate or media API is mocked.
  const proxy = dgram.createSocket('udp4');
  const clients = new Map();
  proxy.on('message', (packet, remote) => {
    const key = `${remote.address}:${remote.port}`;
    let client = clients.get(key);
    if (!client) {
      const socket = dgram.createSocket('udp4');
      socket.bind(0, '127.0.0.1');
      socket.on('message', reply => proxy.send(reply, remote.port, remote.address));
      client = { socket, pending: [], ready: false };
      clients.set(key, client);
      client.timer = setTimeout(() => {
        client.ready = true;
        for (const bytes of client.pending) socket.send(bytes, port, '127.0.0.1');
        client.pending = [];
      }, 4000);
    }
    if (client.ready) client.socket.send(packet, port, '127.0.0.1');
    else client.pending.push(packet);
  });
  proxy.bind(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => {
    for (const client of clients.values()) { clearTimeout(client.timer); client.socket.close(); }
    proxy.close();
  });
  return { url: `turn:127.0.0.1:${proxy.address().port}?transport=udp`, username: 'viewer', credential };
}

test('independent clients receive video through TURN when relay candidates arrive after SDP', {
  skip: !turnserver && 'install coturn or set TURN_SERVER', timeout: 90_000,
}, async t => {
  const turn = await startRelay(t);
  const server = await startFakeServer({ port: 0, quiet: true });
  t.after(() => server.close());
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const pages = [];
  for (const name of ['RelaySharer', 'RelayViewer']) {
    const browser = await launch({ fakeMedia: false });
    t.after(() => browser.close());
    // Force relay selection so a successful host connection cannot mask a bug.
    const originalNewPage = browser.newPage.bind(browser);
    browser.newPage = async url => {
      const page = await originalNewPage();
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
        const Peer = RTCPeerConnection;
        globalThis.RTCPeerConnection = class extends Peer {
          constructor(config) { super({ ...config, iceTransportPolicy: 'relay' }); }
        };
      ` });
      await page.goto(url);
      return page;
    };
    pages.push(await openClient({ server, bridge, browser }, name, {
      beforeConnect: page => page.eval(`mutter.settings.stun = ''; mutter.settings.turn = ${JSON.stringify(turn)}`),
    }));
  }
  const [sharer, viewer] = pages;
  await sharer.waitFor('mutter.client.users.size === 2');
  await sharer.eval(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d'); let frame = 0;
    setInterval(() => { context.fillStyle = 'hsl(' + frame++ + ' 80% 50%)'; context.fillRect(0, 0, 640, 360); }, 33);
    return mutter.share.start({ stream: canvas.captureStream(30) });
  })()`);
  await viewer.waitFor('mutter.share.available.size === 1');
  await viewer.click('.offer .watch');
  await viewer.waitFor('!!mutter.share.watching?.pc.remoteDescription', { timeout: 15_000 });
  assert.equal(await viewer.eval('mutter.share.watching.pc.remoteDescription.sdp.includes("a=candidate:")'), false,
    'offer must precede the delayed relay allocation');
  await sharer.waitFor('!![...mutter.share.sharing.peers.values()][0]?.remoteDescription', { timeout: 15_000 });
  assert.equal(await sharer.eval('[...mutter.share.sharing.peers.values()][0].remoteDescription.sdp.includes("a=candidate:")'), false,
    'answer must precede the delayed relay allocation');
  await viewer.waitFor(`(() => {
    const video = document.querySelector('#stage video.remote');
    return video?.videoWidth === 640 && video.getVideoPlaybackQuality().totalVideoFrames > 5;
  })()`, { timeout: 30_000, label: 'relayed video frames' });
  const pathUsed = await viewer.eval(`(async () => {
    const stats = await mutter.share.watching.pc.getStats();
    const transport = [...stats.values()].find(s => s.type === 'transport' && s.selectedCandidatePairId);
    const pair = stats.get(transport.selectedCandidatePairId);
    return [stats.get(pair.localCandidateId).candidateType, stats.get(pair.remoteCandidateId).candidateType];
  })()`);
  assert.deepEqual(pathUsed, ['relay', 'relay']);
  assert.deepEqual(sharer.errors(), []);
  assert.deepEqual(viewer.errors(), []);
  await sharer.eval('mutter.share.stop()');
  await viewer.waitFor('!mutter.share.watching');
});
