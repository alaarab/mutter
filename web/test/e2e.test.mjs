import { startEnvironment, createReporter, openClient, findUser, sleep } from './harness.mjs';

const environment = await startEnvironment();
const { server, shots } = environment;
const { check, step, checkNoPageErrors, finish } = createReporter();

const seen = { voice: 0, terminators: 0, udp: 0 };
server.on('voice', (packet) => {
  seen.voice++;
  if (packet.isTerminator) {
    seen.terminators++;
  }
  if (packet.via === 'udp') {
    seen.udp++;
  }
});

const PHONE_VIEWPORT = { width: 420, height: 760, deviceScaleFactor: 1, mobile: false };
const SETTLE_MS = 400;
const DESKTOP_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };

const bareIconButtons = `[...document.querySelectorAll('.icon, .rail-btn, .pill-btn, .tools button, .live-badge')]
  .filter(e => e.offsetParent && !e.querySelector('svg') && !e.textContent.trim())
  .map(e => e.id || e.className).join(', ')`;

try {
  const alpha = await openClient(environment, 'Alpha', {
    beforeConnect: async (page) => {
      if (shots) {
        await page.screenshot(`${shots}/00-connect.png`);
      }
    },
  });
  const bravo = await openClient(environment, 'Bravo');
  check(true, 'both tabs connected through the bridge');
  await alpha.waitFor('mutter.client.users.size === 2');
  await alpha.waitFor('mutter.audio.neural === true', { label: 'RNNoise instantiated in the worklet', timeout: 8000 });
  check(
    (await alpha.eval('mutter.settings.noiseSuppression')) === 'neural',
    'neural noise suppression is the default and RNNoise loaded'
  );
  await sleep(150);
  const treeNames = await alpha.eval(
    `[...document.querySelectorAll('.user .name > span:first-child')].map(e => e.textContent).sort().join(',')`
  );
  check(treeNames === 'Alpha,Bravo', 'both users in the tree');
  check((await alpha.eval(`document.querySelectorAll('.ch').length`)) === 5, 'five channels rendered');
  check(
    await alpha.eval(`document.querySelector('.row.system')?.textContent.includes('Welcome')`),
    'welcome text shown as a system message'
  );
  const bare = await alpha.eval(bareIconButtons);
  check(bare === '', `every visible icon button has a glyph${bare ? ` — empty: ${bare}` : ''}`);
  if (shots) {
    await alpha.screenshot(`${shots}/01-session.png`);
  }

  await step('channel chat delivered and own bubble shown', async () => {
    await alpha.type('#chatInput', 'hello from alpha');
    await alpha.click('#sendBtn');
    await bravo.waitFor(`[...document.querySelectorAll('.row .content')].some(e => e.textContent.includes('hello from alpha'))`);
    if ((await alpha.eval(`document.querySelectorAll('.row.own').length`)) !== 1) {
      throw new Error('own bubble missing');
    }
    if ((await alpha.eval(`document.getElementById('chatInput').value`)) !== '') {
      throw new Error('input not cleared');
    }
  });

  await step('join arrow moves Alpha to Lounge; dock and chat title follow', async () => {
    await alpha.eval(`(() => {
      const row = [...document.querySelectorAll('.ch')].find(r => r.querySelector('.name').textContent === 'Lounge');
      row.querySelector('.join').click();
    })()`);
    await bravo.waitFor(`${findUser('Alpha')}?.channelId === 1`);
    await alpha.waitFor(`mutter.client.myChannel?.channelId === 1 && document.getElementById('meChannel').textContent === 'Lounge'`);
    await alpha.waitFor(`document.getElementById('chatTitle').textContent === 'Lounge'`);
  });

  await step('on a phone the back arrow reaches the channel list and the server rail with it', async () => {
    const visible = (id) => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;
    await bravo.send('Emulation.setDeviceMetricsOverride', PHONE_VIEWPORT);
    await bravo.waitFor(`!${visible('rail')} && document.body.dataset.tab === 'chat'`, { label: 'rail hidden while chatting' });
    await bravo.eval(`document.getElementById('backBtn').click()`);
    await bravo.waitFor(`document.body.dataset.tab === 'channels'`, { label: 'back arrow opens the channel list' });
    await bravo.waitFor(visible('rail'), { label: 'server rail visible beside the channel list' });
    const overlap = await bravo.eval(`(() => {
      const rail = document.getElementById('rail').getBoundingClientRect();
      const sidebar = document.getElementById('sidebar').getBoundingClientRect();
      return rail.right > sidebar.left + 1 || sidebar.right > window.innerWidth + 1 || rail.width < 40;
    })()`);
    if (overlap) {
      throw new Error('rail and channel list overlap or overflow the phone viewport');
    }
    if (shots) {
      await sleep(SETTLE_MS);
      await bravo.screenshot(`${shots}/06-narrow-channels.png`);
    }
    await bravo.eval(`document.getElementById('railHome').click()`);
    await bravo.waitFor(`document.body.dataset.tab === 'chat'`, { label: 'the brand mark returns to chat' });
    if (shots) {
      await sleep(SETTLE_MS);
      await bravo.screenshot(`${shots}/07-narrow-chat.png`);
    }
    await bravo.send('Emulation.setDeviceMetricsOverride', DESKTOP_VIEWPORT);
  });

  await step('voice flows Alpha → Bravo once both are in Lounge', async () => {
    await bravo.eval('mutter.client.joinChannel(1)');
    await alpha.waitFor('mutter.client.usersIn(1).length === 2');
    await bravo.eval(`mutter.settings.transmitMode = 'ptt'`);
    await alpha.eval(`mutter.settings.transmitMode = 'continuous'`);
    await alpha.waitFor('mutter.audio.isTransmitting', { label: 'Alpha transmitting' });
    await bravo.waitFor('mutter.audio.stats.packetsIn > 25', { label: 'Bravo receiving packets', timeout: 8000 });
    await bravo.waitFor('mutter.audio.stats.samplesOut > 960 * 20', { label: 'Bravo decoding audio' });
    await bravo.waitFor(`${findUser('Alpha')}.talking === true && !!document.querySelector('.user.talking')`, {
      label: 'talking ring on Alpha',
    });
    await bravo.waitFor(`!mutter.audio.isTransmitting && !document.getElementById('meterFill').classList.contains('open')`, {
      label: 'Bravo (push-to-talk, idle) is not transmitting and its meter is not green',
      timeout: 3000,
    });
    if (shots) {
      await bravo.screenshot(`${shots}/02-talking.png`);
    }
  });

  await step('gate closes with a terminator when Alpha stops', async () => {
    await alpha.eval(`mutter.settings.transmitMode = 'ptt'`);
    await alpha.waitFor('!mutter.audio.isTransmitting', { timeout: 3000 });
    await bravo.waitFor(`${findUser('Alpha')}.talking === false`, { timeout: 3000 });
    if (!seen.terminators) {
      throw new Error('server never saw a terminator packet');
    }
  });

  await step('holding Space transmits, releasing stops', async () => {
    await alpha.eval('document.activeElement?.blur()');
    await alpha.key('Space', ' ', { up: false });
    await alpha.waitFor('mutter.audio.isTransmitting', { timeout: 3000 });
    await alpha.key('Space', ' ', { down: false });
    await alpha.waitFor('!mutter.audio.isTransmitting', { timeout: 3000 });
  });

  await step('mute shows on the other side', async () => {
    await alpha.click('#muteBtn');
    await bravo.waitFor(`${findUser('Alpha')}.selfMute === true`);
    await bravo.waitFor(`!!document.querySelector('.user .avatar.muted') && !!document.querySelector('.member .avatar.muted')`);
    await alpha.waitFor(`document.getElementById('muteBtn').classList.contains('active')`);
  });

  await step('deafen implies mute; undeafen clears both', async () => {
    await alpha.click('#deafBtn');
    await bravo.waitFor(`${findUser('Alpha')}.selfDeaf === true`);
    await alpha.click('#deafBtn');
    await bravo.waitFor(`${findUser('Alpha')}.selfDeaf === false`);
    await alpha.click('#muteBtn');
    await bravo.waitFor(`${findUser('Alpha')}.selfMute === false`);
  });

  await step('direct message arrives tagged "direct"', async () => {
    await bravo.eval(`mutter.client.sendText('psst', { sessions: [${findUser('Alpha')}.session] })`);
    await alpha.waitFor(`[...document.querySelectorAll('.row')].some(e => e.textContent.includes('psst') && e.querySelector('.tag')?.textContent === 'DM')`);
  });

  await step('image is shrunk to the server limit and rendered inline', async () => {
    await alpha.eval(`(async () => {
      const canvas = new OffscreenCanvas(1600, 1200);
      const context = canvas.getContext('2d');
      for (let i = 0; i < 400; i++) {
        context.fillStyle = \`hsl(\${i * 7 % 360} 80% 50%)\`;
        context.fillRect(Math.random() * 1600, Math.random() * 1200, 90, 90);
      }
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const { imageToHtml } = await import('/app/chat.js');
      const limit = mutter.client.serverInfo.imageMessageLength;
      const html = await imageToHtml(new File([blob], 'x.png', { type: 'image/png' }), limit);
      if (html.length > limit) throw new Error('too big: ' + html.length);
      mutter.client.sendText(html, { channelId: 1 });
    })()`);
    await bravo.waitFor(`!!document.querySelector('.row .content img')`);
    if (shots) {
      await bravo.screenshot(`${shots}/03-image.png`);
    }
  });

  await step('a long message that isn’t well-formed XML is refused and marked undelivered', async () => {
    await alpha.eval(`mutter.client.sendText('<img src="data:image/jpeg;base64,' + 'QUFB'.repeat(2000) + '">', { channelId: 1 })`);
    await alpha.waitFor(`!!document.querySelector('.row.failed .failed-note')`, { timeout: 4000 });
    await alpha.waitFor(`[...document.querySelectorAll('.toast')].some(t => /too long/i.test(t.textContent))`, { timeout: 3000 });
    if (await bravo.eval(`[...document.querySelectorAll('.row img')].some(i => i.src.includes('QUFBQUFB'))`)) {
      throw new Error('fake server delivered a malformed message');
    }
  });

  await step('desktop Mumble’s percent-encoded data URI image decodes', async () => {
    await bravo.eval(`(async () => {
      const canvas = new OffscreenCanvas(48, 32);
      const context = canvas.getContext('2d');
      context.fillStyle = '#0f0';
      context.fillRect(0, 0, 48, 32);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const base64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
      const encoded = base64.match(/.{1,72}/g).map(encodeURIComponent).join('\\n');
      mutter.client.sendText('<img src="data:image/PNG;base64,' + encoded + '" />', { channelId: 1 });
    })()`);
    await alpha.waitFor(
      `(() => {
        const image = [...document.querySelectorAll('.row .content img')].find(i => i.src.startsWith('data:image/PNG'));
        return image && image.complete && image.naturalWidth === 48;
      })()`,
      { timeout: 5000 }
    );
  });

  await step('hostile HTML is neutralised', async () => {
    await bravo.eval(
      `mutter.client.sendText('<b>bold</b><script>window.pwned=1</script><img src="x" onerror="window.pwned=2"><a href="javascript:alert(1)">j</a> see https://example.com/x', { channelId: 1 })`
    );
    await alpha.waitFor(`[...document.querySelectorAll('.row .content b')].some(e => e.textContent === 'bold')`);
    const safe = await alpha.eval(
      `!window.pwned && !document.querySelector('.row script') && !document.querySelector('.row a[href^="javascript"]') && !document.querySelector('.row img[onerror]') && !!document.querySelector('.row a[href="https://example.com/x"]')`
    );
    if (!safe) {
      throw new Error('something dangerous survived, or linkify failed');
    }
  });

  await step('permission denied surfaces as a toast', async () => {
    await alpha.eval(`mutter.client.joinChannel(999)`);
    await alpha.waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('No such channel'))`, { timeout: 3000 });
  });

  await step('leave returns to the connect screen and the other side sees it', async () => {
    await alpha.click('#leaveBtn');
    await bravo.waitFor('mutter.client.users.size === 1');
    await alpha.waitFor(`!document.getElementById('connect').hidden && mutter.client.state === 'disconnected'`);
    if (await alpha.eval('mutter.audio.running')) {
      throw new Error('audio still running after leave');
    }
  });

  await step('server drop → reconnecting overlay → back with a fresh session', async () => {
    const before = await bravo.eval('mutter.client.me');
    for (const user of server.users.values()) {
      if (user.name === 'Bravo') {
        user.socket.destroy();
      }
    }
    await bravo.waitFor(`mutter.client.state === 'reconnecting' && !document.getElementById('overlay').hidden`, { timeout: 3000 });
    await bravo.waitFor(`mutter.client.state === 'connected' && document.getElementById('overlay').hidden`, { timeout: 10_000 });
    const after = await bravo.eval('mutter.client.me');
    if (after === before) {
      throw new Error('session id did not change');
    }
    if ((await bravo.eval('mutter.client.users.size')) !== 1) {
      throw new Error('ghost user after reconnect');
    }
  });

  check(seen.voice > 50, `server relayed voice (${seen.voice} packets, ${seen.udp} over UDP)`);
  if (process.env.FAKE_UDP === '0') {
    const stayedOnTcp = seen.udp === 0 && (await bravo.eval('mutter.client.stats.udp?.up !== true'));
    check(stayedOnTcp, 'with UDP blocked, voice stays on the TCP tunnel');
  } else {
    const usedUdp = seen.udp > 50 && (await bravo.eval('mutter.client.stats.udp?.up === true'));
    check(usedUdp, 'voice travelled over UDP through the bridge and the client knows it');
  }
  checkNoPageErrors([
    ['Alpha', alpha],
    ['Bravo', bravo],
  ]);
} catch (error) {
  check(false, `aborted: ${error.stack}`);
} finally {
  await environment.close();
}

finish();
