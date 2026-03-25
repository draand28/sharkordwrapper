const { contextBridge, ipcRenderer } = require('electron');

// Exposed to shell.html (setup page)
contextBridge.exposeInMainWorld('sharkord', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.sendSync('window:check-maximized'),

  notify: (title, body) => ipcRenderer.send('notify', { title, body }),

  getConfig: () => ipcRenderer.invoke('get-config'),
  connectUrl: (url) => ipcRenderer.invoke('connect-url', url),
});

// Exposed for the injected titlebar on Sharkord pages
contextBridge.exposeInMainWorld('__sharkordTitlebar', {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
});
