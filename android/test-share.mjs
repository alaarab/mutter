import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeServer } from '../web/test/fake-server.mjs';
import { startBridge, launch } from '../web/test/browser.mjs';
import { openClient } from '../web/test/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await startFakeServer({ port: 64743 });
let bridge;
let browser;
try {
  bridge = await startBridge();
  browser = await launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const sender = await openClient({ server, bridge, browser }, 'DesktopSharer');
  await sender.eval(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d');
    let frame = 0;
    setInterval(() => {
      context.fillStyle = '#36445E'; context.fillRect(0, 0, 640, 360);
      context.fillStyle = '#EDF1F9'; context.font = '40px sans-serif';
      context.fillText('Mutter • Android ' + frame++, 30, 180);
    }, 33);
    return mutter.share.start({ stream: canvas.captureStream(30), contentHint: 'motion' });
  })()`);
  const env = { ...process.env };
  const jdk = '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home';
  if (!env.JAVA_HOME && fs.existsSync(jdk)) env.JAVA_HOME = jdk;
  const child = spawn(path.join(root, 'android/gradlew'), [
    '-p', 'android', ':app:connectedDebugAndroidTest',
    '-Pandroid.testInstrumentationRunnerArguments.class=com.alaarab.mutter.ShareInteropTest',
    '-Pandroid.testInstrumentationRunnerArguments.mumbleSharePort=64743',
  ], { cwd: root, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`Android screen-viewer test failed (${code})`);
  console.log('PASS: Android decoded live video from the shared desktop client.');
} finally {
  await browser?.close();
  await bridge?.close();
  await server.close();
}
