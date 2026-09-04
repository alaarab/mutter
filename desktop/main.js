// Mutter as a desktop app. The main process is Node, so it runs the bridge itself — the same
// web/bridge/server.mjs that WSL runs — and the window loads the same web client from it.
// What this buys over a browser: our own Chromium, which reads no enterprise policy from the
// registry, so a managed laptop's WebRTC lockdown does not apply; a real screen picker with
// system audio on Windows; one taskbar entry with our icon; and an install that needs no admin.

import { app, BrowserWindow, session, desktopCapturer, shell, ipcMain, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(here, '..', 'web');
const SMOKE = process.argv.includes('--smoke');

// Portable, the VS Code way. Everything the app remembers — servers, settings, the remembered
// password — lives in Chromium's userData. Installed normally that is %APPDATA%\Mutter. But if a
// `data` folder sits beside the executable, it lives there instead, so the folder can be moved,
// zipped or carried on a stick and nothing is left on the machine. The single-file portable build
// always does this (its launcher tells us where it is); the unzipped folder does it if you create
// the `data` folder, exactly VS Code's rule. Must run before ready(), before any storage opens.
const besideExe = process.env.PORTABLE_EXECUTABLE_DIR ?? (app.isPackaged ? path.dirname(process.execPath) : null);
const dataDir = besideExe && path.join(besideExe, 'data');
if (dataDir && (process.env.PORTABLE_EXECUTABLE_DIR || fs.existsSync(dataDir))) {
  fs.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
  app.setPath('sessionData', dataDir);
}

// The bridge reads its configuration from the environment, same as on the command line.
process.env.NO_OPEN = '1';                       // we are the window
process.env.PORT ??= '0';                        // any free port; two copies must not collide

if (!app.requestSingleInstanceLock()) app.quit();
if (SMOKE) app.disableHardwareAcceleration();    // the smoke run has no display: render offscreen

let win = null;

app.whenReady().then(async () => {
  const { ready } = await import(pathToFileURL(path.join(webRoot, 'bridge', 'server.mjs')).href);
  const url = await ready;
  if (SMOKE) { console.log(`smoke: bridge up at ${url}`); console.log(`smoke: userData ${app.getPath('userData')}`); }

  // getDisplayMedia() in Electron needs us to say which screen or window. We show a picker; on
  // Windows we also hand over system audio via loopback, which the browser build never could.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
      const chosen = await pickSource(sources);
      if (!chosen) return callback({});      // denied → getDisplayMedia rejects, and the UI already copes with a cancelled picker
      callback({ video: chosen, audio: request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined });
    } catch { callback({}); }
  }, { useSystemPicker: true });               // macOS 15+ has a native one; elsewhere ours is used

  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 380, minHeight: 560,
    title: 'Mutter', backgroundColor: '#08080A', autoHideMenuBar: true, show: false,
    icon: nativeImage.createFromPath(path.join(here, 'build', 'icon.png')),
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true, offscreen: SMOKE },
  });
  win.once('ready-to-show', () => { if (!SMOKE) win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, target) => { if (!target.startsWith(url)) { e.preventDefault(); shell.openExternal(target); } });
  win.on('closed', () => { win = null; });
  await win.loadURL(url);

  if (SMOKE) {
    const title = await win.webContents.executeJavaScript('document.title');
    const hasMark = await win.webContents.executeJavaScript(`!!document.querySelector('#railHome svg')`);
    console.log(`smoke: window loaded "${title}", brand mark ${hasMark ? 'present' : 'MISSING'}`);
    app.quit();
  }
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());

/// A small modal listing screens and windows with thumbnails; resolves with the chosen source or
/// null. Electron has no built-in picker outside macOS, so this is ours.
function pickSource(sources) {
  return new Promise(resolve => {
    const picker = new BrowserWindow({
      width: 760, height: 560, parent: win ?? undefined, modal: !!win, show: false, resizable: false,
      title: 'Share your screen', backgroundColor: '#111113', autoHideMenuBar: true,
      webPreferences: { preload: path.join(here, 'picker-preload.cjs'), contextIsolation: true, sandbox: true },
    });
    let settled = false;
    const done = value => { if (settled) return; settled = true; resolve(value); if (!picker.isDestroyed()) picker.close(); };
    ipcMain.once('picker:choose', (_e, id) => done(sources.find(s => s.id === id) ?? null));
    picker.on('closed', () => done(null));
    picker.loadFile(path.join(here, 'picker.html'));
    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send('picker:sources', sources.map(s => ({
        id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window',
        thumb: s.thumbnail.toDataURL(), icon: s.appIcon?.isEmpty() === false ? s.appIcon.toDataURL() : null,
      })));
      picker.show();
    });
  });
}
