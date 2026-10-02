import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ScreenShare } from '../app/share.js';
import { encodeSignal, SignalAssembler, DATA_ID } from '../src/rtcsignal.js';

function capture({ video = true, label = 'Screen' } = {}) {
  const track = Object.assign(new EventTarget(), {
    kind: video ? 'video' : 'audio', label, readyState: 'live',
    getSettings: () => ({ width: 640, height: 360 }),
    stop() { this.readyState = 'ended'; },
  });
  return { track, getTracks: () => [track], getVideoTracks: () => video ? [track] : [], getAudioTracks: () => video ? [] : [track] };
}

function setup(t, getDisplayMedia) {
  // Only suppress the perpetual stats poll; promise/compression scheduling stays real.
  t.mock.method(globalThis, 'setInterval', () => 0);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getDisplayMedia }, configurable: true });
  t.after(() => delete navigator.mediaDevices);
  const client = Object.assign(new EventTarget(), {
    state: 'connected', isConnected: true, me: 1,
    myUser: { session: 1, channelId: 0 },
    users: new Map([[1, { session: 1, channelId: 0 }], [2, { session: 2, channelId: 0 }]]),
    usersIn() { return [...this.users.values()]; },
    diag() {},
    packets: [],
    sendPlugin(receivers, dataId, data) { this.packets.push(data); },
    disconnect() {
      this.state = 'disconnected';
      this.isConnected = false;
      this.dispatchEvent(new Event('state'));
    },
  });
  const share = new ScreenShare(client, {});
  t.after(() => client.disconnect());
  return { client, share };
}

test('two screen-share starts open one picker and stop releases all captured tracks', async t => {
  const stream = capture();
  let resolve;
  let opened = 0;
  const { share } = setup(t, () => { opened++; return new Promise(done => { resolve = done; }); });
  const first = share.start();
  const second = share.start();
  const pickerCount = opened;
  resolve(stream);
  assert.equal(pickerCount, 1);
  await Promise.all([first, second]);
  share.stop();
  assert.equal(stream.track.readyState, 'ended');
});

for (const action of ['stop', 'disconnect']) {
  test(`${action} while the picker is open cancels the pending capture`, async t => {
    const stream = capture();
    let resolve;
    const { client, share } = setup(t, () => new Promise(done => { resolve = done; }));
    const starting = share.start();
    if (action === 'stop') share.stop();
    else client.disconnect();
    resolve(stream);
    await starting;
    assert.equal(share.sharing, null);
    assert.equal(stream.track.readyState, 'ended');
  });
}

test('a capture without video releases its audio before rejecting', async t => {
  const stream = capture({ video: false });
  const { share } = setup(t, () => Promise.resolve(stream));
  await assert.rejects(share.start(), /No video track/);
  assert.equal(stream.track.readyState, 'ended');
});

test('compression cannot reorder an announcement after its stop message', async t => {
  const { client, share } = setup(t);
  const stream = capture({ label: 'Presentation – 演示 '.repeat(4) });
  await share.start({ stream });
  share.stop();
  await sleep(100);
  const assembler = new SignalAssembler();
  const messages = [];
  for (const packet of client.packets) {
    const message = await assembler.push(1, packet);
    if (message) messages.push(message.t);
  }
  assert.deepEqual(messages, ['announce', 'stop']);
});

test('an announcement still being compressed cannot escape into a new session', async t => {
  const { client, share } = setup(t);
  await share.start({ stream: capture({ label: 'Presentation – 演示 '.repeat(4) }) });
  client.disconnect();
  client.state = 'connected';
  client.isConnected = true;
  await sleep(100);
  assert.equal(client.packets.length, 0);
});

test('receiving a compressed announcement followed by stop leaves no stale offer', async t => {
  const { client, share } = setup(t);
  const messages = [
    { t: 'announce', id: 'screen', title: 'Presentation – 演示 '.repeat(20) },
    { t: 'stop', id: 'screen' },
  ];
  const packets = (await Promise.all(messages.map((message, index) => encodeSignal(message, index)))).flat();
  for (const data of packets) {
    client.dispatchEvent(new CustomEvent('plugin', { detail: { sender: 2, dataId: DATA_ID, data } }));
  }
  await sleep(100);
  assert.equal(share.available.size, 0);
});

test('disconnect discards an announcement still being decompressed', async t => {
  const { client, share } = setup(t);
  for (const data of await encodeSignal({ t: 'announce', id: 'screen', title: 'Presentation – 演示 '.repeat(20) }, 1)) {
    client.dispatchEvent(new CustomEvent('plugin', { detail: { sender: 2, dataId: DATA_ID, data } }));
  }
  client.disconnect();
  client.state = 'connected';
  client.isConnected = true;
  await sleep(100);
  assert.equal(share.available.size, 0);
});

test('a delayed ended event from an old capture cannot stop its replacement', async t => {
  const { share } = setup(t);
  const old = capture();
  await share.start({ stream: old });
  share.stop();
  const current = capture();
  await share.start({ stream: current });
  old.track.dispatchEvent(new Event('ended'));
  assert.equal(share.sharing.stream, current);
  assert.equal(current.track.readyState, 'live');
});
