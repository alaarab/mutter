import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { inspectPeer } from '../bridge/peer-certificate.mjs';

test('CA validation also checks hostname and never overrides an existing pin', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-certificates-'));
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const cert = fs.readFileSync(certFile);
  const sockets = new Set();
  const server = tls.createServer({ key: fs.readFileSync(keyFile), cert }, socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const socket = tls.connect({ host: '127.0.0.1', port: server.address().port, servername: 'localhost', ca: cert });
  t.after(() => socket.destroy());
  await once(socket, 'secureConnect');
  assert.equal(socket.authorized, true);
  const verified = inspectPeer(socket, 'localhost');
  assert.equal(verified.trusted, true);
  assert.equal(inspectPeer(socket, 'wrong.example').trusted, false);
  assert.equal(inspectPeer(socket, 'localhost', '0'.repeat(64)).trusted, false);
  assert.equal(inspectPeer(socket, 'localhost', verified.fingerprint).trusted, true);
  socket.destroy();
});
