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
let isOnSetupPage = true;
const TITLEBAR_HEIGHT = 32;

function getIcon() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  if (fs.existsSync(iconPath)) {
    return nativeImage.createFromPath(iconPath);
  }
  return nativeImage.createEmpty();
}

// ── Titlebar CSS + HTML injected into Sharkord pages ────────────────────────
const TITLEBAR_CSS = `
  #sharkord-titlebar {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: ${TITLEBAR_HEIGHT}px;
    background: #0f0f23;
    display: flex;
    align-items: center;
    z-index: 2147483647;
    -webkit-app-region: drag;
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #sharkord-titlebar .tb-icon {
    width: 16px; height: 16px;
    margin: 0 8px 0 10px;
  }
  #sharkord-titlebar .tb-title {
    color: #8888aa;
    font-size: 12px;
    font-weight: 500;
    flex: 1;
  }
  #sharkord-titlebar .tb-btn {
    -webkit-app-region: no-drag;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: ${TITLEBAR_HEIGHT}px;
    border: none;
    background: transparent;
    color: #8888aa;
    cursor: pointer;
    transition: background 0.15s, color 0.15s;
  }
  #sharkord-titlebar .tb-btn:hover {
    background: rgba(255,255,255,0.08);
    color: #ffffff;
  }
  #sharkord-titlebar .tb-btn.tb-close:hover {
    background: #e81123;
    color: #ffffff;
  }
  #sharkord-titlebar .tb-btn svg {
    width: 12px; height: 12px;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.5;
  }
  /* Push page content below the titlebar */
  body {
    margin-top: ${TITLEBAR_HEIGHT}px !important;
  }
`;

const TITLEBAR_HTML = `
  <div id="sharkord-titlebar">
    <svg class="tb-icon" viewBox="0 0 16 16" fill="#5865f2"><circle cx="8" cy="8" r="7"/></svg>
    <span class="tb-title">Sharkord</span>
    <button class="tb-btn" id="tb-min" title="Minimize">
      <svg viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6"/></svg>
    </button>
    <button class="tb-btn" id="tb-max" title="Maximize">
      <svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1"/></svg>
    </button>
    <button class="tb-btn tb-close" id="tb-close" title="Close">
      <svg viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
    </button>
  </div>
`;

const TITLEBAR_JS = `
  (function() {
    if (document.getElementById('sharkord-titlebar')) return;
    const div = document.createElement('div');
    div.innerHTML = ${JSON.stringify(TITLEBAR_HTML)};
    document.body.prepend(div.firstElementChild);

    document.getElementById('tb-min').addEventListener('click', () => {
      window.__sharkordTitlebar.minimize();
    });
    document.getElementById('tb-max').addEventListener('click', () => {
      window.__sharkordTitlebar.maximize();
    });
    document.getElementById('tb-close').addEventListener('click', () => {
      window.__sharkordTitlebar.close();
    });
  })();
`;

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

  // Screen sharing: provide screen sources for getDisplayMedia()
  ses.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      if (sources.length === 0) {
        callback({});
        return;
      }
      const screenSource = sources.find(s => s.id.startsWith('screen:')) || sources[0];
      // Only pass video — do NOT pass audio to avoid SDP codec collisions
      callback({ video: screenSource });
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
    frame: false,
    icon: getIcon(),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Start with setup page or go straight to Sharkord
  if (config.url && config.url !== DEFAULT_URL) {
    navigateToSharkord(config.url);
  } else {
    isOnSetupPage = true;
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

function navigateToSharkord(url) {
  isOnSetupPage = false;
  mainWindow.loadURL(url);

  // Inject titlebar once the page finishes loading
  mainWindow.webContents.on('did-finish-load', injectTitlebar);
  // Also on in-page navigations
  mainWindow.webContents.on('did-navigate-in-page', injectTitlebar);

  // Open external links in default browser
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

function injectTitlebar() {
  if (!mainWindow || isOnSetupPage) return;
  mainWindow.webContents.insertCSS(TITLEBAR_CSS).catch(() => {});
  mainWindow.webContents.executeJavaScript(TITLEBAR_JS).catch(() => {});
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
  // Request OS-level media access on Windows
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
