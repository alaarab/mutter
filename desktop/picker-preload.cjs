const { contextBridge, ipcRenderer } = require('electron');

// IPC can arrive before the renderer's module scripts register their listener.
let setup;
const listeners = new Set();
ipcRenderer.on('picker:setup', (_event, value) => {
  setup = value;
  for (const callback of listeners) callback(value);
});

contextBridge.exposeInMainWorld('picker', {
  onSetup: (callback) => {
    listeners.add(callback);
    if (setup) callback(setup);
  },
  choose: (id) => ipcRenderer.send('picker:choose', id),
});
