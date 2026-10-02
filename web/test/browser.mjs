import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STARTUP_ATTEMPTS = 300;
const STARTUP_POLL_MS = 100;
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };

export async function startBridge({ verbose = !!process.env.VERBOSE, port = 0 } = {}) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'server.mjs');
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PORT: String(port), NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  let spawnError;
  child.once('error', error => { spawnError = error; });
  child.stdout.on('data', bytes => {
    output = (output + bytes).slice(-4096);
    if (verbose) process.stdout.write(bytes);
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  for (let attempt = 0; attempt < STARTUP_ATTEMPTS / 2; attempt++) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
    const url = output.match(/Mutter\s+→\s+(http:\/\/localhost:\d+)/)?.[1];
    if (url) {
      return { port: Number(new URL(url).port), url, proc: child, close: () => { child.kill(); return exited; } };
    }
    await sleep(STARTUP_POLL_MS);
  }
  child.kill();
  if (child.pid) await exited;
  throw new Error(`bridge did not start: ${spawnError?.message || output.trim() || `exit ${child.exitCode}`}`);
}

export async function launch({ fakeMedia = true, args: extraArgs = [], verbose = !!process.env.VERBOSE, profile: profileDirectory } = {}) {
  const binary = process.env.CHROME ?? 'chromium';
  const profile = profileDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required',
    '--enable-features=WebCodecs',
    ...(fakeMedia ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  let spawnError;
  let endpoint;
  child.once('error', error => { spawnError = error; });
  child.stderr.on('data', bytes => {
    diagnostics = (diagnostics + bytes.toString()).slice(-4096);
    endpoint ??= diagnostics.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    if (verbose) process.stderr.write(bytes);
  });
  for (let attempt = 0; attempt < STARTUP_ATTEMPTS && !endpoint; attempt++) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
    await sleep(STARTUP_POLL_MS);
  }
  if (!endpoint) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    if (!profileDirectory) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw new Error(`Chromium did not start: ${spawnError?.message || diagnostics.trim() || `exit ${child.exitCode}`}`);
  }
  const devtools = new DevToolsConnection(endpoint);
  await devtools.ready;
  return new Browser(devtools, child, profile, verbose, !profileDirectory);
}

class Browser {
  constructor(devtools, child, profile, verbose, ownsProfile) {
    this.devtools = devtools;
    this.child = child;
    this.profile = profile;
    this.verbose = verbose;
    this.ownsProfile = ownsProfile;
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
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = once(this.child, 'exit');
      await Promise.race([exited, sleep(1500)]);
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
      await exited;
    }
    try {
      this.devtools.socket.close();
    } catch {}
    if (this.ownsProfile) fs.rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export class Page {
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

export class DevToolsConnection {
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
    this.socket.onclose = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('DevTools connection closed'));
      }
      this.pending.clear();
    };
  }

  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
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
