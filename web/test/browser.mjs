// Drives headless Chromium over the DevTools protocol with nothing but Node's built-in
// WebSocket, so the test suite keeps the project's zero-dependency rule.
//
//   const b = await launch();
//   const page = await b.newPage('http://localhost:8788');
//   console.log(await page.eval('document.title'));
//   await b.close();

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/// Runs web/bridge/server.mjs on a free port. Pages must come from http://localhost: WebCodecs
/// and getUserMedia only exist in secure contexts, and about:blank isn't one.
export async function startBridge({ verbose = !!process.env.VERBOSE } = {}) {
  const port = 8800 + Math.floor(Math.random() * 400);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'server.mjs');
  const proc = spawn(process.execPath, [script], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', verbose ? 'inherit' : 'ignore', 'inherit'] });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://localhost:${port}/`); return { port, url: `http://localhost:${port}`, proc, close: () => proc.kill() }; } catch { await sleep(100); }
  }
  proc.kill();
  throw new Error('bridge did not start');
}

export async function launch({ fakeMedia = true, args: extra = [], verbose = !!process.env.VERBOSE } = {}) {
  const bin = process.env.CHROME ?? 'chromium';
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mutter-chrome-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--autoplay-policy=no-user-gesture-required',
    '--enable-features=WebCodecs',
    ...(fakeMedia ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
    ...extra, 'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', verbose ? 'inherit' : 'ignore'] });
  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(100); }
  }
  if (!version) { proc.kill(); throw new Error('Chromium did not start'); }
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;
  return new Browser(cdp, proc, profile, verbose);
}

class Browser {
  constructor(cdp, proc, profile, verbose) { this.cdp = cdp; this.proc = proc; this.profile = profile; this.verbose = verbose; }

  async newPage(url) {
    const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    if (url) await page.goto(url);
    return page;
  }

  async close() {
    try { await Promise.race([this.cdp.send('Browser.close'), sleep(1500)]); } catch {}
    this.proc.kill('SIGKILL');
    try { this.cdp.ws.close(); } catch {}
    fs.rmSync(this.profile, { recursive: true, force: true });
  }
}

class Page {
  constructor(browser, sessionId, targetId) {
    this.browser = browser; this.sessionId = sessionId; this.targetId = targetId;
    this.logs = [];
    browser.cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid !== sessionId) return;
      const text = p.args.map(a => a.value !== undefined ? String(a.value) : a.description ?? a.type).join(' ');
      this.logs.push({ type: p.type, text });
      if (browser.verbose) console.log(`  [page ${p.type}] ${text}`);
    });
    browser.cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid !== sessionId) return;
      const text = p.exceptionDetails.exception?.description ?? p.exceptionDetails.text;
      this.logs.push({ type: 'exception', text });
      console.error(`  [page exception] ${text}`);
    });
  }

  send(method, params = {}) { return this.browser.cdp.send(method, params, this.sessionId); }

  async goto(url) {
    const loaded = this.browser.cdp.once('Page.loadEventFired', this.sessionId);
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) throw new Error(`navigate ${url}: ${nav.errorText}`);
    await loaded;
  }

  /// Evaluates an expression (awaiting it if it's a promise) and returns the JSON value.
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  /// Polls an expression until it's truthy; returns the value.
  async waitFor(expression, { timeout = 10_000, interval = 100, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const v = await this.eval(expression);
      if (v) return v;
      await sleep(interval);
    }
    throw new Error(`timed out waiting for: ${label}`);
  }

  async click(selector) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('no element ' + ${JSON.stringify(selector)}); el.click(); return true; })()`);
  }

  async type(selector, value) {
    await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  /// Presses and releases a key; `hold` keeps it down until you call the returned release().
  async key(code, key, { down = true, up = true } = {}) {
    const ev = { key, code, windowsVirtualKeyCode: code === 'Space' ? 32 : undefined, text: key.length === 1 ? key : undefined };
    if (down) await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ev });
    if (up) await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  }

  errors() { return this.logs.filter(l => l.type === 'exception' || l.type === 'error').map(l => l.text); }

  close() { return this.browser.cdp.send('Target.closeTarget', { targetId: this.targetId }); }
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0; this.pending = new Map(); this.listeners = new Map();
    this.ready = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('CDP socket failed')); });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (!p) return;
        m.error ? p.reject(new Error(`${m.error.message}${m.error.data ? ` (${m.error.data})` : ''}`)) : p.resolve(m.result ?? {});
      } else {
        for (const fn of this.listeners.get(m.method) ?? []) fn(m.params, m.sessionId);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) { (this.listeners.get(method) ?? this.listeners.set(method, []).get(method)).push(fn); }
  once(method, sessionId) {
    return new Promise(res => {
      const fn = (params, sid) => { if (sid === sessionId) { const l = this.listeners.get(method); l.splice(l.indexOf(fn), 1); res(params); } };
      this.on(method, fn);
    });
  }
}
