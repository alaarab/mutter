import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEnvironment, openClient, findUser, sleep } from './harness.mjs';

const INSTRUMENT = `
  window.capturedTracks = [];
  window.audioContexts = [];
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await originalGetUserMedia(constraints);
    const delay = window.getUserMediaDelayMs ?? 0;
    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    window.capturedTracks.push(...stream.getTracks());
    return stream;
  };
  const OriginalAudioContext = window.AudioContext;
  window.AudioContext = class extends OriginalAudioContext {
    constructor(...options) {
      super(...options);
      window.audioContexts.push(this);
    }
  };
`;

const LIVE_TRACKS = `window.capturedTracks.filter((track) => track.readyState === 'live').length`;
const OPEN_CONTEXTS = `window.audioContexts.filter((context) => context.state !== 'closed').length`;

async function openInstrumented(environment, query = '') {
  const page = await environment.browser.newPage();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  await page.goto(`${environment.bridge.url}/${query}`);
  return page;
}

async function fillConnectForm(page, environment, name) {
  await page.type('#host', '127.0.0.1');
  await page.type('#port', String(environment.server.port));
  await page.type('#username', name);
}

async function trustIfAsked(page, environment) {
  await page.waitFor(`mutter.client.state !== 'connecting' || document.getElementById('certificateDialog').open`, { timeout: 10_000 });
  if (await page.eval(`document.getElementById('certificateDialog').open`)) {
    const fingerprint = await page.eval(`document.getElementById('certificateFingerprint').textContent.replaceAll(':', '')`);
    assert.equal(fingerprint, environment.server.fingerprint);
    await page.click('#certificateTrustBtn');
  }
}

test('a connect the server rejects leaves no microphone or audio running', { timeout: 60_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  await openClient(environment, 'Taken');
  const page = await openInstrumented(environment);
  await fillConnectForm(page, environment, 'Taken');
  await page.click('#connectBtn');
  await page.waitFor(`!document.getElementById('error').hidden && mutter.client.state === 'disconnected'`, { label: 'rejected' });
  assert.match(await page.eval(`document.getElementById('error').textContent`), /already in use/);
  await sleep(1000);
  assert.ok((await page.eval('window.audioContexts.length')) >= 1, 'audio was started for the attempt');
  assert.equal(await page.eval('mutter.audio.running'), false);
  assert.equal(await page.eval(LIVE_TRACKS), 0);
  assert.equal(await page.eval(OPEN_CONTEXTS), 0);
  assert.deepEqual(page.errors(), []);
});

test('leaving while the microphone is still being granted releases it when it arrives', { timeout: 60_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await openInstrumented(environment);
  await page.eval('window.getUserMediaDelayMs = 1500');
  await fillConnectForm(page, environment, 'Slow');
  await page.click('#connectBtn');
  await trustIfAsked(page, environment);
  await page.waitFor(`mutter.client.state === 'connected'`);
  await page.click('#leaveBtn');
  await page.waitFor(`mutter.client.state === 'disconnected'`);
  await page.waitFor('window.capturedTracks.length > 0', { timeout: 10_000, label: 'the delayed microphone arrived' });
  await sleep(300);
  assert.equal(await page.eval(LIVE_TRACKS), 0);
  assert.equal(await page.eval(OPEN_CONTEXTS), 0);
  assert.equal(await page.eval('mutter.audio.running'), false);
  assert.deepEqual(page.errors(), []);
});

test('clicking a saved server twice leaves exactly one audio context running', { timeout: 60_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const first = await openClient(environment, 'Twice');
  await first.click('#leaveBtn');
  await first.waitFor(`mutter.client.state === 'disconnected'`);
  await first.close();
  const page = await openInstrumented(environment, '?source=tone');
  await page.waitFor(`!!document.querySelector('.saved-main')`);
  await page.eval(`(() => {
    const saved = document.querySelector('.saved-main');
    saved.click();
    saved.click();
  })()`);
  await page.waitFor(`mutter.client.state === 'connected' && mutter.audio.running`);
  await sleep(500);
  assert.equal(await page.eval(OPEN_CONTEXTS), 1);
  assert.equal(environment.server.users.size, 1);
  await page.click('#leaveBtn');
  await page.waitFor(`mutter.client.state === 'disconnected'`);
  await page.waitFor(`${OPEN_CONTEXTS} === 0`, { label: 'every audio context closed' });
  assert.deepEqual(page.errors(), []);
});

test('a server that never finishes signing in times out and frees the Connect button', { timeout: 60_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  environment.server.holdSync = true;
  const page = await openInstrumented(environment, '?source=tone');
  await page.eval('mutter.client.handshakeTimeoutMs = 1500');
  await fillConnectForm(page, environment, 'Waiting');
  await page.click('#connectBtn');
  await trustIfAsked(page, environment);
  await page.waitFor(`mutter.client.state === 'authenticating'`);
  await page.waitFor(`mutter.client.state === 'disconnected'`, { timeout: 10_000, label: 'handshake timed out' });
  assert.match(await page.eval(`document.getElementById('error').textContent`), /did not finish signing in/);
  assert.equal(await page.eval(`document.getElementById('connectBtn').disabled`), false);
  await page.waitFor(`${OPEN_CONTEXTS} === 0`, { label: 'audio released' });
  environment.server.holdSync = false;
  await page.click('#connectBtn');
  await page.waitFor(`mutter.client.state === 'connected'`);
  assert.deepEqual(page.errors(), []);
});

test('long comments and channel descriptions arrive by hash and follow changes', { timeout: 60_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const { server } = environment;
  const rules = `House rules: ${'be kind, '.repeat(40)}`;
  server.channels.get(1).description = rules;
  await openClient(environment, 'Alpha');
  const bravo = await openClient(environment, 'Bravo');
  await bravo.waitFor(`mutter.client.channels.get(1)?.description === ${JSON.stringify(rules)}`, { label: 'long description fetched' });
  assert.equal(typeof (await bravo.eval('mutter.client.channels.get(1).descriptionHash')), 'string');
  assert.ok(server.blobRequests.some((request) => request.channelDescriptions.includes(1)));

  const alphaSession = [...server.users.values()].find((user) => user.name === 'Alpha').session;
  const biography = `About me: ${'I test voice chat clients. '.repeat(10)}`;
  server.setComment(alphaSession, biography);
  await bravo.waitFor(`${findUser('Alpha')}?.comment === ${JSON.stringify(biography)}`, { label: 'long comment fetched' });

  server.setComment(alphaSession, 'Short now');
  await bravo.waitFor(`${findUser('Alpha')}?.comment === 'Short now'`);
  assert.equal(await bravo.eval(`${findUser('Alpha')}.commentHash`), undefined);

  const newer = `Updated: ${'still testing. '.repeat(12)}`;
  server.setComment(alphaSession, newer);
  await bravo.waitFor(`${findUser('Alpha')}?.comment === ${JSON.stringify(newer)}`, { label: 'changed long comment fetched' });
  assert.deepEqual(bravo.errors(), []);
});
