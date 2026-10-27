import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { markdownToHtml } from '../app/markdown.js';

const cases = JSON.parse(readFileSync(new URL('./fixtures/markdown.json', import.meta.url), 'utf8'));

for (const { name, markdown, html } of cases) {
  test(`markdown: ${name}`, () => {
    assert.equal(markdownToHtml(markdown), html);
  });
}
