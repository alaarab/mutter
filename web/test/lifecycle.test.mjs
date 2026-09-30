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

test('a channel tree with a parent loop renders each channel once', { timeout: 60_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await environment.browser.newPage(environment.bridge.url);
  const rendered = await page.eval(`(async () => {
    const { MumbleClient } = await import('/app/client.js');
    const { renderTree } = await import('/app/tree.js');
    const client = new MumbleClient();
    client.channels.set(0, { channelId: 0, name: 'Root', parent: 2 });
    client.channels.set(1, { channelId: 1, name: 'One', parent: 0 });
    client.channels.set(2, { channelId: 2, name: 'Two', parent: 1 });
    client.users.set(1, { session: 1, name: 'Looped', channelId: 2 });
    const container = document.createElement('div');
    renderTree(container, {
      client,
      audio: { isTransmitting: false },
      share: { available: new Map(), sharing: null },
      collapsed: new Set(),
      filter: '',
      unread: 0,
      isCurrent: () => false,
    });
    return [...container.querySelectorAll('.name')].map((name) => name.textContent);
  })()`);
  assert.deepEqual(rendered, ['Root', 'One', 'Two', 'Looped']);
  assert.deepEqual(page.errors(), []);
});

test('a new talk spurt is not counted as a delivery stall, a mid-speech loss burst still is', { timeout: 60_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await environment.browser.newPage(environment.bridge.url);
  const stalls = await page.eval(`(async () => {
    const { MumbleClient } = await import('/app/client.js');
    const { frame, MessageType } = await import('/src/mumble.js');
    const { Writer } = await import('/src/protobuf.js');
    const { encodeServerAudio } = await import('/src/voice.js');
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    let socket = null;
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        socket = this;
      }
      send() {}
      close() {}
    };
    const client = new MumbleClient();
    client.connect({ host: 'voice.example', port: 64738, username: 'Listener' });
    while (!socket) {
      await wait(10);
    }
    const deliver = (type, payload) => socket.onmessage({ data: frame(type, payload).buffer });
    socket.onmessage({ data: JSON.stringify({ event: 'open', fingerprint: 'f'.repeat(64) }) });
    deliver(MessageType.userState, new Writer().uint(1, 2).string(3, 'Talker').uint(5, 0).finish());
    deliver(MessageType.userState, new Writer().uint(1, 1).string(3, 'Listener').uint(5, 0).finish());
    deliver(MessageType.serverSync, new Writer().uint(1, 1).finish());
    const speak = (frameNumber, isTerminator = false) =>
      deliver(MessageType.udpTunnel, encodeServerAudio({ session: 2, frameNumber, opus: new Uint8Array([1, 2, 3]), isTerminator }, 'protobuf'));
    const counts = {};
    for (let packet = 0; packet < 10; packet++) speak(packet * 2);
    speak(20, true);
    await wait(400);
    for (let packet = 0; packet < 10; packet++) speak(200 + packet * 2);
    counts.afterTerminatedSpurt = client.stats.stalls;
    await wait(2200);
    for (let packet = 0; packet < 10; packet++) speak(600 + packet * 2);
    counts.afterLongSilence = client.stats.stalls;
    await wait(400);
    speak(700);
    counts.afterLossBurst = client.stats.stalls;
    client.disconnect();
    return counts;
  })()`);
  assert.deepEqual(stalls, { afterTerminatedSpurt: 0, afterLongSilence: 0, afterLossBurst: 1 });
  assert.deepEqual(page.errors(), []);
});

test('auto connect keeps the saved password in secure storage', { timeout: 60_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const { server, bridge } = environment;
  const page = await environment.browser.newPage(bridge.url);
  const secretKey = JSON.stringify(['127.0.0.1', server.port, 'Keeper']);
  await page.eval(`localStorage.setItem('mutter.servers', JSON.stringify([{ host: '127.0.0.1', port: ${server.port}, username: 'Keeper', lastUsed: 1 }]))`);
  await page.eval(`localStorage.setItem('mutter.certificates', JSON.stringify({ ${JSON.stringify(JSON.stringify(['127.0.0.1', server.port]))}: '${server.fingerprint}' }))`);
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.credentialWrites = [];
      window.mutterCredentials = {
        read: async () => ({ available: true, value: { servers: { ${JSON.stringify(secretKey)}: 'hunter2' }, turn: '' } }),
        write: async (value) => { window.credentialWrites.push(value); },
      };
    `,
  });
  await page.goto(`${bridge.url}/?source=tone#auto`);
  await page.waitFor(`mutter.client.state === 'connected'`, { label: 'auto connected' });
  await sleep(300);
  const writes = await page.eval('window.credentialWrites');
  for (const write of writes) {
    assert.equal(write.servers[secretKey], 'hunter2');
  }
  assert.equal(await page.eval(`mutter.client.state`), 'connected');
  assert.ok(!(await page.eval(`localStorage.getItem('mutter.servers')`)).includes('hunter2'));
  assert.deepEqual(page.errors(), []);
});

test('an empty terminator packet still ends the speaker’s stream', { timeout: 60_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await environment.browser.newPage(environment.bridge.url);
  const ended = await page.eval(`(async () => {
    const { AudioEngine } = await import('/app/audio.js');
    const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const packets = [];
    const encoder = new AudioEncoder({ output: (chunk) => { const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); packets.push(bytes); }, error() {} });
    encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000, opus: { frameDuration: 20000 } });
    for (let index = 0; index < 3; index++) {
      encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: index * 20000, data: new Float32Array(960).fill(0.01) }));
    }
    await encoder.flush();
    const ends = [];
    const originalPost = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, ...rest) {
      if (message?.type === 'end') {
        ends.push(message.session);
      }
      return originalPost.call(this, message, ...rest);
    };
    const client = Object.assign(new EventTarget(), {
      users: new Map([[2, { session: 2, name: 'Talker' }]]),
      isConnected: false,
      diag() {},
      setSelfMute() {},
      setSelfDeaf() {},
    });
    const engine = new AudioEngine(client, {});
    await engine.start({ source: 'tone' });
    const voice = (frameNumber, opus, isTerminator = false) =>
      client.dispatchEvent(new CustomEvent('voice', { detail: { session: 2, frameNumber: BigInt(frameNumber), opus, isTerminator } }));
    voice(0, packets[0]);
    voice(2, packets[1]);
    await wait(100);
    voice(4, new Uint8Array(0), true);
    await wait(100);
    await engine.stop();
    MessagePort.prototype.postMessage = originalPost;
    return ends;
  })()`);
  assert.deepEqual(ended, [2]);
  assert.deepEqual(page.errors(), []);
});

test('self mute and deafen survive a dropped connection and a relaunch', { timeout: 90_000 }, async (t) => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const serverSees = (field) => [...environment.server.users.values()].find((user) => user.name === 'Quiet')?.[field] === true;
  const waitForServer = async (field, label) => {
    const deadline = Date.now() + 10_000;
    while (!serverSees(field)) {
      if (Date.now() > deadline) {
        throw new Error(`the server never saw ${label}`);
      }
      await sleep(50);
    }
  };

  let page = await openInstrumented(environment);
  await fillConnectForm(page, environment, 'Quiet');
  await page.click('#connectBtn');
  await trustIfAsked(page, environment);
  await page.waitFor(`mutter.client.state === 'connected'`);
  await page.click('#muteBtn');
  await waitForServer('selfMute', 'the mute');

  for (const user of environment.server.users.values()) {
    if (user.name === 'Quiet') {
      user.socket.destroy();
    }
  }
  await page.waitFor(`mutter.client.state === 'reconnecting'`, { timeout: 5000 });
  await page.waitFor(`mutter.client.state === 'connected'`, { timeout: 15_000 });
  await waitForServer('selfMute', 'the mute after reconnecting');
  assert.equal(await page.eval('mutter.audio.muted'), true);

  await page.click('#deafBtn');
  await waitForServer('selfDeaf', 'the deafen');
  await page.click('#leaveBtn');
  await page.waitFor(`mutter.client.state === 'disconnected'`);
  await page.close();

  page = await openInstrumented(environment);
  assert.equal(await page.eval('mutter.audio.muted && mutter.audio.deafened'), true);
  await fillConnectForm(page, environment, 'Quiet');
  await page.click('#connectBtn');
  await trustIfAsked(page, environment);
  await page.waitFor(`mutter.client.state === 'connected'`);
  await waitForServer('selfDeaf', 'the deafen after relaunching');
  assert.ok(serverSees('selfMute'), 'deafened implies muted on the server');
  assert.deepEqual(page.errors(), []);
});
