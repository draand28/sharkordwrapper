const {
  app, BrowserWindow, Tray, Menu,
  nativeImage, Notification, ipcMain, shell,
  session, desktopCapturer, systemPreferences,
} = require('electron');
const path = require('path');
const AutoLaunch = require('auto-launch');
const fs = require('fs');

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

    ipcMain.once('picker:select', (_, sourceId) => {
      pickerWindow.close();
      const selected = sources.find(s => s.id === sourceId);
      resolve(selected || null);
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

  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    }).then((sources) => {
      if (sources.length === 0) {
        callback({});
        return;
      }
      showScreenPicker(sources).then((selected) => {
        if (selected) {
          callback({ video: selected });
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
    mainWindow = null;
  });
}

function injectDragRegion() {
  if (!mainWindow) return;
  // Inject a transparent drag strip at the top — no layout changes, just enables dragging.
  // Covers the left side only (right side has native overlay buttons).
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

function navigateToSharkord(url) {
  mainWindow.loadURL(url);

  mainWindow.webContents.on('did-finish-load', injectDragRegion);

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
  app.isQuitting = true;
});
