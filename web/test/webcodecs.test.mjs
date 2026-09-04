// Does this Chromium actually encode and decode Opus the way the voice path assumes?
// Answers the open question from the WIP: 20 ms frames in, one raw Opus packet per frame out,
// and AudioDecoder accepting those packets with no OpusHead description.
//
//   node web/test/webcodecs.test.mjs

import { launch, startBridge } from './browser.mjs';

const bridge = await startBridge();
const browser = await launch();
try {
  const page = await browser.newPage(bridge.url);
  const result = await page.eval(`(async () => {
    const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 40000, opus: { frameDuration: 20000, application: 'voip', signal: 'voice' } };
    const support = await AudioEncoder.isConfigSupported(cfg);
    if (!support.supported) return { supported: false };

    const chunks = [];
    const enc = new AudioEncoder({ output: c => { const b = new Uint8Array(c.byteLength); c.copyTo(b); chunks.push({ ts: c.timestamp, bytes: Array.from(b) }); }, error: e => { throw e; } });
    enc.configure(cfg);
    const FRAMES = 50, N = 960;
    let ts = 0;
    for (let f = 0; f < FRAMES; f++) {
      const pcm = new Float32Array(N);
      for (let i = 0; i < N; i++) pcm[i] = 0.5 * Math.sin(2 * Math.PI * 440 * (f * N + i) / 48000);
      enc.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: N, numberOfChannels: 1, timestamp: ts, data: pcm }));
      ts += 20000;
    }
    await enc.flush();

    // TOC byte: config (5 bits) | stereo (1) | frame-count code (2).
    const toc = chunks[0].bytes[0];
    const config = toc >> 3, code = toc & 3;
    const durations = [10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20];

    let decodedFrames = 0, energy = 0, outputs = 0;
    const dec = new AudioDecoder({ output: a => { outputs++; decodedFrames += a.numberOfFrames; const p = new Float32Array(a.numberOfFrames); a.copyTo(p, { planeIndex: 0, format: 'f32-planar' }); for (const v of p) energy += v * v; a.close(); }, error: e => { throw e; } });
    dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    for (const c of chunks) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: c.ts, data: new Uint8Array(c.bytes) }));
    await dec.flush();

    return {
      supported: true, chunks: chunks.length, avgBytes: Math.round(chunks.reduce((n, c) => n + c.bytes.length, 0) / chunks.length),
      toc, config, frameCountCode: code, frameMs: durations[config], decodedFrames, outputs,
      rms: Math.sqrt(energy / decodedFrames).toFixed(3), firstTimestamps: chunks.slice(0, 3).map(c => c.ts),
    };
  })()`);

  console.log(JSON.stringify(result, null, 2));
  const problems = [];
  if (!result.supported) problems.push('opus AudioEncoder not supported');
  else {
    // flush() may add one trailing packet for the encoder's lookahead; the live path never flushes.
    if (result.chunks < 50 || result.chunks > 51) problems.push(`expected 50 (or 51 after flush) packets, got ${result.chunks}`);
    if (result.frameMs !== 20) problems.push(`packets are ${result.frameMs} ms, not 20`);
    if (result.frameCountCode !== 0) problems.push(`packet holds multiple frames (code ${result.frameCountCode})`);
    if (result.decodedFrames !== result.chunks * 960) problems.push(`decoded ${result.decodedFrames} samples, expected ${result.chunks * 960}`);
    if (Number(result.rms) < 0.25) problems.push(`decoded signal too quiet (rms ${result.rms}; input was 0.354)`);
  }
  for (const e of page.errors()) problems.push(e);
  if (problems.length) { console.error('FAIL\n  ' + problems.join('\n  ')); process.exitCode = 1; }
  else console.log('PASS: WebCodecs Opus round-trip is what the voice path assumes');
} finally {
  await browser.close();
  bridge.close();
}
