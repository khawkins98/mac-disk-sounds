import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
const diskPaths = ['/'];  // Add more paths if needed
let watchers = []; // Keep track of file watchers

function createWindow() {
  // https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    frame: false,
    transparent: true,

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    },
    // resizable: false,
    // titleBarStyle: 'hidden',
    // titleBarOverlay: {
    //   height: 900
    // }

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

  mainWindow.loadFile('index.html');

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  cleanupWatchers();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', () => {
  cleanupWatchers();
});

// Watch disk activity
let lastActivity = Date.now();
const DEBOUNCE_TIME = 50; // ms

diskPaths.forEach(path => {
  try {
    const watcher = fs.watch(path, { recursive: true }, (eventType, filename) => {
      const now = Date.now();
      if (now - lastActivity > DEBOUNCE_TIME && mainWindow) {
        lastActivity = now;
        mainWindow.webContents.send('disk-activity');
      }
    });
    watchers.push(watcher);
  } catch (err) {
    console.error(`Error watching path ${path}:`, err);
  }
});