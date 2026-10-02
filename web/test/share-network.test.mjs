import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFakeServer } from './fake-server.mjs';
import { launch, startBridge } from './browser.mjs';
import { sleep } from './harness.mjs';

const EXPOSE_HOST_ADDRESSES = '--disable-features=WebRtcHideLocalIpsWithMdns';
const UNRESOLVABLE_MDNS_NETWORK = `
  const isMdnsCandidate = (line) => /\\s[0-9a-f-]+\\.local\\s/i.test(line);
  const withoutMdnsCandidates = (sdp) => sdp.split('\\r\\n').filter((line) => !(line.startsWith('a=candidate:') && isMdnsCandidate(line))).join('\\r\\n');
  const originalSetRemoteDescription = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (description) {
    const filtered = description?.sdp ? { type: description.type, sdp: withoutMdnsCandidates(description.sdp) } : description;
    return originalSetRemoteDescription.call(this, filtered);
  };
  const originalAddIceCandidate = RTCPeerConnection.prototype.addIceCandidate;
  RTCPeerConnection.prototype.addIceCandidate = function (candidate) {
    if (candidate?.candidate && isMdnsCandidate(candidate.candidate)) {
      return Promise.resolve();
    }
    return originalAddIceCandidate.call(this, candidate);
  };
`;
const CANVAS_SHARE = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext('2d');
  let frame = 0;
  setInterval(() => {
    context.fillStyle = 'hsl(' + (frame++ % 360) + ' 70% 50%)';
    context.fillRect(0, 0, 640, 360);
  }, 33);
  return mutter.share.start({ stream: canvas.captureStream(30) });
})()`;
const VIEWER_STATE = `mutter.share.watching?.state ?? 'none'`;

async function startComputer(server, { exposesHostAddresses }) {
  const bridge = await startBridge();
  const browser = await launch({ fakeMedia: false, args: exposesHostAddresses ? [EXPOSE_HOST_ADDRESSES] : [] });
  return {
    server,
    bridge,
    browser,
    async close() {
      await browser.close();
      await bridge.close();
    },
  };
}

async function connectComputer(computer, name) {
  const page = await computer.browser.newPage();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: UNRESOLVABLE_MDNS_NETWORK });
  await page.goto(`${computer.bridge.url}/`);
  await page.waitFor('!!globalThis.mutter', { label: 'app initialized' });
  await page.eval(`mutter.settings.stun = ''`);
  await page.type('#host', '127.0.0.1');
  await page.type('#port', String(computer.server.port));
  await page.type('#username', name);
  await page.click('#connectBtn');
  await page.waitFor(`mutter.client.state === 'connected' || document.getElementById('certificateDialog').open`, { label: `${name} connecting` });
  if (await page.eval(`document.getElementById('certificateDialog').open`)) {
    await page.click('#certificateTrustBtn');
  }
  await page.waitFor(`mutter.client.state === 'connected'`, { label: `${name} connected` });
  return page;
}

async function watchFromSecondComputer({ sharerExposes, viewerExposes }) {
  const server = await startFakeServer({ port: 0, quiet: !process.env.VERBOSE });
  const sharerComputer = await startComputer(server, { exposesHostAddresses: sharerExposes });
  const viewerComputer = await startComputer(server, { exposesHostAddresses: viewerExposes });
  try {
    const sharer = await connectComputer(sharerComputer, 'Sharer');
    const viewer = await connectComputer(viewerComputer, 'Viewer');
    await sharer.waitFor('mutter.client.users.size === 2');
    await sharer.eval(CANVAS_SHARE);
    await viewer.waitFor('mutter.share.available.size === 1', { label: 'share announced to the viewer' });
    await viewer.eval(`mutter.share.watch([...mutter.share.available.keys()][0])`);
    const deadline = Date.now() + 35_000;
    let state = await viewer.eval(VIEWER_STATE);
    while (Date.now() < deadline && state !== 'connected' && state !== 'failed') {
      await sleep(250);
      state = await viewer.eval(VIEWER_STATE);
    }
    const frameWidth = state === 'connected'
      ? await viewer.waitFor(`mutter.share.watching?.stats.w === 640`, { timeout: 10_000, label: 'frames arrive' }).then(() => 640)
      : 0;
    const failure = await viewer.eval(`mutter.share.watching?.failure ?? null`);
    if (state === 'failed') {
      await viewer.waitFor(`mutter.share.watching?.pc.connectionState === 'closed'`, { label: 'failed viewer released its peer' });
      await sharer.waitFor('mutter.share.sharing.peers.size === 0', { label: 'failed viewer released the sender peer' });
    }
    return { state, frameWidth, failure };
  } finally {
    await viewerComputer.close();
    await sharerComputer.close();
    await server.close();
  }
}

test('two computers that hide their addresses behind unresolvable mDNS names give up and say why', { timeout: 120_000 }, async () => {
  const result = await watchFromSecondComputer({ sharerExposes: false, viewerExposes: false });
  assert.deepEqual(result, { state: 'failed', frameWidth: 0, failure: 'hidden-addresses' });
});

test('a viewer that exposes its host addresses reaches a sharer whose mDNS name does not resolve', { timeout: 90_000 }, async () => {
  const result = await watchFromSecondComputer({ sharerExposes: false, viewerExposes: true });
  assert.deepEqual(result, { state: 'connected', frameWidth: 640, failure: null });
});

test('a sharer that exposes its host addresses reaches a viewer whose mDNS name does not resolve', { timeout: 90_000 }, async () => {
  const result = await watchFromSecondComputer({ sharerExposes: true, viewerExposes: false });
  assert.deepEqual(result, { state: 'connected', frameWidth: 640, failure: null });
});
