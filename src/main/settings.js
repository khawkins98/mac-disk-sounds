// User settings: one small JSON file in the app's userData directory.
// Pure Node (no Electron), so it can be tested against a temp directory.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// Click sets the renderer knows how to play (src/renderer/audio.js
// CLICK_SETS), with the labels the tray menu and settings window show.
export const SOUND_SETS = Object.freeze({
  generic: 'Computer Hard Drive Access',
  ibm: 'IBM Hard Drive (1999)'
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  soundSet: 'generic',
  // 0..1. The settings window shows these as 0-7 sliders.
  clickVolume: 4 / 7,
  ambienceVolume: 2 / 7,
  launchAtLogin: false
});

const isVolume = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

const VALIDATORS = {
  enabled: (value) => typeof value === 'boolean',
  soundSet: (value) => typeof value === 'string' && Object.hasOwn(SOUND_SETS, value),
  clickVolume: isVolume,
  ambienceVolume: isVolume,
  launchAtLogin: (value) => typeof value === 'boolean'
};

/**
 * The valid, known keys of `patch`; everything else is dropped. Returns {}
 * for anything that is not a plain object.
 */
export function sanitizePatch(patch) {
  const clean = {};
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clean;
  for (const [key, isValid] of Object.entries(VALIDATORS)) {
    if (Object.hasOwn(patch, key) && isValid(patch[key])) clean[key] = patch[key];
  }
  return clean;
}

/** Defaults overlaid with whatever is valid in `stored`. */
export function mergeWithDefaults(stored) {
  return { ...DEFAULT_SETTINGS, ...sanitizePatch(stored) };
}

/**
 * Write `data` as JSON to `file` atomically: write a temporary file next to
 * it, fsync it, then rename it over the target, so a crash or power cut
 * mid-write leaves either the old file or the new one, never half of one.
 */
export function writeJsonAtomicSync(file, data, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    const fd = fsImpl.openSync(temp, 'w', 0o600);
    try {
      fsImpl.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
      fsImpl.fsyncSync(fd);
    } finally {
      fsImpl.closeSync(fd);
    }
    fsImpl.renameSync(temp, file);
  } catch (error) {
    try {
      fsImpl.rmSync(temp, { force: true });
    } catch {
      // Nothing more to do.
    }
    throw error;
  }
}

/** Temp files writeJsonAtomicSync leaves behind if the app dies mid-write. */
export function isOrphanTempFile(file, name) {
  const base = path.basename(file);
  return name.startsWith(`${base}.`) && name.endsWith('.tmp') && /^\d+$/.test(name.slice(base.length + 1, -4));
}

/**
 * Holds the current settings, persists them, and emits `change` with
 * (settings, changedKeys) whenever update() changes something.
 *
 * Writes are debounced: a burst of updates (a slider being dragged) becomes
 * one write `debounceMs` after the last of them. flush() writes any pending
 * change at once (call it before quitting); a write that fails is retried
 * `debounceMs` later.
 */
export class SettingsStore extends EventEmitter {
  constructor({ file, debounceMs = 500, fs: fsImpl = fs, logger = console }) {
    super();
    this.file = file;
    this.debounceMs = debounceMs;
    this.fs = fsImpl;
    this.logger = logger;
    this.timer = null;
    this.dirty = false;
    this.failing = false;
    // True when there was no settings file yet (first run).
    this.isNew = false;
    this.settings = { ...DEFAULT_SETTINGS };
  }

  /** Read the file. A missing or unreadable file means defaults. */
  load() {
    this.#removeOrphanTempFiles();
    let text;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn('Cannot read settings; using defaults.', error.message);
      this.isNew = error.code === 'ENOENT';
      this.settings = { ...DEFAULT_SETTINGS };
      return this.get();
    }
    try {
      // Strip a UTF-8 byte order mark (an editor may add one).
      this.settings = mergeWithDefaults(JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch (error) {
      this.logger.warn('Settings file is not valid JSON; using defaults.', error.message);
      this.settings = { ...DEFAULT_SETTINGS };
    }
    return this.get();
  }

  get() {
    return { ...this.settings };
  }

  /**
   * Apply the valid parts of `patch`. Returns the keys that changed (empty
   * if nothing did).
   */
  update(patch) {
    const clean = sanitizePatch(patch);
    const changed = Object.keys(clean).filter((key) => clean[key] !== this.settings[key]);
    if (changed.length === 0) return changed;
    this.settings = { ...this.settings, ...clean };
    this.dirty = true;
    this.#schedule();
    this.emit('change', this.get(), changed);
    return changed;
  }

  /** Write now if anything is pending. Never throws; logs instead. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    try {
      writeJsonAtomicSync(this.file, this.settings, this.fs);
      this.dirty = false;
      this.failing = false;
    } catch (error) {
      // Log the first failure of a run, then keep retrying quietly.
      if (!this.failing) this.logger.error('Cannot save settings; will retry.', error);
      this.failing = true;
      this.#schedule();
    }
  }

  #schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
  }

  #removeOrphanTempFiles() {
    let names;
    try {
      names = this.fs.readdirSync(path.dirname(this.file));
    } catch {
      return;
    }
    for (const name of names) {
      if (!isOrphanTempFile(this.file, name)) continue;
      try {
        this.fs.rmSync(path.join(path.dirname(this.file), name), { force: true });
      } catch {
        // Harmless; try again next time.
      }
    }
  }
}
