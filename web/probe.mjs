// Connects straight to a Mumble server over TLS and completes the handshake, proving the
// protocol port works before any browser or bridge code is involved.
// Usage: node web/probe.mjs <host> [port] [username]

import tls from 'node:tls';
import { FrameParser, MessageType, TypeName, decode, versionMessage, authenticateMessage, pingMessage, REJECT_REASONS } from './src/mumble.js';

const host = process.argv[2] ?? 'minowick.com';
const port = Number(process.argv[3] ?? 64738);
const username = process.argv[4] ?? 'MutterWeb';

const channels = new Map(), users = new Map();
let mySession = null;

const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
  console.log(`TLS up: ${host}:${port} (${socket.getProtocol()})`);
  socket.write(versionMessage({ v1: (1 << 16) | (5 << 8), v2: (1n << 48n) | (5n << 32n), release: 'Mutter Web', os: 'Web', osVersion: '1' }));
  socket.write(authenticateMessage({ username }));
});

const parser = new FrameParser();
socket.on('data', chunk => {
  for (const f of parser.push(new Uint8Array(chunk))) {
    if (f.type === MessageType.udpTunnel) continue;           // voice, ignored here
    const m = decode(f.type, f.payload);
    switch (f.type) {
      case MessageType.version:
        console.log(`server: ${m.release} on ${m.os ?? '?'}`); break;
      case MessageType.reject:
        console.log(`REJECTED: ${REJECT_REASONS[m.type] ?? m.type} — ${m.reason ?? ''}`);
        socket.end(); break;
      case MessageType.channelState:
        channels.set(m.channelId, { ...channels.get(m.channelId), ...m }); break;
      case MessageType.userState:
        users.set(m.session, { ...users.get(m.session), ...m }); break;
      case MessageType.userRemove:
        users.delete(m.session); break;
      case MessageType.serverSync:
        mySession = m.session;
        console.log(`\nSYNCED as session ${mySession}`);
        if (m.welcomeText) console.log('welcome:', m.welcomeText.replace(/<[^>]+>/g, '').trim().slice(0, 90));
        console.log(`\nChannels (${channels.size}):`);
        for (const c of channels.values()) console.log(`  #${c.channelId} ${c.name}${c.parent !== undefined ? ` (parent ${c.parent})` : ''}`);
        console.log(`\nUsers (${users.size}):`);
        for (const u of users.values()) console.log(`  [${u.session}] ${u.name} in channel ${u.channelId ?? 0}${u.session === mySession ? '  <- me' : ''}`);
        console.log('\nprotocol port works. disconnecting.');
        setTimeout(() => socket.end(), 400);
        break;
      case MessageType.permissionDenied:
        console.log('permission denied:', m.reason ?? m.type); break;
    }
  }
});

setInterval(() => { if (mySession) socket.write(pingMessage(Date.now() * 1000)); }, 5000).unref();
socket.on('error', e => { console.error('socket error:', e.message); process.exit(1); });
socket.on('close', () => process.exit(0));
setTimeout(() => { console.error('timed out'); process.exit(1); }, 20000).unref();
