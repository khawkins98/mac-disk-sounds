import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// ES Module path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
const diskPaths = ['/'];  // Add more paths if needed
let watchers = []; // Keep track of file watchers

async function createWindow() {
  // Garbage collect before creating window
  if (global.gc) global.gc();

  // https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations
  mainWindow = new BrowserWindow({
    width: 400,
    height: 320,
    frame: false,
    transparent: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      // Reduce memory usage
      enableWebSQL: false,
      spellcheck: false,
      backgroundThrottling: true
    },
    icon: path.join(__dirname, 'icon', 'hdd-icon.jpg')
  });

  // Enable loading of ES modules
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ['script-src \'self\' \'unsafe-inline\' \'unsafe-eval\'']
      }
    });
  });

  await mainWindow.loadFile('index.html');

  // Optimize memory usage
  mainWindow.webContents.setBackgroundThrottling(true);

  // Clean up watchers when window is closed
  mainWindow.on('closed', () => {
    cleanupWatchers();
    mainWindow = null;
  });
}

// Function to clean up file watchers
function cleanupWatchers() {
  watchers.forEach(watcher => {
    try {
      watcher.close();
    } catch (err) {
      console.error('Error closing watcher:', err);
    }
  });
  watchers = [];
}

// Handle window control messages
ipcMain.on('window-control', (event, command) => {
  if (!mainWindow) return;

  switch (command) {
    case 'close':
      mainWindow.close();
      break;
    case 'minimize':
      mainWindow.minimize();
      break;
  }
});

// Optimize app lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  cleanupWatchers();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow) {
    createWindow();
  }
});

app.on('before-quit', () => {
  cleanupWatchers();
});

// Watch disk activity with optimized debouncing
let lastActivity = Date.now();
const DEBOUNCE_TIME = 50; // ms

diskPaths.forEach(diskPath => {
  try {
    const watcher = fs.watch(diskPath, { recursive: true }, (eventType, filename) => {
      const now = Date.now();
      if (now - lastActivity > DEBOUNCE_TIME && mainWindow) {
        lastActivity = now;
        mainWindow.webContents.send('disk-activity');
      }
    });
    watchers.push(watcher);
  } catch (err) {
    console.error(`Error watching path ${diskPath}:`, err);
  }
});