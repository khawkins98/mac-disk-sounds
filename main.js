import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DiskMonitor } from './disk-monitor.js';
import { ActivityModel } from './activity.js';

// ES Module path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Compare file URL paths decoded, and case-insensitively where the file
// system usually is, so encoding differences between Node and Chromium
// cannot lock our own page out.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
function normaliseFilePath(url) {
  const decoded = decodeURIComponent(url.pathname);
  return CASE_INSENSITIVE_FS ? decoded.toLowerCase() : decoded;
}
const INDEX_PATH = normaliseFilePath(pathToFileURL(path.join(__dirname, 'index.html')));

// Hosts the page links to (index.html). Anything else is refused.
const EXTERNAL_HOSTS = new Set(['github.com', 'pixabay.com']);
const WINDOW_COMMANDS = new Set(['close', 'minimize']);

let mainWindow = null;
let monitor = null;
const activity = new ActivityModel();

function sendActivity(state) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('activity', state);
  }
}

function startMonitor() {
  if (monitor) return;
  activity.reset(Date.now());
  monitor = new DiskMonitor();
  monitor.on('sample', (sample) => {
    const changed = activity.update(sample);
    if (changed) sendActivity(changed);
  });
  monitor.start();
}

function stopMonitor() {
  if (!monitor) return;
  monitor.stop();
  monitor.removeAllListeners();
  monitor = null;
}

// Only our own page, in our own window, may use the IPC channels.
function isTrustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl) return false;
  try {
    const url = new URL(frameUrl);
    return url.protocol === 'file:' && normaliseFilePath(url) === INDEX_PATH;
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && EXTERNAL_HOSTS.has(url.hostname) &&
      url.port === '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

async function createWindow() {
  // https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations
  mainWindow = new BrowserWindow({
    width: 400,
    height: 280,
    frame: false,
    transparent: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The window hosts the audio; keep timers and audio scheduling running
      // when it is hidden or occluded.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    },
    icon: path.join(__dirname, 'icon.iconset', 'icon_256x256.png')
  });

  const { webContents } = mainWindow;

  // The page never navigates or opens windows; links go through openExternal.
  webContents.on('will-navigate', (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // A reload (or the first load) starts from idle; resend the current state.
  webContents.on('did-finish-load', () => {
    if (activity.state.active) sendActivity(activity.state);
  });

  mainWindow.on('closed', () => {
    stopMonitor();
    mainWindow = null;
  });

  await mainWindow.loadFile('index.html');

  // The window may have been closed while it was loading.
  if (mainWindow) startMonitor();
}

ipcMain.on('window-control', (event, command) => {
  if (!isTrustedSender(event) || !WINDOW_COMMANDS.has(command)) return;
  if (command === 'close') {
    mainWindow.close();
  } else {
    mainWindow.minimize();
  }
});

ipcMain.on('open-external', (event, url) => {
  if (!isTrustedSender(event)) return;
  if (!isAllowedExternalUrl(url)) {
    console.warn('Refusing to open external URL:', url);
    return;
  }
  shell.openExternal(url);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    stopMonitor();
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (!mainWindow) {
      createWindow();
    }
  });

  app.on('before-quit', stopMonitor);
}
