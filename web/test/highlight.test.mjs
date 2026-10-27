import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { highlight } from '../app/highlight.js';

// The iOS highlighter is checked against the same cases, so both apps colour
// the same code the same way.
const cases = JSON.parse(readFileSync(new URL('./fixtures/highlight.json', import.meta.url), 'utf8'));

for (const { name, code, lang, language, detected, tokens } of cases) {
  test(`highlight: ${name}`, () => {
    const result = highlight(code, lang);
    assert.deepEqual(result, { language, detected, tokens });
    assert.equal(result.tokens.map(([, text]) => text).join(''), code, 'the runs spell out the code exactly');
  });
}

test('long scripts and hostile input stay fast', () => {
  const script = Array.from({ length: 3000 }, (_, line) => `if [ "$x" -gt ${line} ]; then echo 'n' "\${HOME}" # ${line}; fi`).join('\n');
  const inputs = [
    [script, 'bash'],
    [script, null],
    ["'".repeat(50_000) + '"'.repeat(50_000), 'js'],
    ['/*'.repeat(40_000), 'c'],
    ['<a b="'.repeat(20_000), 'html'],
    ['{' + ' a'.repeat(50_000), 'css'],
    ['"\\'.repeat(50_000), 'py'],
    ['x'.repeat(100_000), 'sql'],
  ];
  for (const [code, lang] of inputs) {
    const started = performance.now();
    const { tokens } = highlight(code, lang);
    assert.ok(performance.now() - started < 500, `${lang} took too long`);
    assert.equal(tokens.map(([, text]) => text).join(''), code);
  }
});
