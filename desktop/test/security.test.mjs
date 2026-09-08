import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowsPermission, isAppURL, isExternalURL } from '../security.js';

const appURL = 'http://localhost:8789';

test('navigation requires the exact app origin and entry point', () => {
  for (const target of [appURL, `${appURL}/?source=tone`, `${appURL}/app/index.html#chat`]) {
    assert.equal(isAppURL(target, appURL), true);
  }
  for (const target of ['http://localhost:87890', 'http://localhost:8789@attacker.example',
    `${appURL}/app/picker.html`, `${appURL}/bridge/server.mjs`, 'https://attacker.example', 'file:///tmp/example.html']) {
    assert.equal(isAppURL(target, appURL), false, target);
  }
});

test('external links cannot launch local files or arbitrary protocol handlers', () => {
  for (const target of ['https://example.com/path', 'http://example.com', 'mailto:hello@example.com']) {
    assert.equal(isExternalURL(target), true);
  }
  for (const target of ['file:///Applications/Calculator.app', 'javascript:alert(1)', 'data:text/html,hello',
    'smb://server/share', 'ms-msdt:/id', 'https://username:password@example.com', 'invalid']) {
    assert.equal(isExternalURL(target), false, target);
  }
});

test('device permissions are limited to the app main frame', () => {
  assert.equal(allowsPermission('media', appURL, appURL, appURL), true);
  assert.equal(allowsPermission('display-capture', appURL, appURL, appURL), true);
  assert.equal(allowsPermission('media', 'https://attacker.example', appURL, appURL), false);
  assert.equal(allowsPermission('media', appURL, 'https://attacker.example', appURL), false);
  assert.equal(allowsPermission('media', appURL, appURL, appURL, false), false);
  assert.equal(allowsPermission('openExternal', appURL, appURL, appURL), false);
  assert.equal(allowsPermission('clipboard-read', appURL, appURL, appURL), false);
});
