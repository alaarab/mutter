import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contextMenuItems } from '../context-menu.js';

const flags = { canCut: false, canCopy: true, canPaste: true, canSelectAll: true };

test('selected chat text offers Copy', () => {
  const items = contextMenuItems({ isEditable: false, selectionText: 'see you at nine', editFlags: flags });
  assert.deepEqual(items.map((item) => item.role), ['copy']);
});

test('text fields get the edit actions the field allows', () => {
  const items = contextMenuItems({ isEditable: true, selectionText: '', editFlags: flags });
  assert.deepEqual(items.filter((item) => item.role).map((item) => [item.role, item.enabled]),
    [['cut', false], ['copy', true], ['paste', true], ['selectAll', true]]);
});

test('nothing selected outside a text field shows no menu', () => {
  for (const selectionText of ['', '  \n']) {
    assert.deepEqual(contextMenuItems({ isEditable: false, selectionText, editFlags: flags }), []);
  }
});
