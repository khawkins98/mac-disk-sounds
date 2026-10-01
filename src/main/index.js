// App lifecycle. Mac Disk Sounds is a tray (menu bar) app:
// - main owns the DiskMonitor and the activity model for the app's whole
//   lifetime, independent of any window;
// - a hidden audio window (src/renderer/audio.html) plays the sounds, so
//   they carry on with no window open;
// - the System 7 settings window (src/renderer/index.html) is created on
//   demand and destroyed when closed;
// - the app quits only from the tray menu (or when the OS asks it to).
import { app, BrowserWindow, ipcMain, powerSaveBlocker, session, shell } from 'electron';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DiskMonitor } from './disk-monitor.js';
import { ActivityModel } from './activity.js';
import { SettingsStore, sanitizePatch } from './settings.js';
import { createLoginItem, wasOpenedAtLogin } from './login-item.js';
import { createTray } from './tray.js';

// ES Module path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.join(__dirname, '..');
const APP_ROOT = path.join(SRC_DIR, '..');
const PRELOAD_FILE = path.join(SRC_DIR, 'preload.cjs');
const SETTINGS_PAGE = path.join(SRC_DIR, 'renderer', 'index.html');
const AUDIO_PAGE = path.join(SRC_DIR, 'renderer', 'audio.html');
const WINDOW_ICON = path.join(APP_ROOT, 'build', 'icon.png');
const TRAY_ICON_DIR = path.join(APP_ROOT, 'assets', 'tray');

const IS_MAC = process.platform === 'darwin';
const ACTIVATE_GRACE_MS = 2000;

// Compare file URL paths decoded, and case-insensitively where the file
// system usually is, so encoding differences between Node and Chromium
// cannot lock our own pages out.
const CASE_INSENSITIVE_FS = process.platform === 'win32' || IS_MAC;
function normaliseFilePath(url) {
  const decoded = decodeURIComponent(url.pathname);
  return CASE_INSENSITIVE_FS ? decoded.toLowerCase() : decoded;
}
const PAGE_PATHS = {
  settings: normaliseFilePath(pathToFileURL(SETTINGS_PAGE)),
  audio: normaliseFilePath(pathToFileURL(AUDIO_PAGE))
};

// Hosts the settings page links to. Anything else is refused.
const EXTERNAL_HOSTS = new Set(['github.com', 'pixabay.com']);
const WINDOW_COMMANDS = new Set(['close', 'minimize']);

// Settings the tray menu shows.
const TRAY_KEYS = ['enabled', 'soundSet', 'launchAtLogin'];

const IDLE = Object.freeze({ active: false, level: 0, readBps: 0, writeBps: 0, totalBps: 0 });

let settingsWindow = null;
let audioWindow = null;
let audioRestartDelay = 1000;
let tray = null;
let store = null;
let loginItem = null;
let monitor = null;
let appNapBlocker = null;
let quitting = false;
let readyAt = Infinity;
// Last known state of the audio window, replayed to a newly opened
// settings window.
let audioStatus = null;
let modemPlaying = false;
const activity = new ActivityModel();

const isLive = (win) => Boolean(win && !win.isDestroyed());
const settingsVisible = () => isLive(settingsWindow) && settingsWindow.isVisible() && !settingsWindow.isMinimized();

function sendTo(win, channel, value) {
  if (isLive(win)) win.webContents.send(channel, value);
}

// The audio window always gets activity; the settings window only while it
// is on screen (it is brought up to date when shown).
function sendActivity(state) {
  sendTo(audioWindow, 'activity', state);
  if (settingsVisible()) sendTo(settingsWindow, 'activity', state);
}

// --- Disk monitor ---

function startMonitor() {
  if (monitor) return;
  // DiskMonitor stamps samples with performance.now(); use the same clock.
  // The warm-up also keeps a re-enable from clicking at the I/O burst of
  // the restart itself.
  activity.reset(performance.now());
  monitor = new DiskMonitor();
  monitor.on('sample', (sample) => {
    const changed = activity.update(sample);
    if (changed) sendActivity(changed);
  });
  monitor.start();
  console.log('Disk monitor started.');
}

function stopMonitor() {
  if (!monitor) return;
  monitor.stop();
  monitor.removeAllListeners();
  monitor = null;
  activity.reset(null);
  sendActivity(IDLE);
  console.log('Disk monitor stopped.');
}

// macOS App Nap throttles timers of apps with no visible window. The audio
// window's click scheduler is a timer, so with the settings window closed
// App Nap could make the clicks lag or stop. Playing audio normally exempts
// an app, but Chromium may close its output stream while everything is
// silent (ambience at 0 and no clicks), so we do not rely on that.
// 'prevent-app-suspension' opts out of App Nap. The trade-off: it also
// counts as activity that keeps the Mac from idle sleep (the display can
// still sleep), so it is held only while sounds are enabled; turning them
// off from the tray releases it. App Nap does not exist elsewhere, so other
// platforms never take the blocker and keep normal idle sleep.
function updateAppNapBlocker(enabled) {
  if (!IS_MAC) return;
  if (enabled && appNapBlocker === null) {
    appNapBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!enabled && appNapBlocker !== null) {
    powerSaveBlocker.stop(appNapBlocker);
    appNapBlocker = null;
  }
}

// Disabled means silent and idle: the monitor stops (no polling, no child
// process), the audio window cancels clicks and fades the ambience out.
function applyEnabled(enabled) {
  if (enabled) {
    startMonitor();
  } else {
    stopMonitor();
  }
  updateAppNapBlocker(enabled);
}

// --- Settings ---

/** Apply a patch from the tray or the settings window; returns the settings. */
function setSettings(patch) {
  const clean = sanitizePatch(patch);
  if (Object.hasOwn(clean, 'launchAtLogin')) {
    try {
      if (!loginItem.supported) throw new Error('not supported here');
      loginItem.set(clean.launchAtLogin);
    } catch (error) {
      console.error('Cannot change launch at login:', error.message);
      delete clean.launchAtLogin;
    }
  }
  store.update(clean);
  // Redraw whenever the patch touched something the menu shows, even if
  // nothing changed: a checkbox Electron already flipped must flip back if
  // the change was refused.
  if (patch && typeof patch === 'object' && TRAY_KEYS.some((key) => Object.hasOwn(patch, key))) {
    tray?.refresh(store.get());
  }
  return store.get();
}

function onSettingsChanged(settings, changed) {
  sendTo(audioWindow, 'settings', settings);
  sendTo(settingsWindow, 'settings', settings);
  if (changed.includes('enabled')) applyEnabled(settings.enabled);
}

// --- Windows ---

const sharedWebPreferences = () => ({
  preload: PRELOAD_FILE,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  spellcheck: false
});

// Neither page navigates, opens windows or embeds anything; links go
// through openExternal.
function lockDown(webContents) {
  webContents.on('will-navigate', (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function createAudioWindow() {
  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    skipTaskbar: true,
    focusable: false,
    paintWhenInitiallyHidden: false,
    webPreferences: {
      ...sharedWebPreferences(),
      // Keep timers and audio scheduling running in a window that is never
      // shown.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  audioWindow = win;
  lockDown(win.webContents);

  // A reload (or the first load) starts from idle; resend the current state.
  win.webContents.on('did-finish-load', () => {
    if (activity.state.active) sendTo(win, 'activity', activity.state);
  });

  // If the renderer dies the sounds stop; bring it back, backing off if it
  // keeps dying.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Audio window renderer gone:', details.reason);
    if (!win.isDestroyed()) win.destroy();
  });
  win.on('closed', () => {
    if (audioWindow === win) audioWindow = null;
    if (quitting) return;
    if (modemPlaying) {
      modemPlaying = false;
      sendTo(settingsWindow, 'modem', { playing: false });
    }
    setTimeout(() => {
      if (!quitting && !audioWindow) createAudioWindow();
    }, audioRestartDelay);
    audioRestartDelay = Math.min(audioRestartDelay * 2, 60000);
  });

  win.loadFile(AUDIO_PAGE).catch((error) => console.error('Cannot load the audio window:', error));
}

function createSettingsWindow() {
  // https://www.electronjs.org/docs/latest/tutorial/custom-window-styles#limitations
  const win = new BrowserWindow({
    width: 400,
    height: 390,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#ffffff',
    webPreferences: sharedWebPreferences(),
    icon: WINDOW_ICON
  });
  settingsWindow = win;
  lockDown(win.webContents);

  // Bring a window that was just shown (or reloaded) up to date.
  const catchUp = () => {
    if (!settingsVisible() || settingsWindow !== win) return;
    sendTo(win, 'activity', activity.state);
    if (audioStatus) sendTo(win, 'audio-status', audioStatus);
    if (modemPlaying) sendTo(win, 'modem', { playing: true });
  };
  win.on('show', catchUp);
  win.on('restore', catchUp);
  win.webContents.on('did-finish-load', catchUp);
  win.once('ready-to-show', () => win.show());

  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
  });

  win.loadFile(SETTINGS_PAGE).catch((error) => console.error('Cannot load the settings window:', error));
}

function showSettingsWindow() {
  if (!isLive(settingsWindow)) {
    createSettingsWindow();
  } else {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
  }
  // With no Dock icon the app is not brought forward on its own.
  if (IS_MAC) app.focus({ steal: true });
}

function toggleSettingsWindow() {
  if (settingsVisible()) {
    settingsWindow.close();
  } else {
    showSettingsWindow();
  }
}

// --- IPC ---

/**
 * Which of our windows sent this: 'settings', 'audio' or null. Only our own
 * pages, loaded in the window made for them, may use the IPC channels.
 */
function senderRole(event) {
  const frameUrl = event.senderFrame?.url;
  if (!frameUrl) return null;
  for (const [role, win] of [['settings', settingsWindow], ['audio', audioWindow]]) {
    if (!isLive(win) || event.sender !== win.webContents) continue;
    try {
      const url = new URL(frameUrl);
      return url.protocol === 'file:' && normaliseFilePath(url) === PAGE_PATHS[role] ? role : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Register a listener that only the given roles may use.
function onMessage(channel, roles, listener) {
  ipcMain.on(channel, (event, ...args) => {
    if (roles.includes(senderRole(event))) listener(...args);
  });
}

function onInvoke(channel, roles, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!roles.includes(senderRole(event))) throw new Error(`${channel}: not allowed`);
    return handler(...args);
  });
}

// Returns the normalised URL if it may be opened, otherwise null.
function allowedExternalUrl(value) {
  try {
    const url = new URL(value);
    const allowed = url.protocol === 'https:' && EXTERNAL_HOSTS.has(url.hostname) &&
      url.port === '' && url.username === '' && url.password === '';
    return allowed ? url.href : null;
  } catch {
    return null;
  }
}

function registerIpc() {
  onInvoke('settings:get', ['settings', 'audio'], () => store.get());
  onInvoke('settings:set', ['settings'], (patch) => setSettings(patch));

  onMessage('window-control', ['settings'], (command) => {
    if (!WINDOW_COMMANDS.has(command)) return;
    // There is no Dock to minimise to on macOS (the Dock icon is hidden),
    // so there the second title bar button closes the window too.
    if (command === 'close' || IS_MAC) {
      settingsWindow.close();
    } else {
      settingsWindow.minimize();
    }
  });

  onMessage('open-external', ['settings'], (url) => {
    const href = allowedExternalUrl(url);
    if (!href) {
      console.warn('Refusing to open external URL:', url);
      return;
    }
    shell.openExternal(href);
  });

  onMessage('modem:play', ['settings'], () => {
    if (store.get().enabled) sendTo(audioWindow, 'modem:command', null);
  });

  onMessage('modem:state', ['audio'], (playing) => {
    modemPlaying = playing === true;
    sendTo(settingsWindow, 'modem', { playing: modemPlaying });
  });

  onMessage('audio:status', ['audio'], (status) => {
    const ok = status?.ok === true;
    audioStatus = { ok };
    if (ok) {
      audioRestartDelay = 1000;
      console.log(`Audio window ready: ${Number(status.buffers)} sound files decoded.`);
    } else {
      console.error('Audio window could not load the sounds:', String(status?.error));
    }
    sendTo(settingsWindow, 'audio-status', audioStatus);
  });
}

// --- Lifecycle ---

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching the app again shows the settings window.
  app.on('second-instance', () => {
    if (app.isReady()) showSettingsWindow();
  });

  app.whenReady().then(() => {
    // The pages need no permissions (audio output is not one).
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    // No Dock icon: this is a menu bar app. Packaged builds also set
    // LSUIElement (package.json), which hides it before launch; this covers
    // development runs.
    if (IS_MAC) app.dock.hide();
    readyAt = performance.now();

    store = new SettingsStore({ file: path.join(app.getPath('userData'), 'settings.json') });
    store.load();
    loginItem = createLoginItem({ app });
    // The OS is the truth for launch at login (the user may have changed it
    // in System Settings).
    if (loginItem.supported) {
      try {
        store.update({ launchAtLogin: loginItem.get() });
      } catch (error) {
        console.warn('Cannot read launch at login:', error.message);
      }
    }
    store.on('change', onSettingsChanged);
    registerIpc();

    createAudioWindow();
    try {
      tray = createTray({
        iconDir: TRAY_ICON_DIR,
        settings: store.get(),
        loginItemSupported: loginItem.supported,
        actions: { setSettings, openSettings: showSettingsWindow, quit: () => app.quit() },
        onClick: toggleSettingsWindow
      });
      console.log('Tray icon created.');
    } catch (error) {
      console.error('Cannot create the tray icon:', error);
    }

    applyEnabled(store.get().enabled);

    // Started by hand: show the window so it is clear the app is running.
    // Started at login: stay in the tray.
    if (!wasOpenedAtLogin({ app })) showSettingsWindow();
  });

  // The app lives in the tray: closing windows never quits it. Having this
  // listener at all stops Electron's default quit.
  app.on('window-all-closed', () => {});

  // macOS: opening the app again from Finder or Spotlight. macOS also
  // sends one 'activate' as the app finishes launching; ignore that one so
  // a start at login stays in the tray (a normal start shows the window
  // anyway).
  app.on('activate', () => {
    if (app.isReady() && performance.now() - readyAt > ACTIVATE_GRACE_MS) showSettingsWindow();
  });

  // A session manager or `kill` ends us with a signal; quit properly so the
  // settings are flushed and the monitor's child process is stopped.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
    stopMonitor();
    updateAppNapBlocker(false);
    store?.flush();
    tray?.destroy();
    tray = null;
  });
}
