import assert from 'node:assert/strict';
import { MumbleClient } from '../app/client.js';

function populate(client, channelCount, userCount, seed = 1) {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  client.channels.set(0, { channelId: 0, name: 'Root' });
  for (let id = 1; id < channelCount; id++) {
    client.channels.set(id, { channelId: id, parent: Math.floor(random() * id), name: `Channel ${id}`, position: Math.floor(random() * 4) });
  }
  for (let session = 1; session <= userCount; session++) {
    client.users.set(session, { session, name: `User ${Math.floor(random() * 1000)}`, channelId: Math.floor(random() * channelCount) });
  }
}

function naiveSubtree(client, channelId) {
  let count = client.usersIn(channelId).length;
  for (const child of client.children(channelId)) {
    count += naiveSubtree(client, child.channelId);
  }
  return count;
}

const client = new MumbleClient();
populate(client, 300, 400, 7);
const roster = client.roster();
for (const channelId of client.channels.keys()) {
  assert.deepEqual(
    roster.children(channelId).map((channel) => channel.channelId),
    client.children(channelId).map((channel) => channel.channelId)
  );
  assert.deepEqual(
    roster.users(channelId).map((user) => user.session),
    client.usersIn(channelId).map((user) => user.session)
  );
  assert.equal(roster.subtreeCount(channelId), naiveSubtree(client, channelId));
}
assert.equal(roster.subtreeCount(0), 400);
console.log(' ok  the roster index matches the per-channel queries it replaces');

const looped = new MumbleClient();
looped.channels.set(0, { channelId: 0, name: 'Root', parent: 2 });
looped.channels.set(1, { channelId: 1, name: 'One', parent: 0 });
looped.channels.set(2, { channelId: 2, name: 'Two', parent: 1 });
looped.channels.set(3, { channelId: 3, name: 'Three', parent: 4 });
looped.channels.set(4, { channelId: 4, name: 'Four', parent: 3 });
looped.users.set(1, { session: 1, name: 'A', channelId: 2 });
looped.users.set(2, { session: 2, name: 'B', channelId: 4 });
const loopedRoster = looped.roster();
assert.ok(Number.isFinite(loopedRoster.subtreeCount(0)));
assert.ok(Number.isFinite(loopedRoster.subtreeCount(3)));
console.log(' ok  a server that sends a parent loop cannot hang the roster');

const large = new MumbleClient();
populate(large, 1000, 500, 3);
const begin = performance.now();
for (let run = 0; run < 10; run++) {
  large.roster();
}
const perRender = (performance.now() - begin) / 10;
assert.ok(perRender < 50, `roster took ${perRender.toFixed(1)} ms`);
console.log(` ok  1000 channels and 500 users index in ${perRender.toFixed(2)} ms`);

console.log('\nPASS');
