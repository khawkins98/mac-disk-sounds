import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import si from 'systeminformation';

// ES Module path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let diskMonitorInterval = null;

async function monitorDiskIO() {
  try {
    const fsStats = await si.fsStats();
    if (mainWindow) {
      // Send both read and write speeds
      mainWindow.webContents.send('disk-activity', {
        type: fsStats.rx_sec > fsStats.wx_sec ? 'read' : 'write',
        speed: Math.max(fsStats.rx_sec, fsStats.wx_sec)
      });
    }
  } catch (error) {
    console.error('Error monitoring disk I/O:', error);
  }
}

async function createWindow() {
  // Garbage collect before creating window
  if (global.gc) global.gc();

  // https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations
  mainWindow = new BrowserWindow({
    width: 400,
    height: 280,
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

  // Start disk I/O monitoring
  diskMonitorInterval = setInterval(monitorDiskIO, 1000); // Check every second

  // Handle window focus events
  mainWindow.on('focus', () => {
    mainWindow.webContents.send('window-focus-change', true);
  });

  mainWindow.on('blur', () => {
    mainWindow.webContents.send('window-focus-change', false);
  });

  // Optimize memory usage
  mainWindow.webContents.setBackgroundThrottling(true);

  // Clean up when window is closed
  mainWindow.on('closed', () => {
    if (diskMonitorInterval) {
      clearInterval(diskMonitorInterval);
      diskMonitorInterval = null;
    }
    mainWindow = null;
  });
}

// Handle window control messages
ipcMain.on('window-control', (event, command) => {
  if (!mainWindow) return;

  switch (command) {
    case 'close':
      if (diskMonitorInterval) {
        clearInterval(diskMonitorInterval);
        diskMonitorInterval = null;
      }
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
  if (diskMonitorInterval) {
    clearInterval(diskMonitorInterval);
    diskMonitorInterval = null;
  }
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
  if (diskMonitorInterval) {
    clearInterval(diskMonitorInterval);
    diskMonitorInterval = null;
  }
});