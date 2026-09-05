import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startFakeServer } from './fake-server.mjs';
import { launch, startBridge } from './browser.mjs';

export { sleep };

export async function startEnvironment({ chromeArgs = [] } = {}) {
  const server = await startFakeServer({ port: 0, quiet: !process.env.VERBOSE });
  const bridge = await startBridge();
  const browser = await launch({ args: chromeArgs });
  const shots = process.env.SHOTS;
  if (shots) {
    fs.mkdirSync(shots, { recursive: true });
  }
  return {
    server,
    bridge,
    browser,
    shots,
    async close() {
      await browser.close();
      bridge.close();
      await server.close();
    },
  };
}

export function createReporter() {
  const failures = [];
  const check = (condition, label) => {
    console.log(`${condition ? ' ok ' : 'FAIL'} ${label}`);
    if (!condition) {
      failures.push(label);
    }
  };
  const step = async (label, run) => {
    try {
      await run();
      check(true, label);
    } catch (error) {
      check(false, `${label} — ${error.message}`);
    }
  };
  const checkNoPageErrors = (pages) => {
    for (const [name, page] of pages) {
      const errors = page.errors();
      const detail = errors.length ? `\n      ${errors.join('\n      ')}` : '';
      check(errors.length === 0, `${name}: no page exceptions${detail}`);
    }
  };
  const finish = () => {
    if (failures.length) {
      console.error(`\n${failures.length} failure(s)`);
      process.exit(1);
    }
    console.log('\nPASS');
  };
  return { check, step, checkNoPageErrors, finish };
}

export async function openClient(environment, name, { beforeConnect } = {}) {
  const page = await environment.browser.newPage(`${environment.bridge.url}/?source=tone`);
  await page.type('#host', '127.0.0.1');
  await page.type('#port', String(environment.server.port));
  await page.type('#username', name);
  await beforeConnect?.(page);
  await page.click('#connectBtn');
  await page.waitFor(`mutter.client.state === 'connected'`, { label: `${name} connected` });
  return page;
}

export function findUser(name) {
  return `[...mutter.client.users.values()].find(u => u.name === ${JSON.stringify(name)})`;
}
