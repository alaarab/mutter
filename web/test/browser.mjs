import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_PORT_BASE = 8800;
const BRIDGE_PORT_SPREAD = 400;
const DEBUG_PORT_BASE = 9300;
const DEBUG_PORT_SPREAD = 600;
const STARTUP_ATTEMPTS = 100;
const STARTUP_POLL_MS = 100;
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };

function randomPort(base, spread) {
  return base + Math.floor(Math.random() * spread);
}

export async function startBridge({ verbose = !!process.env.VERBOSE } = {}) {
  const port = randomPort(BRIDGE_PORT_BASE, BRIDGE_PORT_SPREAD);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'server.mjs');
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PORT: String(port), NO_OPEN: '1' },
    stdio: ['ignore', verbose ? 'inherit' : 'ignore', 'inherit'],
  });
  const url = `http://localhost:${port}`;
  for (let attempt = 0; attempt < STARTUP_ATTEMPTS / 2; attempt++) {
    try {
      await fetch(`${url}/`);
      return { port, url, proc: child, close: () => child.kill() };
    } catch {
      await sleep(STARTUP_POLL_MS);
    }
  }
  child.kill();
  throw new Error('bridge did not start');
}

export async function launch({ fakeMedia = true, args: extraArgs = [], verbose = !!process.env.VERBOSE } = {}) {
  const binary = process.env.CHROME ?? 'chromium';
  const debugPort = randomPort(DEBUG_PORT_BASE, DEBUG_PORT_SPREAD);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required',
    '--enable-features=WebCodecs',
    ...(fakeMedia ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', verbose ? 'inherit' : 'ignore'] });
  let version = null;
  for (let attempt = 0; attempt < STARTUP_ATTEMPTS && !version; attempt++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    } catch {
      await sleep(STARTUP_POLL_MS);
    }
  }
  if (!version) {
    child.kill();
    throw new Error('Chromium did not start');
  }
  const devtools = new DevToolsConnection(version.webSocketDebuggerUrl);
  await devtools.ready;
  return new Browser(devtools, child, profile, verbose);
}

class Browser {
  constructor(devtools, child, profile, verbose) {
    this.devtools = devtools;
    this.child = child;
    this.profile = profile;
    this.verbose = verbose;
  }

  async newPage(url) {
    const { targetId } = await this.devtools.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.devtools.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
    if (url) {
      await page.goto(url);
    }
    return page;
  }

  async close() {
    try {
      await Promise.race([this.devtools.send('Browser.close'), sleep(1500)]);
    } catch {}
    this.child.kill('SIGKILL');
    try {
      this.devtools.socket.close();
    } catch {}
    fs.rmSync(this.profile, { recursive: true, force: true });
  }
}

class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.logs = [];
    browser.devtools.on('Runtime.consoleAPICalled', (params, session) => {
      if (session !== sessionId) {
        return;
      }
      const text = params.args
        .map((argument) => (argument.value !== undefined ? String(argument.value) : argument.description ?? argument.type))
        .join(' ');
      this.logs.push({ type: params.type, text });
      if (browser.verbose) {
        console.log(`  [page ${params.type}] ${text}`);
      }
    });
    browser.devtools.on('Runtime.exceptionThrown', (params, session) => {
      if (session !== sessionId) {
        return;
      }
      const text = params.exceptionDetails.exception?.description ?? params.exceptionDetails.text;
      this.logs.push({ type: 'exception', text });
      console.error(`  [page exception] ${text}`);
    });
  }

  send(method, params = {}) {
    return this.browser.devtools.send(method, params, this.sessionId);
  }

  async goto(url) {
    const loaded = this.browser.devtools.once('Page.loadEventFired', this.sessionId);
    const navigation = await this.send('Page.navigate', { url });
    if (navigation.errorText) {
      throw new Error(`navigate ${url}: ${navigation.errorText}`);
    }
    await loaded;
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async waitFor(expression, { timeout = 10_000, interval = 100, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await this.eval(expression);
      if (value) {
        return value;
      }
      await sleep(interval);
    }
    throw new Error(`timed out waiting for: ${label}`);
  }

  async click(selector) {
    const quoted = JSON.stringify(selector);
    await this.eval(`(() => {
      const element = document.querySelector(${quoted});
      if (!element) throw new Error('no element ' + ${quoted});
      element.click();
      return true;
    })()`);
  }

  async type(selector, value) {
    await this.eval(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async key(code, key, { down = true, up = true } = {}) {
    const event = {
      key,
      code,
      windowsVirtualKeyCode: code === 'Space' ? 32 : undefined,
      text: key.length === 1 ? key : undefined,
    };
    if (down) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event });
    }
    if (up) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    }
  }

  errors() {
    return this.logs.filter((entry) => entry.type === 'exception' || entry.type === 'error').map((entry) => entry.text);
  }

  close() {
    return this.browser.devtools.send('Target.closeTarget', { targetId: this.targetId });
  }
}

class DevToolsConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error('CDP socket failed'));
    });
    this.socket.onmessage = (event) => this.receive(JSON.parse(event.data));
  }

  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) {
        return;
      }
      if (message.error) {
        const detail = message.error.data ? ` (${message.error.data})` : '';
        pending.reject(new Error(`${message.error.message}${detail}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) {
      listener(message.params, message.sessionId);
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, listener) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, []);
    }
    this.listeners.get(method).push(listener);
  }

  once(method, sessionId) {
    return new Promise((resolve) => {
      const listener = (params, session) => {
        if (session !== sessionId) {
          return;
        }
        const listeners = this.listeners.get(method);
        listeners.splice(listeners.indexOf(listener), 1);
        resolve(params);
      };
      this.on(method, listener);
    });
  }
}
