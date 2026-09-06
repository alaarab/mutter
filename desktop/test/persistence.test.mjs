import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const electron = createRequire(import.meta.url)('electron');
const desktop = fileURLToPath(new URL('../', import.meta.url));

test('desktop retains localStorage across two default-port launches', { timeout: 100_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-desktop-persistence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = `persist-${Date.now()}`;
  const env = { ...process.env, PORTABLE_EXECUTABLE_DIR: directory, MUTTER_SMOKE_STORAGE: marker };
  delete env.PORT;
  delete env.ELECTRON_RUN_AS_NODE;
  async function launch() {
    const child = spawn(electron, ['.', '--smoke'], { cwd: desktop, env });
    t.after(() => child.kill());
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => output += chunk);
    child.stderr.on('data', chunk => errors += chunk);
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    clearTimeout(timeout);
    assert.equal(code, 0, `${output}\n${errors}`);
    assert.match(output, /smoke: bridge up at http:\/\/localhost:8789/);
    assert.match(output, /brand mark present/);
    return output;
  }
  assert.match(await launch(), /smoke: previous storage null/);
  assert.ok((await launch()).includes(`smoke: previous storage ${JSON.stringify(marker)}`));
});
