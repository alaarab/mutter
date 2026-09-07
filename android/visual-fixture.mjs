import { frame, MessageType, textMessage } from '../web/src/mumble.js';
import { Writer } from '../web/src/protobuf.js';

export function populateVisualFixture(server) {
  server.channels.get(0).name = 'The living room';
  server.channels.get(0).description = 'Good company, wherever the day takes you.';
  server.channels.get(1).description = 'A quieter corner for a smaller conversation.';
  const people = [
    { session: 100, name: 'Alex Morgan', channelId: 0, comment: 'Usually here for good music and better company.' },
    { session: 101, name: 'Jordan Lee', channelId: 0, selfMute: true },
    { session: 102, name: 'Sam Rivera', channelId: 0, selfDeaf: true },
    { session: 103, name: 'Taylor Chen', channelId: 1 },
    { session: 104, name: 'Avery with a wonderfully long name', channelId: 1, mute: true },
  ];
  for (const person of people) {
    server.users.set(person.session, {
      ...person,
      synced: true,
      since: Date.now(),
      socket: { destroyed: true },
      crypt: { decrypt: () => null },
    });
    server.nextSession = Math.max(server.nextSession, person.session + 1);
  }
  server.on('connect', ({ session }) => {
    const user = server.users.get(session);
    server.sendTo(user, frame(MessageType.userState, new Writer().uint(1, 100).uint(4, 7).bool(18, true).finish()));
    server.sendTo(user, textMessage({ actor: 100, channelIds: [0], html: 'Made it home. Anyone around for a catch-up?' }));
    server.sendTo(user, textMessage({ actor: 101, channelIds: [0], html: 'Just putting the kettle on ☕' }));
    server.sendTo(user, textMessage({ actor: 101, channelIds: [0], html: 'Give me two minutes and I’m all ears.' }));
  });
}
