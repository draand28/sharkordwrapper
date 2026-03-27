const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: (callback) => ipcRenderer.on('picker:sources', (_, sources) => callback(sources)),
  select: (sourceId, audioEnabled) => ipcRenderer.send('picker:select', sourceId, audioEnabled),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
