const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mutterCredentials', {
  read: () => ipcRenderer.invoke('mutter:credentials:read'),
  write: value => ipcRenderer.invoke('mutter:credentials:write', value),
});
