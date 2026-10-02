import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { after, test } from 'node:test';
import { startFakeServer } from './fake-server.mjs';

test('native ICE candidates follow SDP and stop with their peer', { skip: spawnSync('swiftc', ['--version']).status !== 0 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-ice-tests-'));
  try {
    const output = path.join(temporary, 'ice');
    execFileSync('swiftc', ['-parse-as-library',
      fileURLToPath(new URL('native/ICECandidateProbe.swift', import.meta.url)),
      fileURLToPath(new URL('../../Mutter/ScreenShare/ICECandidateBatcher.swift', import.meta.url)),
      '-o', output], { stdio: 'pipe' });
    assert.match(execFileSync(output, { encoding: 'utf8' }), /PASS/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

if (process.platform !== 'darwin') {
  test('native transport and audio regressions (requires macOS)', { skip: true }, () => {});
} else {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-native-tests-'));
  after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const packageArgs = ['--package-path', path.join(root, 'Packages/MumbleCore'), '--scratch-path', path.join(temporary, 'build')];
  execFileSync('swift', ['build', ...packageArgs], { stdio: 'pipe' });
  const bin = execFileSync('swift', ['build', ...packageArgs, '--show-bin-path'], { encoding: 'utf8' }).trim();
  const objects = module => {
    const perFileDirectory = path.join(bin, `${module}.build`);
    if (fs.existsSync(perFileDirectory)) {
      return fs.readdirSync(perFileDirectory)
        .filter(name => name.endsWith('.swift.o')).map(name => path.join(perFileDirectory, name));
    }
    return [path.join(bin, `${module}.o`)];
  };
  const moduleSearchPaths = [path.join(bin, 'Modules'), bin].filter(directory => fs.existsSync(directory))
    .flatMap(directory => ['-I', directory]);
  const protocolObjects = objects('MumbleProtocol');
  const compile = (name, extra) => {
    const output = path.join(temporary, name);
    execFileSync('swiftc', ['-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
      ...moduleSearchPaths, path.join(root, `web/test/native/${name}.swift`), ...extra, ...protocolObjects, '-o', output], { stdio: 'pipe' });
    return output;
  };
  const audio = compile('AudioProbe', [path.join(root, 'Mutter/Audio/UserStream.swift')]);
  const liveActivity = compile('LiveActivityProbe', [path.join(root, 'Mutter/LiveActivity/LiveActivityFreshness.swift')]);
  const client = compile('ClientProbe', objects('MumbleClient'));
  const signal = compile('SignalProbe', [path.join(root, 'Mutter/ScreenShare/RTCSignaling.swift'),
    path.join(root, 'Mutter/ScreenShare/ICECandidateBatcher.swift'), ...objects('MumbleClient')]);
  const credentials = compile('CredentialProbe', [path.join(root, 'Mutter/App/ServerStore.swift'), ...objects('MumbleClient')]);
  const broadcast = compile('BroadcastProbe', [path.join(root, 'Mutter/ScreenShare/BroadcastFrames.swift')]);

  test('native credentials migrate without plaintext persistence or loss on storage failure', () => {
    assert.match(execFileSync(credentials, { encoding: 'utf8' }), /PASS/);
  });

  test('native screen-sharing messages reject malformed packets and resource exhaustion', () => {
    assert.match(execFileSync(signal, { encoding: 'utf8' }), /PASS/);
  });

  test('native screen broadcast frames, capture size and watch limits', () => {
    assert.match(execFileSync(broadcast, { encoding: 'utf8' }), /PASS/);
  });

  test('native playout inserts exactly the missing audio duration', () => {
    assert.match(execFileSync(audio, { encoding: 'utf8' }), /PASS/);
  });

  test('native Live Activity stays fresh while live and goes stale soon after updates stop', () => {
    assert.match(execFileSync(liveActivity, { encoding: 'utf8' }), /PASS/);
  });

  for (const scenario of ['recovery', 'username', 'mute', 'roster', 'retry', 'cancel', 'no-retry']) {
    test(`native reconnect: ${scenario}`, { timeout: 30_000 }, async t => {
      let server = await startFakeServer({ port: 0, quiet: true });
      const port = server.port;
      const child = spawn(client, [String(port), scenario]);
      let output = '';
      let errors = '';
      let stopped = false;
      let operations = Promise.resolve();
      child.stderr.on('data', chunk => errors += chunk);
      child.stdout.on('data', chunk => {
        const text = chunk.toString();
        output += text;
        operations = operations.then(async () => {
          if (text.includes('CONNECTED') && !stopped) {
            stopped = true;
            if (scenario === 'username') {
              const authenticate = server.authenticate.bind(server);
              let rejections = 0;
              server.authenticate = (user, message) => {
                if (rejections++ < 2) server.reject(user, 5, 'Username is still in use');
                else authenticate(user, message);
              };
              for (const user of server.users.values()) user.socket.destroy();
            } else if (scenario === 'mute' || scenario === 'roster' || scenario === 'retry') {
              for (const user of server.users.values()) user.socket.destroy();
            } else {
              await server.close();
              server = null;
            }
          }
          if (scenario === 'recovery' && text.includes('reconnecting(attempt: 2)') && !server) {
            server = await startFakeServer({ port, quiet: true });
          }
        });
      });
      t.after(async () => { child.kill(); await operations; await server?.close(); });
      const [code] = await once(child, 'exit');
      await operations;
      assert.equal(code, 0, `${output}\n${errors}`);
      assert.match(output, /PASS/);
    });
  }
}
