import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeServer } from '../web/test/fake-server.mjs';
import { startBridge, launch } from '../web/test/browser.mjs';
import { openClient } from '../web/test/harness.mjs';

const PORT = 64744;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await startFakeServer({ port: PORT });
let bridge;
let browser;
let gradle;
try {
  bridge = await startBridge();
  browser = await launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const viewer = await openClient({ server, bridge, browser }, 'DesktopViewer');
  const env = { ...process.env };
  const jdk = '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
  if (!env.JAVA_HOME && fs.existsSync(jdk)) env.JAVA_HOME = jdk;
  gradle = spawn(path.join(root, 'android/gradlew'), [
    '-p', 'android', ':app:connectedDebugAndroidTest',
    '-Pandroid.testInstrumentationRunnerArguments.class=com.alaarab.mutter.PhoneShareInteropTest',
    `-Pandroid.testInstrumentationRunnerArguments.mumblePhoneSharePort=${PORT}`,
  ], { cwd: root, env, stdio: 'inherit' });
  const finished = new Promise((resolve, reject) => {
    gradle.once('error', reject);
    gradle.once('exit', resolve);
  });
  await viewer.waitFor('mutter.share.available.size === 1', { timeout: 240000, label: 'the Android share is announced' });
  const title = await viewer.eval('[...mutter.share.available.values()][0].title');
  if (title !== 'Phone screen') throw new Error(`Unexpected share title ${title}`);
  await viewer.eval('mutter.share.watch([...mutter.share.available.keys()][0])');
  await viewer.waitFor(
    `(() => { const video = document.querySelector('#stage video'); return !!video && video.videoWidth === 640 && video.getVideoPlaybackQuality().totalVideoFrames > 10; })()`,
    { timeout: 60000, label: 'the desktop client decodes the Android screen' },
  );
  const frames = await viewer.eval(`document.querySelector('#stage video').getVideoPlaybackQuality().totalVideoFrames`);
  await viewer.eval('mutter.share.unwatch()');
  const code = await finished;
  if (code !== 0) throw new Error(`Android screen-sharer test failed (${code})`);
  console.log(`PASS: the desktop client decoded ${frames} frames of a 640-wide Android screen share.`);
} finally {
  if (gradle && gradle.exitCode === null) gradle.kill();
  await browser?.close();
  await bridge?.close();
  await server.close();
}
