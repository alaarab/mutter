import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startEnvironment } from './harness.mjs';

test('hostile markup stays inert and cannot break chat rendering', { timeout: 30_000 }, async t => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await environment.browser.newPage(environment.bridge.url);
  const rendered = await page.eval(`(async () => {
    const { sanitize } = await import('/app/chat.js');
    const host = document.createElement('div');
    host.append(sanitize('<constructor>hello</constructor><script>window.compromised=true</script><svg onload="window.compromised=true"></svg><a href="javascript:alert(1)">unsafe</a><b onclick="alert(1)">bold</b><img src="file:///etc/passwd"><img src="data:image/png;base64,AA==" alt="Shared drawing">'));
    return { html: host.innerHTML, text: host.textContent, compromised: !!window.compromised };
  })()`);
  assert.equal(rendered.compromised, false);
  assert.ok(rendered.text.includes('hello'));
  assert.ok(rendered.html.includes('<b>bold</b>'));
  assert.ok(rendered.html.includes('alt="Shared drawing"'));
  for (const value of ['javascript:', 'onclick', 'onload', 'file:', '<script', '<svg', '<constructor']) {
    assert.ok(!rendered.html.includes(value), value);
  }
  const headers = await fetch(environment.bridge.url).then(response => response.headers);
  assert.ok(headers.get('content-security-policy').includes("script-src 'self'"));
  assert.ok(headers.get('content-security-policy').includes("frame-src 'none'"));
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.deepEqual(page.errors(), []);
});

test('share controls reject forged senders and bound candidates before an offer', { timeout: 30_000 }, async t => {
  const environment = await startEnvironment();
  t.after(() => environment.close());
  const page = await environment.browser.newPage(environment.bridge.url);
  const result = await page.eval(`(async () => {
    const { ScreenShare } = await import('/app/share.js');
    const { encodeSignal } = await import('/src/rtcsignal.js');
    let peer;
    window.RTCPeerConnection = class {
      candidates = [];
      iceGatheringState = 'complete';
      constructor() { peer = this; }
      async setRemoteDescription(value) { this.remoteDescription = value; }
      async addIceCandidate(value) { this.candidates.push(value); }
      async createAnswer() { return { type: 'answer', sdp: 'test' }; }
      async setLocalDescription(value) { this.localDescription = value; }
      async getStats() { return new Map(); }
      close() { this.closed = true; }
    };
    const client = Object.assign(new EventTarget(), { users: new Map([[1, {}], [2, {}]]), diag() {} });
    const share = new ScreenShare(client, {});
    let sequence = 0;
    async function deliver(sender, message) {
      for (const data of await encodeSignal(message, sequence++)) {
        client.dispatchEvent(new CustomEvent('plugin', { detail: { sender, dataId: 'mutter/rtc', data } }));
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await deliver(99, { t: 'announce', id: 'forged' });
    await deliver(1, { t: 'announce', id: 'screen', title: { invalid: true } });
    const announced = [...share.available.keys()];
    await share.watch(1);
    await deliver(2, { t: 'stop', id: 'screen' });
    await deliver(1, { t: 'stop', id: 'old-screen' });
    const retained = share.watching?.id;
    await deliver(2, { t: 'ice', id: 'screen', c: [{ candidate: 'forged' }] });
    await deliver(1, { t: 'ice', id: 'screen', c: [null, {}, 'bad', { candidate: 'x'.repeat(4097) }] });
    for (let i = 0; i < 3; i++) {
      await deliver(1, { t: 'ice', id: 'screen', c: Array.from({ length: 256 }, () => ({ candidate: 'valid' })) });
    }
    await deliver(1, { t: 'offer', id: 'screen', sdp: 'test' });
    const candidates = peer.candidates;
    await deliver(1, { t: 'stop', id: 'screen' });
    return { announced, retained, count: candidates.length, valid: candidates.every(c => c.candidate === 'valid'), stopped: !share.watching };
  })()`);
  assert.deepEqual(result, { announced: [1], retained: 'screen', count: 256, valid: true, stopped: true });
  assert.deepEqual(page.errors(), []);
});
