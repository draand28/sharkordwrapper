const {
  app, BrowserWindow, Tray, Menu,
  nativeImage, Notification, ipcMain, shell,
  session, desktopCapturer, systemPreferences,
} = require('electron');
const path = require('path');
const AutoLaunch = require('auto-launch');
const fs = require('fs');
const audioLoopback = require('./audio-loopback-bridge');

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_URL = 'http://localhost:3000';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  return { url: DEFAULT_URL, autoLaunch: true, minimizeToTray: true };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

const config = loadConfig();

// ── Auto-launch ─────────────────────────────────────────────────────────────
const autoLauncher = new AutoLaunch({
  name: 'Sharkord',
  isHidden: true,
});

function syncAutoLaunch() {
  if (config.autoLaunch) {
    autoLauncher.enable().catch(() => {});
  } else {
    autoLauncher.disable().catch(() => {});
  }
}

// ── Globals ─────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let loopbackActive = false;

function getIcon() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return nativeImage.createEmpty();
}

// ── Screen Picker ───────────────────────────────────────────────────────────
function showScreenPicker(sources) {
  return new Promise((resolve) => {
    const pickerWindow = new BrowserWindow({
      width: 680,
      height: 520,
      parent: mainWindow,
      modal: true,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      backgroundColor: '#1a1a2e',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'picker-preload.js'),
      },
    });

    const sourceData = sources.map(s => ({
      id: s.id,
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
    }));

    ipcMain.once('picker:select', (_, sourceId, audioEnabled) => {
      pickerWindow.close();
      const selected = sources.find(s => s.id === sourceId);
      resolve(selected ? { source: selected, audio: audioEnabled } : null);
    });

    ipcMain.once('picker:cancel', () => {
      pickerWindow.close();
      resolve(null);
    });

    pickerWindow.on('closed', () => {
      ipcMain.removeAllListeners('picker:select');
      ipcMain.removeAllListeners('picker:cancel');
      resolve(null);
    });

    pickerWindow.loadFile(path.join(__dirname, 'picker.html'));
    pickerWindow.webContents.on('did-finish-load', () => {
      pickerWindow.webContents.send('picker:sources', sourceData);
    });
  });
}

// ── Audio loopback ──────────────────────────────────────────────────────────
// Returns empty string on success, or error message on failure
function startLoopbackCapture() {
  if (loopbackActive) return '';
  if (!audioLoopback.isSupported()) {
    return 'OS not supported (need Windows 10 2004+)';
  }

  let frameCount = 0;
  const error = audioLoopback.startCapture(process.pid, (buffer, channels, sampleRate) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      frameCount++;
      if (frameCount === 1) {
        console.log('[Main] First audio frame received:', { channels, sampleRate, bufferLen: buffer.length });
      }
      mainWindow.webContents.send('audio-loopback:data', Array.from(buffer), channels, sampleRate);
    }
  });

  if (error) {
    console.warn('[Main] Native loopback capture failed:', error);
    loopbackActive = false;
    return error;
  }

  console.log('[Main] Native loopback capture started successfully');
  loopbackActive = true;
  return '';
}

function stopLoopbackCapture() {
  if (!loopbackActive) return;
  audioLoopback.stopCapture();
  loopbackActive = false;
  console.log('[Main] Native loopback capture stopped');
}

// ── Permissions ─────────────────────────────────────────────────────────────
function setupPermissions() {
  const ses = session.defaultSession;

  const allowedPermissions = [
    'media',
    'mediaKeySystem',
    'geolocation',
    'notifications',
    'fullscreen',
    'clipboard-read',
    'clipboard-sanitized-write',
    'screen-wake-lock',
    'display-capture',
  ];

  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(allowedPermissions.includes(permission));
  });

  ses.setPermissionCheckHandler((webContents, permission) => {
    return allowedPermissions.includes(permission);
  });

  // Relax CSP so our injected scripts and Blob URLs work
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    // Remove CSP that blocks our injected audio worklet
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    callback({ responseHeaders: headers });
  });

  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    }).then((sources) => {
      if (sources.length === 0) {
        callback({});
        return;
      }
      showScreenPicker(sources).then((result) => {
        if (result) {
          if (result.audio) {
            const error = startLoopbackCapture();
            // Log result to DevTools console
            if (!error) {
              mainWindow.webContents.executeJavaScript(
                `console.log('[Sharkord] Native process-exclusive loopback started (PID ${process.pid} excluded)')`
              ).catch(() => {});
              callback({ video: result.source });
            } else {
              mainWindow.webContents.executeJavaScript(
                `console.warn('[Sharkord] Native loopback failed: ' + ${JSON.stringify(error)} + ' — falling back to regular loopback (with echo)')`
              ).catch(() => {});
              callback({ video: result.source, audio: 'loopback' });
            }
          } else {
            callback({ video: result.source });
          }
        } else {
          callback({});
        }
      });
    }).catch(() => {
      callback({});
    });
  });
}

// ── Window ──────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f0f23',
      symbolColor: '#8888aa',
      height: 32,
    },
    icon: getIcon(),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (config.url && config.url !== DEFAULT_URL) {
    navigateToSharkord(config.url);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'shell.html'));
  }

  mainWindow.on('close', (e) => {
    if (config.minimizeToTray && !app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    stopLoopbackCapture();
    mainWindow = null;
  });
}

function injectDragRegion() {
  if (!mainWindow) return;
  mainWindow.webContents.insertCSS(`
    #sharkord-drag {
      position: fixed;
      top: 0;
      left: 0;
      right: 138px;
      height: 32px;
      -webkit-app-region: drag;
      z-index: 2147483647;
    }
  `).catch(() => {});
  mainWindow.webContents.executeJavaScript(`
    if (!document.getElementById('sharkord-drag')) {
      const d = document.createElement('div');
      d.id = 'sharkord-drag';
      document.body.prepend(d);
    }
  `).catch(() => {});
}

// Injection script: monkey-patches getDisplayMedia to add process-exclusive
// loopback audio. Uses ScriptProcessorNode (no Blob URL needed, avoids CSP).
const AUDIO_INJECT_SCRIPT = `
(function() {
  if (window.__sharkordAudioInjected) return;
  window.__sharkordAudioInjected = true;
  console.log('[Sharkord] Audio injection script loaded');

  const originalGDM = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getDisplayMedia = async function(constraints) {
    console.log('[Sharkord] getDisplayMedia intercepted');
    const stream = await originalGDM(constraints);

    if (!window.__sharkordAudio) {
      console.log('[Sharkord] No __sharkordAudio bridge, returning original stream');
      return stream;
    }

    // Check if native loopback is sending data (wait up to 500ms)
    const hasNativeAudio = await new Promise((resolve) => {
      let received = false;
      const handler = () => {
        if (!received) {
          received = true;
          console.log('[Sharkord] Native audio data detected!');
          resolve(true);
        }
      };
      window.__sharkordAudio.onData(handler);
      setTimeout(() => {
        window.__sharkordAudio.removeData(handler);
        if (!received) {
          console.log('[Sharkord] No native audio data after 500ms');
          resolve(false);
        }
      }, 500);
    });

    if (!hasNativeAudio) {
      console.log('[Sharkord] No native loopback data, returning original stream (may have regular loopback)');
      return stream;
    }

    // Remove any existing audio tracks (from regular loopback fallback)
    stream.getAudioTracks().forEach(t => {
      console.log('[Sharkord] Removing existing audio track:', t.label);
      stream.removeTrack(t);
      t.stop();
    });

    console.log('[Sharkord] Setting up custom audio track from native loopback');

    try {
      // Create AudioContext matching the system sample rate
      const audioCtx = new AudioContext({ sampleRate: 48000 });
      await audioCtx.resume();

      // Use ScriptProcessorNode — works everywhere, no Blob URL / CSP issues
      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 2);
      const dest = audioCtx.createMediaStreamDestination();

      // Ring buffer for incoming PCM data (interleaved)
      let ringBuffer = new Float32Array(0);
      let incomingChannels = 2;

      const dataHandler = (samples, channels, sampleRate) => {
        incomingChannels = channels;
        // Append to ring buffer
        const newBuf = new Float32Array(ringBuffer.length + samples.length);
        newBuf.set(ringBuffer);
        newBuf.set(new Float32Array(samples), ringBuffer.length);
        ringBuffer = newBuf;
      };
      window.__sharkordAudio.onData(dataHandler);

      processor.onaudioprocess = (e) => {
        const outL = e.outputBuffer.getChannelData(0);
        const outR = e.outputBuffer.getChannelData(1);
        const frameSize = outL.length;
        const needed = frameSize * incomingChannels;

        if (ringBuffer.length >= needed) {
          // Deinterleave
          for (let i = 0; i < frameSize; i++) {
            outL[i] = ringBuffer[i * incomingChannels];
            outR[i] = incomingChannels > 1 ? ringBuffer[i * incomingChannels + 1] : ringBuffer[i * incomingChannels];
          }
          ringBuffer = ringBuffer.subarray(needed);
        } else {
          // Not enough data — output silence
          outL.fill(0);
          outR.fill(0);
        }
      };

      processor.connect(dest);

      // Add our custom audio track to the display media stream
      const audioTrack = dest.stream.getAudioTracks()[0];
      if (audioTrack) {
        stream.addTrack(audioTrack);
        console.log('[Sharkord] Custom audio track added to stream');
      } else {
        console.warn('[Sharkord] No audio track from destination node');
      }

      // Clean up when screen sharing stops
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener('ended', () => {
          console.log('[Sharkord] Video track ended, cleaning up audio loopback');
          window.__sharkordAudio.removeData(dataHandler);
          window.__sharkordAudio.stop();
          processor.disconnect();
          audioCtx.close().catch(() => {});
          nativeLoopbackActive = false;
        });
      }
    } catch (e) {
      console.error('[Sharkord] Failed to set up audio track:', e);
      // Return stream without custom audio — won't have loopback at all
    }

    return stream;
  };
})();
`;

function injectAudioScript() {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(AUDIO_INJECT_SCRIPT).catch((e) => {
    console.warn('[Main] Failed to inject audio script:', e);
  });
}

function navigateToSharkord(url) {
  mainWindow.loadURL(url);

  mainWindow.webContents.on('did-finish-load', () => {
    injectDragRegion();
    injectAudioScript();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    try {
      const target = new URL(linkUrl);
      const base = new URL(config.url);
      if (target.origin !== base.origin) {
        shell.openExternal(linkUrl);
        return { action: 'deny' };
      }
    } catch {}
    return { action: 'allow' };
  });
}

// ── Tray ────────────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(getIcon());
  tray.setToolTip('Sharkord');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Sharkord',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Auto-start on login',
      type: 'checkbox',
      checked: config.autoLaunch,
      click: (item) => {
        config.autoLaunch = item.checked;
        saveConfig(config);
        syncAutoLaunch();
      },
    },
    {
      label: 'Minimize to tray on close',
      type: 'checkbox',
      checked: config.minimizeToTray,
      click: (item) => {
        config.minimizeToTray = item.checked;
        saveConfig(config);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── IPC handlers ────────────────────────────────────────────────────────────
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow?.close());

ipcMain.handle('get-config', () => config);

ipcMain.handle('connect-url', (_, url) => {
  config.url = url;
  saveConfig(config);
  navigateToSharkord(url);
  return config;
});

ipcMain.on('notify', (_, { title, body }) => {
  if (Notification.isSupported()) {
    const notif = new Notification({ title, body, icon: getIcon() });
    notif.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    notif.show();
  }
});

ipcMain.on('window:check-maximized', (event) => {
  event.returnValue = mainWindow?.isMaximized() ?? false;
});

ipcMain.on('audio-loopback:stop', () => {
  stopLoopbackCapture();
});

ipcMain.on('audio-loopback:supported', (event) => {
  event.returnValue = audioLoopback.isSupported();
});

// ── App lifecycle ───────────────────────────────────────────────────────────
app.on('ready', () => {
  if (process.platform === 'win32') {
    try {
      if (systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
        systemPreferences.askForMediaAccess('camera').catch(() => {});
      }
      if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
        systemPreferences.askForMediaAccess('microphone').catch(() => {});
      }
    } catch {}
  }

  setupPermissions();
  createWindow();
  createTray();
  syncAutoLaunch();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopLoopbackCapture();
  app.isQuitting = true;
});
