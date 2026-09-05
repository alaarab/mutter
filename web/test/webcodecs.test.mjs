import { launch, startBridge } from './browser.mjs';

const EXPECTED_PACKETS = 50;
const FRAME_SAMPLES = 960;
const EXPECTED_FRAME_MS = 20;
const MIN_RMS = 0.25;

const bridge = await startBridge();
const browser = await launch();
try {
  const page = await browser.newPage(bridge.url);
  const result = await page.eval(`(async () => {
    const config = {
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 40000,
      opus: { frameDuration: 20000, application: 'voip', signal: 'voice' },
    };
    const support = await AudioEncoder.isConfigSupported(config);
    if (!support.supported) return { supported: false };

    const chunks = [];
    const encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        chunks.push({ ts: chunk.timestamp, bytes: Array.from(bytes) });
      },
      error: (error) => { throw error; },
    });
    encoder.configure(config);
    const FRAMES = ${EXPECTED_PACKETS};
    const N = ${FRAME_SAMPLES};
    let timestamp = 0;
    for (let frame = 0; frame < FRAMES; frame++) {
      const pcm = new Float32Array(N);
      for (let i = 0; i < N; i++) pcm[i] = 0.5 * Math.sin(2 * Math.PI * 440 * (frame * N + i) / 48000);
      encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: N, numberOfChannels: 1, timestamp, data: pcm }));
      timestamp += 20000;
    }
    await encoder.flush();

    const toc = chunks[0].bytes[0];
    const configNumber = toc >> 3;
    const frameCountCode = toc & 3;
    const durations = [10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20];

    let decodedFrames = 0;
    let energy = 0;
    let outputs = 0;
    const decoder = new AudioDecoder({
      output: (audio) => {
        outputs++;
        decodedFrames += audio.numberOfFrames;
        const pcm = new Float32Array(audio.numberOfFrames);
        audio.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
        for (const value of pcm) energy += value * value;
        audio.close();
      },
      error: (error) => { throw error; },
    });
    decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    for (const chunk of chunks) {
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: chunk.ts, data: new Uint8Array(chunk.bytes) }));
    }
    await decoder.flush();

    return {
      supported: true,
      chunks: chunks.length,
      avgBytes: Math.round(chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0) / chunks.length),
      toc,
      config: configNumber,
      frameCountCode,
      frameMs: durations[configNumber],
      decodedFrames,
      outputs,
      rms: Math.sqrt(energy / decodedFrames).toFixed(3),
      firstTimestamps: chunks.slice(0, 3).map((chunk) => chunk.ts),
    };
  })()`);

  console.log(JSON.stringify(result, null, 2));
  const problems = [];
  if (!result.supported) {
    problems.push('opus AudioEncoder not supported');
  } else {
    if (result.chunks < EXPECTED_PACKETS || result.chunks > EXPECTED_PACKETS + 1) {
      problems.push(`expected ${EXPECTED_PACKETS} (or ${EXPECTED_PACKETS + 1} after flush) packets, got ${result.chunks}`);
    }
    if (result.frameMs !== EXPECTED_FRAME_MS) {
      problems.push(`packets are ${result.frameMs} ms, not ${EXPECTED_FRAME_MS}`);
    }
    if (result.frameCountCode !== 0) {
      problems.push(`packet holds multiple frames (code ${result.frameCountCode})`);
    }
    if (result.decodedFrames !== result.chunks * FRAME_SAMPLES) {
      problems.push(`decoded ${result.decodedFrames} samples, expected ${result.chunks * FRAME_SAMPLES}`);
    }
    if (Number(result.rms) < MIN_RMS) {
      problems.push(`decoded signal too quiet (rms ${result.rms}; input was 0.354)`);
    }
  }
  problems.push(...page.errors());
  if (problems.length) {
    console.error(`FAIL\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS: WebCodecs Opus round-trip is what the voice path assumes');
  }
} finally {
  await browser.close();
  bridge.close();
}
