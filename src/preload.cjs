// Sandboxed preload, shared by the settings window and the hidden audio
// window. It must be CommonJS: with "type": "module" in package.json a
// sandboxed preload cannot be an ES module. Everything a page may ask of the
// main process goes through these functions; main checks which window is
// asking, refuses channels that window has no business using, and validates
// every argument again.
const { contextBridge, ipcRenderer } = require('electron');

// Subscribe `callback` to pushes on `channel`; returns an unsubscribe function.
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError(`${channel}: expected a function`);
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('diskSounds', {
  /**
   * Disk activity: {active, level, readBps, writeBps, totalBps}. Called when
   * the active/idle state or the 0-5 level changes, and while active about
   * once a second with fresh rates.
   */
  onActivity: (callback) => subscribe('activity', callback),

  /** Resolves to {enabled, soundSet, clickVolume, ambienceVolume, launchAtLogin}. */
  getSettings: () => ipcRenderer.invoke('settings:get'),

  /** Change some settings (settings window only). Resolves to the new settings. */
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  /** Called with the full settings whenever they change, from anywhere. */
  onSettings: (callback) => subscribe('settings', callback),

  // --- Settings window ---

  /** 'close' or 'minimize'. */
  windowControl: (command) => ipcRenderer.send('window-control', String(command)),

  /** Open an allowlisted https URL in the default browser. */
  openExternal: (url) => ipcRenderer.send('open-external', String(url)),

  /** Ask the audio window to play the dial-up easter egg. */
  playModem: () => ipcRenderer.send('modem:play'),

  /** Called with {playing} when the dial-up clip starts and stops. */
  onModem: (callback) => subscribe('modem', callback),

  /** Called with {ok} once the audio window has loaded its sounds (or failed). */
  onAudioStatus: (callback) => subscribe('audio-status', callback),

  // --- Audio window ---

  /** Called when the settings window asked for the dial-up clip. */
  onModemCommand: (callback) => subscribe('modem:command', callback),

  /** Report that the dial-up clip started (true) or ended (false). */
  reportModem: (playing) => ipcRenderer.send('modem:state', Boolean(playing)),

  /** Report {ok, buffers?, error?} after loading the sounds. */
  reportAudioStatus: (status) => ipcRenderer.send('audio:status', status)
});
