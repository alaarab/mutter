import { startFakeServer } from '../web/test/fake-server.mjs';
import net from 'node:net';
import { populateVisualFixture } from './visual-fixture.mjs';

const servers = [];
const authenticationAttempts = new Map();
const voiceTransport = new Map();
const voicePackets = new Map();
let blockUdp = false;
for (const options of [
  { port: 64746, udp: false },
  { port: 64740 },
  { port: 64741, version: '1.4.287' },
  { port: 64742, udp: false },
  { port: 64745, password: 'android-test-password', udp: false },
]) {
  const server = await startFakeServer(options);
  if (options.port === 64746) populateVisualFixture(server);
  const authenticate = server.authenticate.bind(server);
  server.authenticate = (user, message) => {
    authenticationAttempts.set(message.username, (authenticationAttempts.get(message.username) ?? 0) + 1);
    authenticate(user, message);
  };
  const receive = server.onDatagram.bind(server);
  server.onDatagram = (...args) => { if (!blockUdp) receive(...args); };
  server.on('voice', ({ session, via, isTerminator }) => {
    const name = server.users.get(session)?.name;
    voiceTransport.set(name, via);
    if (!isTerminator) voicePackets.set(name, (voicePackets.get(name) ?? 0) + 1);
  });
  servers.push(server);
}


const control = net.createServer((socket) => {
  socket.setTimeout(5000, () => socket.destroy());
  let input = '';
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    input += chunk.toString();
    if (input.length > 1024) { socket.destroy(); return; }
    if (!input.includes('\n')) return;
    try {
      const command = JSON.parse(input.split('\n')[0]);
      switch (command.action) {
        case 'drop':
          for (const server of servers) {
            for (const user of server.users.values()) {
              if (user.name === command.name) user.socket.destroy();
            }
          }
          break;
        case 'udp': blockUdp = command.blocked === true; break;
        case 'stats': break;
        default: throw new Error('Unknown test command');
      }
      socket.end(JSON.stringify({
        ok: true,
        authentications: authenticationAttempts.get(command.name) ?? 0,
        voiceTransport: voiceTransport.get(command.name) ?? null,
        voicePackets: voicePackets.get(command.name) ?? 0,
      }) + '\n');
    } catch (error) {
      socket.end(JSON.stringify({ ok: false, error: error.message }) + '\n');
    }
  });
});
await new Promise((resolve, reject) => {
  control.once('error', reject);
  control.listen(64744, '127.0.0.1', resolve);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    control.close();
    await Promise.all(servers.map((server) => server.close()));
    process.exit(0);
  });
}
console.log('Android test servers ready: 64740 (modern UDP), 64741 (legacy UDP), 64742 (TCP), 64745 (password), 64744 (fault injection), 64746 (visual review).');
