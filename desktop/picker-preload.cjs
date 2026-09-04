// The picker page gets exactly two things: the list of sources, and a way to answer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: cb => ipcRenderer.on('picker:sources', (_e, sources) => cb(sources)),
  choose: id => ipcRenderer.send('picker:choose', id),
});
