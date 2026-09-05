import tls from 'node:tls';
import {
  DEFAULT_PORT,
  CLIENT_VERSION,
  FrameParser,
  MessageType,
  decode,
  versionMessage,
  authenticateMessage,
  pingMessage,
  REJECT_REASONS,
} from './src/mumble.js';

const host = process.argv[2] ?? 'minowick.com';
const port = Number(process.argv[3] ?? DEFAULT_PORT);
const username = process.argv[4] ?? 'MutterWeb';

const channels = new Map();
const users = new Map();
let mySession = null;

const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
  console.log(`TLS up: ${host}:${port} (${socket.getProtocol()})`);
  socket.write(versionMessage({ ...CLIENT_VERSION, release: 'Mutter Web', os: 'Web', osVersion: '1' }));
  socket.write(authenticateMessage({ username }));
});

function printRoster() {
  console.log(`\nChannels (${channels.size}):`);
  for (const channel of channels.values()) {
    const parent = channel.parent !== undefined ? ` (parent ${channel.parent})` : '';
    console.log(`  #${channel.channelId} ${channel.name}${parent}`);
  }
  console.log(`\nUsers (${users.size}):`);
  for (const user of users.values()) {
    const marker = user.session === mySession ? '  <- me' : '';
    console.log(`  [${user.session}] ${user.name} in channel ${user.channelId ?? 0}${marker}`);
  }
}

function handle(type, message) {
  switch (type) {
    case MessageType.version:
      console.log(`server: ${message.release} on ${message.os ?? '?'}`);
      break;
    case MessageType.reject:
      console.log(`REJECTED: ${REJECT_REASONS[message.type] ?? message.type} — ${message.reason ?? ''}`);
      socket.end();
      break;
    case MessageType.channelState:
      channels.set(message.channelId, { ...channels.get(message.channelId), ...message });
      break;
    case MessageType.userState:
      users.set(message.session, { ...users.get(message.session), ...message });
      break;
    case MessageType.userRemove:
      users.delete(message.session);
      break;
    case MessageType.serverSync:
      mySession = message.session;
      console.log(`\nSYNCED as session ${mySession}`);
      if (message.welcomeText) {
        console.log('welcome:', message.welcomeText.replace(/<[^>]+>/g, '').trim().slice(0, 90));
      }
      printRoster();
      console.log('\nprotocol port works. disconnecting.');
      setTimeout(() => socket.end(), 400);
      break;
    case MessageType.permissionDenied:
      console.log('permission denied:', message.reason ?? message.type);
      break;
    default:
      break;
  }
}

const parser = new FrameParser();
socket.on('data', (chunk) => {
  for (const { type, payload } of parser.push(new Uint8Array(chunk))) {
    if (type !== MessageType.udpTunnel) {
      handle(type, decode(type, payload));
    }
  }
});

setInterval(() => {
  if (mySession) {
    socket.write(pingMessage(Date.now() * 1000));
  }
}, 5000).unref();
socket.on('error', (error) => {
  console.error('socket error:', error.message);
  process.exit(1);
});
socket.on('close', () => process.exit(0));
setTimeout(() => {
  console.error('timed out');
  process.exit(1);
}, 20000).unref();
