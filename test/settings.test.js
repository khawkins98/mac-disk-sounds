import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  SOUND_SETS,
  SettingsStore,
  isOrphanTempFile,
  mergeWithDefaults,
  sanitizePatch,
  writeJsonAtomicSync
} from '../src/main/settings.js';

const quietLogger = () => {
  const calls = [];
  return { calls, warn: (...a) => calls.push(['warn', a.join(' ')]), error: (...a) => calls.push(['error', a.join(' ')]) };
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mds-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('defaults are valid and use a known sound set', () => {
  assert.deepEqual(sanitizePatch(DEFAULT_SETTINGS), { ...DEFAULT_SETTINGS });
  assert.ok(Object.hasOwn(SOUND_SETS, DEFAULT_SETTINGS.soundSet));
});

test('sanitizePatch keeps valid known keys only', () => {
  assert.deepEqual(sanitizePatch({
    enabled: false,
    soundSet: 'ibm',
    clickVolume: 0,
    ambienceVolume: 1,
    launchAtLogin: true,
    extra: 'dropped'
  }), { enabled: false, soundSet: 'ibm', clickVolume: 0, ambienceVolume: 1, launchAtLogin: true });
});

test('sanitizePatch rejects wrong types, out-of-range volumes and unknown sound sets', () => {
  assert.deepEqual(sanitizePatch({
    enabled: 'yes',
    soundSet: 'toString',
    clickVolume: 1.5,
    ambienceVolume: -0.1,
    launchAtLogin: 1
  }), {});
  assert.deepEqual(sanitizePatch({ clickVolume: NaN, ambienceVolume: Infinity, soundSet: 'nope' }), {});
  assert.deepEqual(sanitizePatch({ clickVolume: '0.5' }), {});
});

test('sanitizePatch ignores non-objects and inherited keys', () => {
  for (const value of [null, undefined, 42, 'enabled', [true], true]) {
    assert.deepEqual(sanitizePatch(value), {});
  }
  assert.deepEqual(sanitizePatch(Object.create({ enabled: false })), {});
  // A JSON "__proto__" key is an own property; it must not leak through.
  assert.deepEqual(sanitizePatch(JSON.parse('{"__proto__": {"enabled": false}}')), {});
});

test('mergeWithDefaults fills in missing and invalid values', () => {
  assert.deepEqual(mergeWithDefaults({ soundSet: 'ibm', clickVolume: 7 }), { ...DEFAULT_SETTINGS, soundSet: 'ibm' });
  assert.deepEqual(mergeWithDefaults(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(mergeWithDefaults([]), { ...DEFAULT_SETTINGS });
});

test('load: a missing file means defaults and a first run', (t) => {
  const dir = tempDir(t);
  const store = new SettingsStore({ file: path.join(dir, 'settings.json'), logger: quietLogger() });
  assert.deepEqual(store.load(), { ...DEFAULT_SETTINGS });
  assert.equal(store.isNew, true);
});

test('load: corrupt JSON means defaults, with a warning', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"enabled": fal');
  const logger = quietLogger();
  const store = new SettingsStore({ file, logger });
  assert.deepEqual(store.load(), { ...DEFAULT_SETTINGS });
  assert.equal(store.isNew, false);
  assert.equal(logger.calls[0][0], 'warn');
});

test('load: valid values are kept, invalid ones replaced by defaults', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: false, soundSet: 'floppy', ambienceVolume: 0.5 }));
  const store = new SettingsStore({ file, logger: quietLogger() });
  assert.deepEqual(store.load(), { ...DEFAULT_SETTINGS, enabled: false, ambienceVolume: 0.5 });
});

test('update applies valid changes, emits change with the changed keys, and get() is a copy', (t) => {
  const dir = tempDir(t);
  const store = new SettingsStore({ file: path.join(dir, 'settings.json'), debounceMs: 10000, logger: quietLogger() });
  t.after(() => clearTimeout(store.timer));
  store.load();
  const events = [];
  store.on('change', (settings, changed) => events.push([settings, changed]));

  assert.deepEqual(store.update({ enabled: false, clickVolume: 2, soundSet: 'generic' }), ['enabled']);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], ['enabled']);
  assert.equal(events[0][0].enabled, false);

  // Nothing valid changed: no event.
  assert.deepEqual(store.update({ enabled: false, bogus: 1 }), []);
  assert.equal(events.length, 1);

  const copy = store.get();
  copy.enabled = true;
  assert.equal(store.get().enabled, false);
});

test('writes are debounced into one atomic write', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'nested', 'settings.json');
  const store = new SettingsStore({ file, debounceMs: 30, logger: quietLogger() });
  store.load();
  store.update({ clickVolume: 0.1 });
  store.update({ clickVolume: 0.2 });
  store.update({ clickVolume: 0.3 });
  assert.equal(fs.existsSync(file), false, 'nothing written before the debounce');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(readJson(file), { ...DEFAULT_SETTINGS, clickVolume: 0.3 });
  // No temp files left behind.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
});

test('flush writes pending changes at once and a new store reads them back', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore({ file, debounceMs: 10000, logger: quietLogger() });
  store.load();
  store.update({ soundSet: 'ibm', launchAtLogin: true });
  store.flush();
  assert.equal(store.timer, null);
  const again = new SettingsStore({ file, logger: quietLogger() });
  assert.deepEqual(again.load(), { ...DEFAULT_SETTINGS, soundSet: 'ibm', launchAtLogin: true });
  assert.equal(again.isNew, false);
});

test('flush with nothing pending does not write', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  const store = new SettingsStore({ file, logger: quietLogger() });
  store.load();
  store.flush();
  assert.equal(fs.existsSync(file), false);
});

test('writeJsonAtomicSync writes and fsyncs a temp file, then renames it into place', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old');
  const ops = [];
  const fds = new Map();
  const spyFs = {
    ...fs,
    openSync: (target, ...rest) => {
      const fd = fs.openSync(target, ...rest);
      fds.set(fd, path.basename(target));
      ops.push(['open', path.basename(target)]);
      return fd;
    },
    fsyncSync: (fd) => {
      ops.push(['fsync', fds.get(fd)]);
      return fs.fsyncSync(fd);
    },
    closeSync: (fd) => {
      ops.push(['close', fds.get(fd)]);
      return fs.closeSync(fd);
    },
    renameSync: (from, to) => {
      ops.push(['rename', path.basename(from), path.basename(to)]);
      return fs.renameSync(from, to);
    }
  };
  writeJsonAtomicSync(file, { a: 1 }, spyFs);
  const temp = `settings.json.${process.pid}.tmp`;
  assert.deepEqual(ops, [['open', temp], ['fsync', temp], ['close', temp], ['rename', temp, 'settings.json']]);
  assert.deepEqual(readJson(file), { a: 1 });
});

test('load strips a UTF-8 byte order mark', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '\uFEFF{"soundSet": "ibm"}');
  const store = new SettingsStore({ file, logger: quietLogger() });
  assert.deepEqual(store.load(), { ...DEFAULT_SETTINGS, soundSet: 'ibm' });
});

test('load removes temp files left by a crash mid-write, and nothing else', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  for (const name of ['settings.json', 'settings.json.123.tmp', 'settings.json.9.tmp', 'settings.json.bak', 'other.json.5.tmp', 'settings.json.x.tmp']) {
    fs.writeFileSync(path.join(dir, name), '{}');
  }
  new SettingsStore({ file, logger: quietLogger() }).load();
  assert.deepEqual(fs.readdirSync(dir).sort(), ['other.json.5.tmp', 'settings.json', 'settings.json.bak', 'settings.json.x.tmp']);
  assert.equal(isOrphanTempFile(file, 'settings.json.42.tmp'), true);
  assert.equal(isOrphanTempFile(file, 'settings.json.tmp'), false);
});

test('a failed rename keeps the old file and removes the temp file', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"enabled": true}');
  const failingFs = {
    ...fs,
    renameSync: () => {
      throw new Error('disk full');
    }
  };
  assert.throws(() => writeJsonAtomicSync(file, { enabled: false }, failingFs), /disk full/);
  assert.deepEqual(readJson(file), { enabled: true });
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
});

test('a failed write is logged once and retried until it succeeds', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'settings.json');
  const logger = quietLogger();
  let failuresLeft = 2;
  const flakyFs = {
    ...fs,
    renameSync: (from, to) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('read-only');
      }
      return fs.renameSync(from, to);
    }
  };
  const store = new SettingsStore({ file, debounceMs: 10, fs: flakyFs, logger });
  t.after(() => clearTimeout(store.timer));
  store.load();
  store.update({ enabled: false });
  assert.doesNotThrow(() => store.flush());
  assert.equal(store.dirty, true);
  assert.notEqual(store.timer, null, 'a retry is scheduled');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(store.dirty, false);
  assert.equal(readJson(file).enabled, false);
  assert.equal(logger.calls.filter(([level]) => level === 'error').length, 1);
});
