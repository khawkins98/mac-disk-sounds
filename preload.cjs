// Sandboxed preload. It must be CommonJS: with "type": "module" in
// package.json a sandboxed preload cannot be an ES module. Everything the
// page may ask of the main process goes through these three functions, and
// main validates every argument again.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diskSounds', {
  /**
   * Subscribe to disk activity changes. The callback receives
   * {active, level, readBps, writeBps, totalBps}; it is called only when the
   * active/idle state or the 0-5 level changes. Returns an unsubscribe
   * function.
   */
  onActivity(callback) {
    if (typeof callback !== 'function') throw new TypeError('onActivity expects a function');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('activity', listener);
    return () => ipcRenderer.removeListener('activity', listener);
  },

  /** 'close' or 'minimize'. */
  windowControl(command) {
    ipcRenderer.send('window-control', String(command));
  },

  /** Open an allowlisted https URL in the default browser. */
  openExternal(url) {
    ipcRenderer.send('open-external', String(url));
  }
});
