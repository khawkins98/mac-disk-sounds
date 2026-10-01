import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import si from 'systeminformation';

// ES Module path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let diskMonitorInterval = null;
let fsStatsUnavailableLogged = false;

async function monitorDiskIO() {
  try {
    const fsStats = await si.fsStats();

    // systeminformation returns null on platforms it does not support
    // (notably Windows). Log that once rather than on every tick.
    if (!fsStats) {
      if (!fsStatsUnavailableLogged) {
        fsStatsUnavailableLogged = true;
        console.warn(`Disk I/O statistics are not available on ${process.platform}; no disk sounds will play.`);
      }
      return;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      // The first sample after start has null rates; treat them as 0.
      mainWindow.webContents.send('disk-activity', {
        readBps: fsStats.rx_sec ?? 0,
        writeBps: fsStats.wx_sec ?? 0
      });
    }
  } catch (error) {
    console.error('Error monitoring disk I/O:', error);
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
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
      backgroundThrottling: true
    },
    icon: path.join(__dirname, 'icon.iconset', 'icon_256x256.png')
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