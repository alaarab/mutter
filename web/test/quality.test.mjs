import { startEnvironment, createReporter, openClient, sleep } from './harness.mjs';

const SAMPLE_RATE = 48000;
const TONE_HZ = 440;
const CAPTURE_MS = Number(process.env.CAPTURE_MS ?? 4000);
const DROPOUT_SAMPLES = 96;
const CLICK_SLOPE_FACTOR = 4;
const FIT_WINDOW = 2400;
const HEALTH_SETTLE_MS = 1200;
const loss = Number(process.env.FAKE_LOSS ?? 0);
const jitterMs = Number(process.env.FAKE_JITTER ?? 0);
const impaired = loss > 0 || jitterMs > 0;

const environment = await startEnvironment();
const { check, step, checkNoPageErrors, finish } = createReporter();

function fitSine(block, omega) {
  let inPhase = 0;
  let quadrature = 0;
  for (let n = 0; n < block.length; n++) {
    inPhase += block[n] * Math.cos(omega * n);
    quadrature += block[n] * Math.sin(omega * n);
  }
  const a = (2 * inPhase) / block.length;
  const b = (2 * quadrature) / block.length;
  let residualPower = 0;
  for (let n = 0; n < block.length; n++) {
    const fitted = a * Math.cos(omega * n) + b * Math.sin(omega * n);
    residualPower += (block[n] - fitted) ** 2;
  }
  const amplitude = Math.hypot(a, b);
  return { amplitude, tonePower: (amplitude * amplitude) / 2, residualPower: residualPower / block.length };
}

function analyzeTone(samples, frequency, rate) {
  let start = 0;
  while (start < samples.length && samples[start] === 0) {
    start++;
  }
  let end = samples.length;
  while (end > start && samples[end - 1] === 0) {
    end--;
  }
  const active = samples.subarray(start, end);
  const count = active.length;
  if (count === 0) {
    return null;
  }
  const omega = (2 * Math.PI * frequency) / rate;
  let tonePower = 0;
  let residualPower = 0;
  let amplitudeSum = 0;
  let windows = 0;
  for (let from = 0; from + FIT_WINDOW <= count; from += FIT_WINDOW) {
    const fit = fitSine(active.subarray(from, from + FIT_WINDOW), omega);
    tonePower += fit.tonePower;
    residualPower += fit.residualPower;
    amplitudeSum += fit.amplitude;
    windows++;
  }
  const amplitude = windows ? amplitudeSum / windows : 0;
  const snrDb = 10 * Math.log10(tonePower / (residualPower + 1e-12));

  const dropouts = [];
  let zeroRun = 0;
  for (let n = 0; n < count; n++) {
    if (active[n] === 0) {
      zeroRun++;
    } else {
      if (zeroRun >= DROPOUT_SAMPLES) {
        dropouts.push({ atMs: ((n - zeroRun) / rate) * 1000, ms: (zeroRun / rate) * 1000 });
      }
      zeroRun = 0;
    }
  }

  const maxSlope = amplitude * omega;
  let clicks = 0;
  const clickDetail = [];
  for (let n = 1; n < count; n++) {
    const jump = Math.abs(active[n] - active[n - 1]);
    if (jump > CLICK_SLOPE_FACTOR * maxSlope) {
      clicks++;
      if (clickDetail.length < 8) {
        clickDetail.push(`${((n / rate) * 1000).toFixed(0)} ms Δ${jump.toFixed(3)}`);
      }
      if (process.env.CLICK_WAVEFORM && clickDetail.length <= 3) {
        console.log(`     around ${n}: ${Array.from(active.subarray(n - 10, n + 10)).map((v) => v.toFixed(3)).join(' ')}`);
      }
    }
  }

  return {
    leadingSilenceMs: (start / rate) * 1000,
    activeSeconds: count / rate,
    amplitude,
    snrDb,
    dropouts,
    clicks,
    clickDetail,
  };
}

try {
  const alpha = await openClient(environment, 'Alpha');
  const bravo = await openClient(environment, 'Bravo');
  await alpha.waitFor('mutter.client.users.size === 2');
  await alpha.eval('mutter.client.joinChannel(1)');
  await bravo.eval('mutter.client.joinChannel(1)');
  await alpha.waitFor('mutter.client.usersIn(1).length === 2');
  await bravo.eval(`mutter.settings.transmitMode = 'ptt'`);
  await alpha.eval(`mutter.audio.setNoiseSuppression('off')`);
  await alpha.eval(`mutter.settings.transmitMode = 'continuous'`);
  await alpha.waitFor('mutter.audio.isTransmitting', { label: 'Alpha transmitting' });
  await bravo.waitFor('mutter.audio.stats.packetsIn > 25', { label: 'Bravo receiving', timeout: 8000 });
  await bravo.waitFor('mutter.audio.stats.samplesOut > 960 * 10', { label: 'Bravo decoding' });

  let report = null;
  let stats = null;
  await step(`captured ${CAPTURE_MS} ms of Bravo's mixer output`, async () => {
    const encoded = await bravo.eval(`mutter.audio.captureOutput(${CAPTURE_MS}).then((samples) => {
      const bytes = new Uint8Array(samples.buffer);
      let text = '';
      for (let at = 0; at < bytes.length; at += 32768) {
        text += String.fromCharCode(...bytes.subarray(at, at + 32768));
      }
      return btoa(text);
    })`);
    await sleep(HEALTH_SETTLE_MS);
    stats = await bravo.eval('({ audio: mutter.audio.stats, stalls: mutter.client.stats.stalls, udp: mutter.client.stats.udp })');
    const bytes = Buffer.from(encoded, 'base64');
    const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    report = analyzeTone(samples, TONE_HZ, SAMPLE_RATE);
    if (!report) {
      throw new Error('mixer produced only silence');
    }
  });

  if (report) {
    const lane = stats.udp?.up ? 'UDP' : 'TCP';
    console.log(`     lane ${lane}, loss ${loss * 100}%, jitter ${jitterMs} ms`);
    console.log(`     tone ${TONE_HZ} Hz at ${report.amplitude.toFixed(3)}, SNR ${report.snrDb.toFixed(1)} dB over ${report.activeSeconds.toFixed(2)} s`);
    console.log(`     clicks ${report.clicks}, dropouts ${report.dropouts.length}${report.dropouts.length ? ` (${report.dropouts.map((d) => `${d.ms.toFixed(0)} ms at ${d.atMs.toFixed(0)} ms`).join(', ')})` : ''}`);
    console.log(`     packets in ${stats.audio.packetsIn}, concealed ${stats.audio.concealed}, underruns ${stats.audio.underruns}, delivery stalls ${stats.stalls}`);
    if (report.clicks) {
      console.log(`     first clicks: ${report.clickDetail.join(', ')}`);
    }
    check(report.snrDb > (impaired ? 6 : 20), `tone arrives clean (SNR ${report.snrDb.toFixed(1)} dB)`);
    check(report.clicks === 0, `no clicks in the output (${report.clicks})`);
    if (!impaired) {
      check(report.dropouts.length === 0, 'no dropouts once playback started');
      check(stats.audio.underruns === 0, 'no jitter-buffer underruns');
    }
  }
  if (!impaired) {
    await step('three short talk spurts end without underruns or buffer growth', async () => {
      const before = await bravo.eval('mutter.audio.stats.underruns');
      const bufferBefore = await bravo.eval('mutter.audio.stats.jitterMs');
      await alpha.eval(`mutter.settings.transmitMode = 'ptt'`);
      await alpha.waitFor('!mutter.audio.isTransmitting', { timeout: 3000 });
      for (let spurt = 0; spurt < 3; spurt++) {
        await alpha.eval('mutter.audio.setPTT(true)');
        await sleep(500);
        await alpha.eval('mutter.audio.setPTT(false)');
        await sleep(700);
      }
      await sleep(500);
      const after = await bravo.eval('mutter.audio.stats.underruns');
      if (after !== before) {
        throw new Error(`${after - before} underruns counted at the end of talk spurts`);
      }
      const bufferAfter = await bravo.eval('mutter.audio.stats.jitterMs');
      if (bufferAfter !== bufferBefore) {
        throw new Error(`playout buffer moved from ${bufferBefore} to ${bufferAfter} ms across quiet spurts`);
      }
    });
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
