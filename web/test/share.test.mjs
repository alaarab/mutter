import { startEnvironment, createReporter, openClient, sleep } from './harness.mjs';

const environment = await startEnvironment({ chromeArgs: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const { server, shots } = environment;
const { check, step, checkNoPageErrors, finish } = createReporter();

const plugin = { count: 0, bytes: 0, max: 0, drops: 0 };
server.on('plugin', (message) => {
  plugin.count++;
  plugin.bytes += message.bytes;
  plugin.max = Math.max(plugin.max, message.bytes);
});
server.on('drop', () => plugin.drops++);

async function openViewer(name) {
  const page = await openClient(environment, name);
  await page.eval(`mutter.settings.transmitMode = 'ptt'`);
  return page;
}

try {
  const alpha = await openViewer('Alpha');
  const bravo = await openViewer('Bravo');
  await alpha.waitFor('mutter.client.users.size === 2');

  await step('Alpha starts sharing a 640×360 canvas stream with an audio track', async () => {
    await alpha.eval(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext('2d');
      let frame = 0;
      setInterval(() => {
        context.fillStyle = \`hsl(\${frame++ % 360} 70% 50%)\`;
        context.fillRect(0, 0, 640, 360);
        context.fillStyle = '#fff';
        context.font = '48px sans-serif';
        context.fillText('frame ' + frame, 40, 200);
      }, 33);
      const stream = canvas.captureStream(30);
      const audioContext = new AudioContext();
      const oscillator = new OscillatorNode(audioContext);
      const destination = new MediaStreamAudioDestinationNode(audioContext);
      oscillator.connect(destination);
      oscillator.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      return mutter.share.start({ stream, contentHint: 'motion' });
    })()`);
    await alpha.waitFor('!!mutter.share.sharing && mutter.share.sharing.audio === true');
    await alpha.waitFor(
      `document.getElementById('shareBtn').classList.contains('active') && !document.getElementById('screenBtn').hidden && document.body.dataset.tab === 'screen'`
    );
  });

  await step('Bravo is offered the share (announce arrived, card and badge shown)', async () => {
    await bravo.waitFor('mutter.share.available.size === 1', { timeout: 5000 });
    await bravo.waitFor(
      `!!document.querySelector('.offer .watch') && !!document.querySelector('.user .live-badge') && !document.getElementById('screenBtn').hidden`
    );
    await bravo.waitFor(`[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('started sharing'))`, { timeout: 3000 });
  });

  await step('Watch → WebRTC connects and frames arrive with stats', async () => {
    await alpha.send('Page.bringToFront');
    await bravo.eval('mutter.settings.shareAudio = false');
    await bravo.click('.offer .watch');
    await bravo.waitFor(`mutter.share.watching?.state === 'connected'`, { timeout: 15_000, label: 'peer connection connected' });
    await alpha.waitFor(`!![...mutter.share.sharing.peers.values()][0]?.remoteDescription?.sdp`, { label: 'sharer applied the answer' });
    const audio = await alpha.eval(`(() => {
      const sdp = [...mutter.share.sharing.peers.values()][0].remoteDescription.sdp;
      const section = sdp.split(/(?=m=)/).find(s => s.startsWith('m=audio')) ?? '';
      return { port: Number(section.split(' ')[1]), inactive: /a=inactive/.test(section), video: /m=video/.test(sdp) };
    })()`);
    if (!audio.video || !(audio.port === 0 || audio.inactive)) {
      throw new Error(`viewer did not decline audio: ${JSON.stringify(audio)}`);
    }
    await bravo.waitFor(`mutter.share.watching?.stats.w === 640 && mutter.share.watching.stats.h === 360`, {
      timeout: 15_000,
      label: 'video stats report 640×360',
    });
    await bravo.waitFor(
      `(() => { const v = document.querySelector('#stage video'); return v && v.videoWidth === 640 && v.getVideoPlaybackQuality().totalVideoFrames > 2; })()`,
      { timeout: 8000, label: 'video element decoding frames' }
    );
    await bravo.waitFor(`document.getElementById('shareStats')?.textContent.includes('640×360')`);
    if ((await bravo.eval(`document.querySelector('.stage-bar .title .sub')?.textContent`)) !== 'Screen') {
      throw new Error('opaque track label leaked into the title');
    }
    await alpha.waitFor(`mutter.share.viewerCount === 1`, { timeout: 5000 });
    if (shots) {
      await bravo.send('Page.bringToFront');
      await bravo.screenshot(`${shots}/04-watching.png`);
      await alpha.send('Page.bringToFront');
      await alpha.screenshot(`${shots}/05-sharing.png`);
    }
  });

  await step('sharer can switch content hint while live', async () => {
    await alpha.eval(`mutter.share.setContentHint('detail')`);
    await sleep(300);
    if ((await bravo.eval(`mutter.share.watching?.state`)) !== 'connected') {
      throw new Error('connection dropped');
    }
  });

  await step('Stop watching closes the sharer’s peer', async () => {
    await bravo.eval(`document.querySelector('.stage-bar .icon[title="Stop watching"]').click()`);
    await bravo.waitFor('!mutter.share.watching');
    await alpha.waitFor('mutter.share.sharing.peers.size === 0', { timeout: 5000 });
    if (!(await bravo.eval(`!!document.querySelector('.offer .watch')`))) {
      throw new Error('offer card should return');
    }
  });

  await step('watching twice in a row keeps one connection', async () => {
    await bravo.eval(`(() => {
      const sender = [...mutter.share.available.keys()][0];
      mutter.share.watch(sender);
      mutter.share.watch(sender);
    })()`);
    await bravo.waitFor(`mutter.share.watching?.state === 'connected'`, { timeout: 15_000, label: 'double watch connected' });
    await sleep(1500);
    if ((await bravo.eval(`mutter.share.watching?.state`)) !== 'connected') {
      throw new Error('the second watch broke the first connection');
    }
    const peers = await alpha.eval('mutter.share.sharing.peers.size');
    if (peers !== 1) {
      throw new Error(`sharer holds ${peers} peers for one viewer`);
    }
  });

  await step('a viewer who leaves the channel is dropped and cannot watch from outside', async () => {
    await bravo.eval('mutter.client.joinChannel(1)');
    await alpha.waitFor('mutter.share.sharing.peers.size === 0', { timeout: 5000, label: 'sharer closed the departed viewer' });
    await bravo.waitFor('!mutter.share.watching && mutter.share.available.size === 0', { timeout: 5000 });
    await bravo.eval(`(async () => {
      const { encodeSignal, DATA_ID } = await import('/src/rtcsignal.js');
      const sharer = [...mutter.client.users.values()].find((user) => user.name === 'Alpha').session;
      const id = ${JSON.stringify(await alpha.eval('mutter.share.sharing.id'))};
      for (const data of await encodeSignal({ t: 'watch', id }, 200)) {
        mutter.client.sendPlugin([sharer], DATA_ID, data);
      }
    })()`);
    await alpha.waitFor(`mutter.client.log.some((entry) => entry.message.includes('not in this channel'))`, { timeout: 5000 });
    if ((await alpha.eval('mutter.share.sharing.peers.size')) !== 0) {
      throw new Error('sharer answered a watch from another channel');
    }
  });

  await step('coming back to the channel offers the share again', async () => {
    await bravo.eval('mutter.client.joinChannel(0)');
    await bravo.waitFor('mutter.share.available.size === 1', { timeout: 5000, label: 'announce after returning' });
    await bravo.click('.offer .watch');
    await bravo.waitFor(`mutter.share.watching?.state === 'connected'`, { timeout: 15_000 });
    await bravo.eval(`document.querySelector('.stage-bar .icon[title="Stop watching"]').click()`);
    await alpha.waitFor('mutter.share.sharing.peers.size === 0', { timeout: 5000 });
  });

  await step('two quick camera starts leave no camera running after Camera off', async () => {
    const live = await alpha.eval(`(async () => {
      const tracks = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await original(constraints);
        tracks.push(...stream.getTracks());
        return stream;
      };
      await Promise.all([mutter.share.startCamera(), mutter.share.startCamera()]);
      mutter.share.stopCamera();
      navigator.mediaDevices.getUserMedia = original;
      return { opened: tracks.length, live: tracks.filter((track) => track.readyState === 'live').length };
    })()`);
    if (live.opened !== 1 || live.live !== 0) {
      throw new Error(`camera tracks after Camera off: ${JSON.stringify(live)}`);
    }
  });

  await step('a newcomer to the channel is announced to immediately', async () => {
    const charlie = await openViewer('Charlie');
    await charlie.waitFor('mutter.share.available.size === 1', { timeout: 4000 });
    await charlie.eval('mutter.client.disconnect()');
    await alpha.waitFor('mutter.client.users.size === 2');
  });

  await step('Stop sharing clears the offer everywhere', async () => {
    await alpha.click('#shareBtn');
    await alpha.waitFor('!mutter.share.sharing');
    await bravo.waitFor(
      'mutter.share.available.size === 0 && document.getElementById("screenBtn").hidden && document.body.dataset.tab !== "screen"',
      { timeout: 4000 }
    );
  });

  check(
    plugin.count > 0 && plugin.max <= 1000,
    `server relayed ${plugin.count} plugin messages (${plugin.bytes} bytes, largest ${plugin.max})`
  );
  check(plugin.drops === 0, 'nothing was rate-limited or oversized');
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
