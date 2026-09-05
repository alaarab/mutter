import { app, BrowserWindow, session, desktopCapturer, shell, ipcMain, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(here, '..', 'web');
const SMOKE = process.argv.includes('--smoke');
const MAIN_WINDOW = { width: 1180, height: 760, minWidth: 380, minHeight: 560 };
const PICKER_WINDOW = { width: 760, height: 560 };
const THUMBNAIL_SIZE = { width: 320, height: 180 };
const BACKGROUND = '#08080A';
const PICKER_BACKGROUND = '#111113';

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
  process.env.PORT ??= '0';
}

async function startBridge() {
  const bridgeUrl = pathToFileURL(path.join(webRoot, 'bridge', 'server.mjs')).href;
  const { ready } = await import(bridgeUrl);
  return ready;
}

function installScreenPicker() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
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
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    show: false,
    icon: nativeImage.createFromPath(path.join(here, 'build', 'icon.png')),
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true, offscreen: SMOKE },
  });
  window.once('ready-to-show', () => {
    if (!SMOKE) {
      window.show();
    }
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });
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
  app.quit();
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

function pickSource(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      ...PICKER_WINDOW,
      parent: mainWindow ?? undefined,
      modal: !!mainWindow,
      show: false,
      resizable: false,
      title: 'Share your screen',
      backgroundColor: PICKER_BACKGROUND,
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(here, 'picker-preload.cjs'), contextIsolation: true, sandbox: true },
    });
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      if (!picker.isDestroyed()) {
        picker.close();
      }
    };
    ipcMain.once('picker:choose', (_event, id) => finish(sources.find((source) => source.id === id) ?? null));
    picker.on('closed', () => finish(null));
    picker.loadFile(path.join(here, 'picker.html'));
    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send('picker:sources', sources.map(describeSource));
      picker.show();
    });
  });
}

usePortableDataFolder();
configureBridgeEnvironment();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}
if (SMOKE) {
  app.disableHardwareAcceleration();
}

app.whenReady().then(async () => {
  const url = await startBridge();
  installScreenPicker();
  mainWindow = createMainWindow(url);
  await mainWindow.loadURL(url);
  if (SMOKE) {
    await runSmokeCheck(mainWindow, url);
  }
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
