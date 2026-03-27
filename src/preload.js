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

// Audio loopback bridge — feeds PCM data from native addon to page context
const audioListeners = [];

ipcRenderer.on('audio-loopback:data', (_, buffer, channels, sampleRate) => {
  for (const cb of audioListeners) {
    cb(buffer, channels, sampleRate);
  }
});

contextBridge.exposeInMainWorld('__sharkordAudio', {
  onData: (callback) => {
    audioListeners.push(callback);
  },
  removeData: (callback) => {
    const idx = audioListeners.indexOf(callback);
    if (idx !== -1) audioListeners.splice(idx, 1);
  },
  stop: () => ipcRenderer.send('audio-loopback:stop'),
  isSupported: () => ipcRenderer.sendSync('audio-loopback:supported'),
});
