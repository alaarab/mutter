import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('Electron protects passwords with OS storage across launches', { timeout: 90_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-secure-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const electron = createRequire(import.meta.url)('electron');
  async function launch(phase) {
    const env = { ...process.env, PORT: String(port), PORTABLE_EXECUTABLE_DIR: directory, MUTTER_CREDENTIAL_PHASE: phase };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [fileURLToPath(new URL('credential-probe.mjs', import.meta.url))], { env });
    t.after(() => child.kill());
    const timeout = setTimeout(() => child.kill('SIGKILL'), 40_000);
    let output = '';
    child.stdout.on('data', bytes => output += bytes);
    child.stderr.on('data', bytes => output += bytes);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    clearTimeout(timeout);
    assert.equal(code, 0, output);
    return output;
  }
  if ((await launch('write')).includes('UNAVAILABLE:')) {
    assert.ok(!fs.existsSync(path.join(directory, 'data/credentials.enc')));
    t.skip('OS secure storage unavailable; verified no plaintext fallback');
    return;
  }
  const encrypted = fs.readFileSync(path.join(directory, 'data/credentials.enc'));
  assert.ok(!encrypted.includes('private-server-fixture'));
  assert.ok(!encrypted.includes('private-turn-fixture'));
  assert.match(await launch('read'), /PASS: OS-encrypted credentials and IPC isolation/);
});
