import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { test } from 'node:test';

function preload() {
  const ipc = new EventEmitter();
  const sent = [];
  ipc.send = (...args) => sent.push(args);
  let picker;
  vm.runInNewContext(fs.readFileSync(new URL('../picker-preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({
      ipcRenderer: ipc,
      contextBridge: { exposeInMainWorld: (_name, api) => { picker = api; } },
    }),
  });
  return { ipc, picker, sent };
}

test('picker setup survives arriving before its renderer subscribes', () => {
  const { ipc, picker } = preload();
  const setup = { sources: [{ id: 'screen:1:0', name: 'Test display' }], theme: 'plum' };
  ipc.emit('picker:setup', {}, setup);
  const received = [];
  picker.onSetup(value => received.push(value));
  assert.deepEqual(received, [setup]);
});

test('picker receives later setup and sends only the chosen source ID', () => {
  const { ipc, picker, sent } = preload();
  const received = [];
  picker.onSetup(value => received.push(value));
  const setup = { sources: [{ id: 'window:42:0' }] };
  ipc.emit('picker:setup', { privileged: true }, setup);
  assert.deepEqual(received, [setup]);
  picker.choose('window:42:0');
  assert.deepEqual(sent, [['picker:choose', 'window:42:0']]);
});
