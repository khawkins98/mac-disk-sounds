// App lifecycle. Mac Disk Sounds is a tray (menu bar) app:
// - main owns the DiskMonitor and the activity model for the app's whole
//   lifetime, independent of any window;
// - a hidden audio window (src/renderer/audio.html) plays the sounds, so
//   they carry on with no window open;
// - the System 7 settings window (src/renderer/index.html) is created on
//   demand and destroyed when closed;
// - the app quits only from the tray menu (or when the OS asks it to).
import { app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, session, shell } from 'electron';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DiskMonitor } from './disk-monitor.js';
import { ActivityModel } from './activity.js';
import { SettingsStore, sanitizePatch } from './settings.js';
import { HIDDEN_ARG, createLoginItem, wasOpenedAtLogin } from './login-item.js';
import { createTray } from './tray.js';
import { hasStatusNotifierHost, trayFallback } from './tray-host.js';

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
// The app is unsigned and does not update itself: "Check for Updates…"
// opens the latest release in the browser.
// Not /releases/latest: that skips pre-releases, and every alpha is published as one.
const RELEASES_URL = 'https://github.com/khawkins98/mac-disk-sounds/releases';
const WINDOW_COMMANDS = new Set(['close', 'minimize', 'quit']);

// The settings window's size; it is taller when it has to show the
// "no system tray" note.
const SETTINGS_SIZE = { width: 400, height: 390, noTrayExtra: 36 };

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
// No tray icon can be seen (see tray-host.js): the settings window is then
// the only way in, so closing it minimises it, and it offers Quit.
let trayMissing = false;
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
    if (!changed) return;
    // Take the blocker before telling the audio window to click.
    syncAppNapBlocker();
    sendActivity(changed);
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
  syncAppNapBlocker();
  sendActivity(IDLE);
  console.log('Disk monitor stopped.');
}

// macOS App Nap throttles the timers of apps with no visible window, and
// the audio window's click scheduler is a timer. What Chromium already does:
// while a page is audible (and for a short hold-on after), its
// MediaWebContentsObserver takes a "Playing audio" wake lock of type
// kPreventAppSuspension, which on macOS is an IOPMAssertion of type
// NoIdleSleep (power_save_blocker_mac.cc), and apps holding power
// assertions or playing audio are not napped. So whenever the ambience is
// audible, Chromium itself keeps the Mac out of idle sleep; that is
// Chromium's behaviour for any audio and not something we add. (Set the
// ambience to 0 to let the Mac idle-sleep.)
//
// The gap is the silent case: ambience at 0 and the disk idle, then disk
// activity starts and the scheduler must start clicking promptly. So we hold
// our own 'prevent-app-suspension' blocker (the same NoIdleSleep assertion)
// only while sounds are enabled AND the disk is active, i.e. only while
// clicks are being scheduled; it is released as soon as the disk goes idle
// or sounds are turned off. An idle, silent app holds nothing. App Nap does
// not exist elsewhere, so other platforms never take the blocker.
function syncAppNapBlocker() {
  const want = IS_MAC && !quitting && monitor !== null && activity.state.active;
  if (want && appNapBlocker === null) {
    appNapBlocker = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!want && appNapBlocker !== null) {
    powerSaveBlocker.stop(appNapBlocker);
    appNapBlocker = null;
  }
}

// Disabled means silent and idle: the monitor stops (no polling, no child
// process, no App Nap blocker), the audio window cancels clicks, fades the
// ambience out and suspends its AudioContext.
function applyEnabled(enabled) {
  if (enabled) {
    startMonitor();
  } else {
    stopMonitor();
  }
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

// Neither page has anything to spell check. `spellcheck: false` in
// webPreferences only stops the pages checking; the session still loads
// the Hunspell dictionary for the UI language when it is created, and on
// Windows and Linux that means downloading it from redirector.gvt1.com at
// every first start. Clearing the session's languages (before any window
// exists) drops that dictionary and cancels the download; the empty list is
// saved in the session's preferences, so later starts do not ask for one at
// all. On macOS the system spell checker is used and the language call is a
// no-op.
function disableSpellChecker(ses) {
  try {
    ses.setSpellCheckerEnabled(false);
    if (!IS_MAC) ses.setSpellCheckerLanguages([]);
  } catch (error) {
    console.warn('Cannot turn off the spell checker:', error.message);
  }
}

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
  // Same for a page that failed to load (-3 is an aborted load, e.g. one
  // replaced by a reload, which is not a failure).
  win.webContents.on('did-fail-load', (_event, errorCode, description, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    console.error('Audio window failed to load:', errorCode, description);
    if (!win.isDestroyed()) win.destroy();
  });
  // Windows shutdown or logoff does not emit before-quit; save settings now.
  win.on('session-end', () => store?.flush());
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
    width: SETTINGS_SIZE.width,
    height: SETTINGS_SIZE.height + (trayMissing ? SETTINGS_SIZE.noTrayExtra : 0),
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
    sendTo(win, 'tray-status', { missing: trayMissing });
  };
  win.on('show', catchUp);
  win.on('restore', catchUp);
  win.webContents.on('did-finish-load', catchUp);
  win.once('ready-to-show', () => {
    win.show();
    // With no Dock icon, macOS does not bring a new window forward on its own.
    if (IS_MAC) {
      app.focus({ steal: true });
      win.focus();
    }
  });

  // A crashed settings page is useless; drop the window so the next show
  // creates a fresh one.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Settings window renderer gone:', details.reason);
    if (!win.isDestroyed()) win.destroy();
  });

  // With no tray to come back from, closing (from the title bar or the
  // window manager) minimises instead; Quit is in the window.
  win.on('close', (event) => {
    if (!trayMissing || quitting) return;
    event.preventDefault();
    win.minimize();
  });

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

// Open a link in the default browser, if it is allowed.
function openExternal(url) {
  const href = allowedExternalUrl(url);
  if (!href) {
    console.warn('Refusing to open external URL:', url);
    return;
  }
  shell.openExternal(href).catch((error) => console.error('Cannot open', href, error.message));
}

function registerIpc() {
  onInvoke('settings:get', ['settings', 'audio'], () => store.get());
  // Once quitting has begun, changes would not be saved reliably; ignore them.
  onInvoke('settings:set', ['settings'], (patch) => (quitting ? store.get() : setSettings(patch)));

  onMessage('window-control', ['settings'], (command) => {
    if (!WINDOW_COMMANDS.has(command)) return;
    // Quit is only offered in the window when there is no tray menu.
    if (command === 'quit') {
      if (trayMissing) app.quit();
      return;
    }
    // There is no Dock to minimise to on macOS (the Dock icon is hidden),
    // so there the second title bar button closes the window too.
    if (command === 'close' || IS_MAC) {
      settingsWindow.close();
    } else {
      settingsWindow.minimize();
    }
  });

  onMessage('open-external', ['settings'], openExternal);

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
  // Launching the app again shows the settings window, unless it is the
  // login item starting while we already run.
  app.on('second-instance', (_event, argv) => {
    if (app.isReady() && !argv.includes(HIDDEN_ARG)) showSettingsWindow();
  });

  app.whenReady().then(async () => {
    // The pages need no permissions (audio output is not one).
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    disableSpellChecker(session.defaultSession);
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
        if (loginItem.repair()) console.log('Launch at login entry updated to this copy of the app.');
        store.update({ launchAtLogin: loginItem.get() });
      } catch (error) {
        console.warn('Cannot read launch at login:', error.message);
      }
    }
    store.on('change', onSettingsChanged);
    // macOS and Linux shutdown or logoff; may come without before-quit.
    powerMonitor.on('shutdown', () => store.flush());
    registerIpc();

    createAudioWindow();
    try {
      tray = createTray({
        iconDir: TRAY_ICON_DIR,
        settings: store.get(),
        loginItemSupported: loginItem.supported,
        version: app.getVersion(),
        actions: {
          setSettings,
          openSettings: showSettingsWindow,
          checkForUpdates: () => openExternal(RELEASES_URL),
          quit: () => app.quit()
        },
        onClick: toggleSettingsWindow
      });
      console.log('Tray icon created.');
    } catch (error) {
      console.error('Cannot create the tray icon:', error);
    }

    applyEnabled(store.get().enabled);

    // On Linux the icon only shows if a StatusNotifierItem host is running.
    // Find out before showing the window, so it can be sized for the note.
    const hasHost = tray && process.platform === 'linux' ? await hasStatusNotifierHost() : null;
    trayMissing = trayFallback({ platform: process.platform, trayCreated: tray !== null, hasHost }).trayMissing;
    if (trayMissing) {
      console.warn('No system tray to show the icon in: closing the settings window will minimise it.');
    }

    // Started by hand: show the window so it is clear the app is running.
    // Started at login: stay in the tray (or, with no tray, out of sight:
    // starting the app again shows the window).
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
    syncAppNapBlocker();
    store?.flush();
    tray?.destroy();
    tray = null;
  });
}
