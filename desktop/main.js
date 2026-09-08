import { app, BrowserWindow, session, desktopCapturer, shell, ipcMain, nativeImage, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allowsPermission, isAppURL, isExternalURL } from './security.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(here, '..', 'web');
const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(here, 'build', 'icon.png');
const SMOKE = process.argv.includes('--smoke');
const MAIN_WINDOW = { width: 1180, height: 760, minWidth: 380, minHeight: 560 };
const PICKER_WINDOW = { width: 760, height: 560 };
const THUMBNAIL_SIZE = { width: 320, height: 180 };
const { THEMES, DEFAULT_THEME } = await import(pathToFileURL(path.join(webRoot, 'app', 'theme-data.js')).href);
const HOOK_MOUSE_BUTTON_FROM_DOM = { 3: 4, 4: 5 };
const HOOK_KEY_NAME_FROM_DOM = {
  ControlLeft: 'Ctrl',
  ControlRight: 'CtrlRight',
  ShiftLeft: 'Shift',
  ShiftRight: 'ShiftRight',
  AltLeft: 'Alt',
  AltRight: 'AltRight',
  MetaLeft: 'Meta',
  MetaRight: 'MetaRight',
};

let mainWindow = null;

function usePortableDataFolder() {
  const besideExecutable = process.env.PORTABLE_EXECUTABLE_DIR ?? (app.isPackaged ? path.dirname(process.execPath) : null);
  if (!besideExecutable) {
    return;
  }
  const dataDir = path.join(besideExecutable, 'data');
  if (!process.env.PORTABLE_EXECUTABLE_DIR && !fs.existsSync(dataDir)) {
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
  app.setPath('sessionData', dataDir);
}

function configureBridgeEnvironment() {
  process.env.NO_OPEN = '1';
  process.env.PORT ??= '8789';
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a fixed port between 1 and 65535 so Mutter can retain its settings.');
  }
}

async function startBridge() {
  const bridgeUrl = pathToFileURL(path.join(webRoot, 'bridge', 'server.mjs')).href;
  const { ready } = await import(bridgeUrl);
  return ready;
}

function installScreenPicker(url) {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (!mainWindow || request.frame !== mainWindow.webContents.mainFrame || !isAppURL(request.frame?.url, url)) {
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: THUMBNAIL_SIZE,
          fetchWindowIcons: true,
        });
        const chosen = await pickSource(sources);
        if (!chosen) {
          callback({});
          return;
        }
        const audio = request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined;
        callback({ video: chosen, audio });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: true }
  );
}

function createMainWindow(url) {
  const window = new BrowserWindow({
    ...MAIN_WINDOW,
    title: 'Mutter',
    backgroundColor: THEMES[DEFAULT_THEME].dark.bg,
    autoHideMenuBar: true,
    show: false,
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true, offscreen: SMOKE },
  });
  window.once('ready-to-show', () => {
    if (!SMOKE) {
      window.show();
    }
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isExternalURL(target)) shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isAppURL(event.url, url)) {
      event.preventDefault();
      if (event.isMainFrame && isExternalURL(event.url)) shell.openExternal(event.url).catch(() => {});
    }
  });
  window.webContents.on('will-redirect', (event, target) => {
    if (!isAppURL(target, url)) event.preventDefault();
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window.webContents && allowsPermission(permission, details.requestingUrl, contents.getURL(), url, details.isMainFrame));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    contents === window.webContents && allowsPermission(permission, origin, contents.getURL(), url, details.isMainFrame)
  );
  window.on('closed', () => {
    mainWindow = null;
  });
  return window;
}

async function runSmokeCheck(window, url) {
  console.log(`smoke: bridge up at ${url}`);
  console.log(`smoke: userData ${app.getPath('userData')}`);
  const title = await window.webContents.executeJavaScript('document.title');
  const hasMark = await window.webContents.executeJavaScript(`!!document.querySelector('#railHome svg')`);
  console.log(`smoke: window loaded "${title}", brand mark ${hasMark ? 'present' : 'MISSING'}`);
  if (process.env.MUTTER_SMOKE_STORAGE) {
    const previous = await window.webContents.executeJavaScript(`localStorage.getItem('mutter.smoke')`);
    console.log(`smoke: previous storage ${JSON.stringify(previous)}`);
    await window.webContents.executeJavaScript(`localStorage.setItem('mutter.smoke', ${JSON.stringify(process.env.MUTTER_SMOKE_STORAGE)})`);
    await session.defaultSession.flushStorageData();
  }
  app.quit();
}

function hookKeyFor(code, UiohookKey) {
  if (!code || code.startsWith('Mouse')) {
    return null;
  }
  const name = HOOK_KEY_NAME_FROM_DOM[code] ?? code.replace(/^Key|^Digit/, '');
  return UiohookKey[name] ?? null;
}

function hookMouseButtonFor(code) {
  const match = /^Mouse(\d)$/.exec(code ?? '');
  return match ? (HOOK_MOUSE_BUTTON_FROM_DOM[Number(match[1])] ?? null) : null;
}

async function installGlobalPushToTalk(window) {
  let hook;
  try {
    hook = await import('uiohook-napi');
  } catch (error) {
    console.log(`push to talk from other windows unavailable: ${error.message}`);
    return;
  }
  const { uIOhook, UiohookKey } = hook;
  const bound = { key: null, mouseButton: null, pressed: false };
  const readBinding = async () => {
    const code = await window.webContents.executeJavaScript('window.mutter?.settings.pttKey ?? null').catch(() => null);
    bound.key = hookKeyFor(code, UiohookKey);
    bound.mouseButton = hookMouseButtonFor(code);
  };
  const press = (pressed) => {
    if (bound.pressed === pressed || window.isDestroyed() || (pressed && window.isFocused())) {
      return;
    }
    bound.pressed = pressed;
    window.webContents.executeJavaScript(`window.mutter?.audio.setPTT(${pressed})`).catch(() => {});
  };
  uIOhook.on('keydown', (event) => {
    if (bound.key !== null && event.keycode === bound.key) {
      press(true);
    }
  });
  uIOhook.on('keyup', (event) => {
    if (bound.key !== null && event.keycode === bound.key) {
      press(false);
    }
  });
  uIOhook.on('mousedown', (event) => {
    if (bound.mouseButton !== null && event.button === bound.mouseButton) {
      press(true);
    }
  });
  uIOhook.on('mouseup', (event) => {
    if (bound.mouseButton !== null && event.button === bound.mouseButton) {
      press(false);
    }
  });
  window.on('blur', readBinding);
  window.on('focus', () => {
    bound.pressed = false;
  });
  window.webContents.on('did-finish-load', readBinding);
  try {
    uIOhook.start();
  } catch (error) {
    console.log(`push to talk from other windows unavailable: ${error.message}`);
    return;
  }
  app.on('will-quit', () => uIOhook.stop());
  await readBinding();
}

function describeSource(source) {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen') ? 'screen' : 'window',
    thumb: source.thumbnail.toDataURL(),
    icon: source.appIcon?.isEmpty() === false ? source.appIcon.toDataURL() : null,
  };
}

async function pickSource(sources) {
  const selected = await mainWindow?.webContents.executeJavaScript(`({
    theme: document.documentElement.dataset.theme,
    appearance: document.documentElement.dataset.appearance
  })`);
  const theme = Object.hasOwn(THEMES, selected?.theme) ? selected.theme : DEFAULT_THEME;
  const appearance = selected?.appearance === 'light' ? 'light' : 'dark';
  const pickerURL = new URL('/app/picker.html', mainWindow.webContents.getURL()).href;
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      ...PICKER_WINDOW,
      parent: mainWindow ?? undefined,
      modal: !!mainWindow,
      show: false,
      resizable: false,
      title: 'Share your screen',
      backgroundColor: THEMES[theme][appearance].surface,
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(here, 'picker-preload.cjs'), contextIsolation: true, sandbox: true },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      ipcMain.removeListener('picker:choose', onChoose);
      resolve(value);
      if (!picker.isDestroyed()) {
        picker.close();
      }
    };
    const onChoose = (event, id) => {
      if (event.sender === picker.webContents) finish(sources.find((source) => source.id === id) ?? null);
    };
    ipcMain.on('picker:choose', onChoose);
    picker.on('closed', () => finish(null));
    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send('picker:setup', { sources: sources.map(describeSource), theme, appearance });
      picker.show();
    });
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    picker.webContents.on('will-navigate', (event) => event.preventDefault());
    picker.loadURL(pickerURL).catch(() => finish(null));
  });
}

usePortableDataFolder();

const ownsInstanceLock = app.requestSingleInstanceLock();
if (!ownsInstanceLock) {
  app.quit();
}
if (SMOKE) {
  app.disableHardwareAcceleration();
  console.log('smoke: waiting for Electron');
}

app.whenReady().then(async () => {
  if (!ownsInstanceLock) return;
  if (SMOKE) console.log('smoke: Electron ready');
  configureBridgeEnvironment();
  const url = await startBridge();
  installScreenPicker(url);
  mainWindow = createMainWindow(url);
  await mainWindow.loadURL(url);
  if (SMOKE) {
    await runSmokeCheck(mainWindow, url);
    return;
  }
  installGlobalPushToTalk(mainWindow);
}).catch(error => {
  console.error(`Mutter could not start: ${error.message}`);
  if (!SMOKE) dialog.showErrorBox('Mutter could not start', error.code === 'EADDRINUSE'
    ? `Local port ${process.env.PORT} is already in use. Close the other process using this port and try again.`
    : error.message);
  app.exit(1);
});

app.on('second-instance', () => {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
});
app.on('window-all-closed', () => app.quit());
