import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const timeout = setTimeout(() => app.exit(1), 30_000);
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`(async () => {
        if (!window.mutterCredentials) throw new Error('Credential preload did not load');
        const store = await import('/app/store.js');
        if (!store.credentialStorage.available) return { available: false, error: store.credentialStorage.notice };
        if (${JSON.stringify(process.env.MUTTER_CREDENTIAL_PHASE)} === 'write') {
          store.settings.turn.credential = 'private-turn-fixture';
          await store.saveSettings();
          await store.rememberServer({host:'example.invalid',port:64738,username:'Test',password:'private-server-fixture',remember:true});
          await store.flushCredentials();
        }
        return { available: store.credentialStorage.available, password: store.servers[0]?.password,
          turn: store.settings.turn.credential, persisted: JSON.stringify({...localStorage}) };
      })()`);
      if (result.error) throw new Error(result.error);
      if (result.available) {
        if (result.password !== 'private-server-fixture' || result.turn !== 'private-turn-fixture' || result.persisted.includes('private-')) throw new Error('Credentials did not round trip securely');
      }
      const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(desktop, 'preload.cjs') } });
      await other.loadURL(window.webContents.getURL());
      const denied = await other.webContents.executeJavaScript("mutterCredentials.read().then(() => false, () => true)");
      other.destroy();
      if (!denied) throw new Error('Credentials escaped the main window');
      console.log('PASS: credential IPC isolation');
      console.log(result.available ? 'PASS: OS-encrypted credentials and IPC isolation' : 'UNAVAILABLE: session-only credentials');
      clearTimeout(timeout);
      app.quit();
    } catch (error) { console.error(error.message); app.exit(1); }
  });
});
await import('../main.js');
