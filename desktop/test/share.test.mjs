import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { launch, startBridge, DevToolsConnection, Page } from '../../web/test/browser.mjs';
import { startFakeServer } from '../../web/test/fake-server.mjs';
import { openClient, sleep } from '../../web/test/harness.mjs';

const electron = createRequire(import.meta.url)('electron');
const desktop = fileURLToPath(new URL('../', import.meta.url));

async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

// Use an isolated display (xvfb-run on Linux), or a desktop test runner. No capture API is mocked.
test('Electron desktop capture reaches an independent viewer, changes pixels, and stops cleanly', { timeout: 120_000 }, async t => {
  const server = await startFakeServer({ port: 0, quiet: true });
  t.after(() => server.close());
  const bridge = await startBridge();
  t.after(() => bridge.close());
  const browser = await launch({ fakeMedia: false });
  t.after(() => browser.close());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-desktop-share-'));
  const port = await unusedPort();
  const env = { ...process.env, PORT: String(port), PORTABLE_EXECUTABLE_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const ozone = process.env.MUTTER_TEST_OZONE || 'x11';
  const child = spawn(electron, ['.', '--no-sandbox', '--disable-gpu',
    ...(process.platform === 'linux' ? [`--ozone-platform=${ozone}`] : []),
    '--password-store=basic',
    '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0'], { cwd: desktop, env });
  const exited = once(child, 'exit');
  let diagnostics = '';
  let endpoint;
  const record = bytes => {
    diagnostics = (diagnostics + bytes).slice(-8000);
    endpoint ??= diagnostics.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    if (process.env.VERBOSE) process.stderr.write(bytes);
  };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.race([exited, sleep(2000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (let attempt = 0; attempt < 150 && !endpoint && child.exitCode === null; attempt++) {
    await sleep(100);
  }
  assert.ok(endpoint, diagnostics);
  console.log('Electron started on the isolated display');
  const devtools = new DevToolsConnection(endpoint);
  await devtools.ready;
  t.after(() => devtools.socket.close());
  async function findPage(suffix) {
    for (let attempt = 0; attempt < (ozone === 'wayland' ? 600 : 150); attempt++) {
      const { targetInfos } = await devtools.send('Target.getTargets');
      const target = targetInfos.find(info => info.type === 'page' && info.url === `http://localhost:${port}${suffix}`);
      if (target) {
        const { sessionId } = await devtools.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
        const page = new Page({ devtools, verbose: !!process.env.VERBOSE }, sessionId, target.targetId);
        await page.send('Runtime.enable');
        await page.send('Page.enable');
        return page;
      }
      await sleep(100);
    }
    throw new Error(`Missing Electron page ${suffix}\n${diagnostics}`);
  }
  const sharer = await findPage('/');
  console.log('Electron main window ready');
  await sharer.waitFor('!!globalThis.mutter', { timeout: 30_000, label: 'Electron app initialized' }).catch(error => {
    throw new Error(`${error.message}\n${diagnostics}\n${JSON.stringify(sharer.logs)}`);
  });
  await sharer.eval(`history.replaceState(null, '', '/?source=tone')`);
  await sharer.eval(`mutter.settings.stun = ''; mutter.settings.transmitMode = 'ptt'`);
  await sharer.type('#host', '127.0.0.1');
  await sharer.type('#port', String(server.port));
  await sharer.type('#username', 'ElectronSharer');
  await sharer.click('#connectBtn');
  await sharer.waitFor(`document.getElementById('certificateDialog').open`);
  assert.equal(await sharer.eval(`document.getElementById('certificateFingerprint').textContent.replaceAll(':', '')`), server.fingerprint);
  await sharer.click('#certificateTrustBtn');
  await sharer.waitFor(`mutter.client.state === 'connected'`);
  const viewer = await openClient({ server, bridge, browser }, 'IndependentViewer', {
    beforeConnect: page => page.eval(`mutter.settings.stun = ''; mutter.settings.shareAudio = false`),
  });
  await sharer.waitFor('mutter.client.users.size === 2');
  console.log('Both clients connected to the local Mumble test server');
  await sharer.send('Runtime.evaluate', { expression: `document.getElementById('shareBtn').click()`, userGesture: true });
  const picker = await findPage('/app/picker.html');
  console.log('Desktop capture picker opened');
  await picker.waitFor(`!!document.querySelector('.src[data-source^="screen:"]')`).catch(async error => {
    throw new Error(`${error.message}\n${diagnostics}\n${JSON.stringify(picker.errors())}\n${await picker.eval('document.body.innerText')}`);
  });
  await picker.click('.src[data-source^="screen:"]');
  // Return the CDP result before the selection closes the picker target.
  await picker.eval(`setTimeout(() => document.getElementById('share').click(), 50); true`);
  await sharer.waitFor('!!mutter.share.sharing');
  console.log('Native desktop capture started');
  await sharer.send('Runtime.evaluate', {
    expression: 'document.documentElement.requestFullscreen()', awaitPromise: true, userGesture: true,
  });
  await sharer.waitFor('!!document.fullscreenElement');
  await sharer.eval(`(() => {
    const pattern = document.createElement('div');
    pattern.id = 'capturePattern';
    Object.assign(pattern.style, { position: 'fixed', inset: '0', zIndex: '2147483647', background: 'rgb(220, 20, 20)' });
    document.body.append(pattern);
  })()`);
  await viewer.waitFor('mutter.share.available.size === 1');
  await viewer.click('.offer .watch');
  await viewer.waitFor(`mutter.share.watching?.state === 'connected'`, { timeout: 25_000 });
  console.log('Independent viewer connected over WebRTC');
  const hasColor = channel => `(() => {
    const video = document.querySelector('#stage video.remote');
    if (!video?.videoWidth || video.getVideoPlaybackQuality().totalVideoFrames < 3) return false;
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 20;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video, 0, 0, 32, 20);
    const data = ctx.getImageData(0, 0, 32, 20).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + ${channel}] > 170 && data[i + ${channel === 0 ? 2 : 0}] < 65) count++;
    }
    return count > 32 * 20 * 0.5;
  })()`;
  await viewer.waitFor(hasColor(0), { timeout: 15_000, label: 'real desktop red pixels decoded' });
  await sharer.eval(`document.getElementById('capturePattern').style.background = 'rgb(20, 20, 220)'`);
  await viewer.waitFor(hasColor(2), { timeout: 10_000, label: 'updated desktop blue pixels decoded' });
  await sharer.waitFor('mutter.share.viewerCount === 1');
  const settings = await sharer.eval('mutter.share.sharing.stream.getVideoTracks()[0].getSettings()');
  t.diagnostic(`Desktop capture decoded by a separate Chromium process: ${settings.width}×${settings.height}; red → blue pixels verified.`);
  await sharer.eval(`window.capturedTracks = mutter.share.sharing.stream.getTracks(); mutter.share.stop()`);
  await viewer.waitFor('!mutter.share.watching && mutter.share.available.size === 0');
  assert.equal(await sharer.eval(`capturedTracks.every(track => track.readyState === 'ended')`), true);
  assert.deepEqual(sharer.errors(), []);
  assert.deepEqual(viewer.errors(), []);
});
