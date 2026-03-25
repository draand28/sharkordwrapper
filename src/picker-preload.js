const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: (callback) => ipcRenderer.on('picker:sources', (_, sources) => callback(sources)),
  select: (sourceId) => ipcRenderer.send('picker:select', sourceId),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
