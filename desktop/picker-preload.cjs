const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSetup: (callback) => ipcRenderer.on('picker:setup', (_event, setup) => callback(setup)),
  choose: (id) => ipcRenderer.send('picker:choose', id),
});
