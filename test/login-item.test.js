import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HIDDEN_ARG,
  autostartDesktopEntry,
  autostartDir,
  createLoginItem,
  quoteExecArg,
  wasOpenedAtLogin
} from '../src/main/login-item.js';

function fakeApp({ isPackaged = true, openAtLogin = false, wasOpenedAtLogin: atLogin = false } = {}) {
  const calls = [];
  return {
    calls,
    isPackaged,
    getLoginItemSettings: (options) => {
      calls.push(['get', options]);
      return { openAtLogin, wasOpenedAtLogin: atLogin };
    },
    setLoginItemSettings: (options) => calls.push(['set', options])
  };
}

test('quoteExecArg quotes, escapes, then doubles backslashes for the string layer', () => {
  assert.equal(quoteExecArg('/opt/Mac Disk Sounds/mac-disk-sounds'), '"/opt/Mac Disk Sounds/mac-disk-sounds"');
  // Quoting layer: \" \$ \` \\ ; string layer then doubles every backslash.
  assert.equal(quoteExecArg('/a"b'), '"/a\\\\"b"');
  assert.equal(quoteExecArg('/a$b'), '"/a\\\\$b"');
  assert.equal(quoteExecArg('/a`b'), '"/a\\\\`b"');
  assert.equal(quoteExecArg('/a\\b'), '"/a\\\\\\\\b"');
});

test('quoteExecArg refuses a % in the path', () => {
  assert.throws(() => quoteExecArg('/opt/100%/app'), /not supported/);
});

test('autostartDesktopEntry starts the app hidden', () => {
  const entry = autostartDesktopEntry('/home/me/Apps/Mac Disk Sounds.AppImage');
  assert.match(entry, /^\[Desktop Entry\]\n/);
  assert.match(entry, /\nType=Application\n/);
  assert.match(entry, new RegExp(`\\nExec="/home/me/Apps/Mac Disk Sounds.AppImage" ${HIDDEN_ARG}\\n`));
  assert.ok(entry.endsWith('\n'));
});

test('autostartDir honours an absolute XDG_CONFIG_HOME only', () => {
  assert.equal(autostartDir({}, '/home/me'), '/home/me/.config/autostart');
  assert.equal(autostartDir({ XDG_CONFIG_HOME: '/cfg' }, '/home/me'), '/cfg/autostart');
  assert.equal(autostartDir({ XDG_CONFIG_HOME: 'relative' }, '/home/me'), '/home/me/.config/autostart');
});

test('not offered in development (unpackaged) builds', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const item = createLoginItem({ app: fakeApp({ isPackaged: false }), platform });
    assert.equal(item.supported, false);
    assert.equal(item.get(), false);
  }
});

test('not offered on other platforms', () => {
  assert.equal(createLoginItem({ app: fakeApp(), platform: 'freebsd' }).supported, false);
});

test('macOS and Windows use the login item API; Windows passes --hidden', () => {
  const mac = fakeApp({ openAtLogin: true });
  const macItem = createLoginItem({ app: mac, platform: 'darwin' });
  assert.equal(macItem.supported, true);
  assert.equal(macItem.get(), true);
  macItem.set(false);
  assert.deepEqual(mac.calls.at(-1), ['set', { openAtLogin: false }]);
  assert.equal(macItem.repair(), false);

  const win = fakeApp();
  const winItem = createLoginItem({ app: win, platform: 'win32', env: {} });
  winItem.get();
  winItem.set(true);
  assert.deepEqual(win.calls, [['get', { args: [HIDDEN_ARG] }], ['set', { args: [HIDDEN_ARG], openAtLogin: true }]]);
});

test('the Windows portable build registers the portable .exe, not its temp copy', () => {
  const win = fakeApp();
  const item = createLoginItem({ app: win, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Tools\\MDS.exe' } });
  item.get();
  item.set(true);
  const expected = { args: [HIDDEN_ARG], path: 'D:\\Tools\\MDS.exe' };
  assert.deepEqual(win.calls, [['get', expected], ['set', { ...expected, openAtLogin: true }]]);
});

test('Linux writes and removes an autostart entry', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mds-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const item = createLoginItem({ app: fakeApp(), platform: 'linux', env: { APPIMAGE: '/apps/mds.AppImage' }, home });
  const file = path.join(home, '.config', 'autostart', 'mac-disk-sounds.desktop');

  assert.equal(item.supported, true);
  assert.equal(item.get(), false);
  item.set(true);
  assert.equal(item.get(), true);
  assert.match(fs.readFileSync(file, 'utf8'), /\nExec="\/apps\/mds.AppImage" --hidden\n/);
  item.set(false);
  assert.equal(item.get(), false);
  assert.equal(fs.existsSync(file), false);
  // Removing twice is fine.
  item.set(false);
});

test('Linux repair points a stale entry at the current executable', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mds-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.config', 'autostart', 'mac-disk-sounds.desktop');
  const at = (appimage) => createLoginItem({ app: fakeApp(), platform: 'linux', env: { APPIMAGE: appimage }, home });

  // No entry: nothing to repair, and none is created.
  assert.equal(at('/apps/mds-1.0.AppImage').repair(), false);
  assert.equal(fs.existsSync(file), false);

  at('/apps/mds-1.0.AppImage').set(true);
  assert.equal(at('/apps/mds-1.0.AppImage').repair(), false, 'up to date');

  // After an update the new AppImage has a new name.
  assert.equal(at('/apps/mds-1.1.AppImage').repair(), true);
  assert.match(fs.readFileSync(file, 'utf8'), /\nExec="\/apps\/mds-1.1.AppImage" --hidden\n/);
  assert.equal(at('/apps/mds-1.1.AppImage').repair(), false);
});

test('Linux launch at login is not offered for a path with %', () => {
  const item = createLoginItem({ app: fakeApp(), platform: 'linux', env: {}, execPath: '/opt/100%/app', home: '/nonexistent' });
  assert.equal(item.supported, false);
});

test('wasOpenedAtLogin: --hidden anywhere, or macOS says so', () => {
  assert.equal(wasOpenedAtLogin({ app: fakeApp(), platform: 'linux', argv: ['app', HIDDEN_ARG] }), true);
  assert.equal(wasOpenedAtLogin({ app: fakeApp(), platform: 'linux', argv: ['app'] }), false);
  assert.equal(wasOpenedAtLogin({ app: fakeApp({ wasOpenedAtLogin: true }), platform: 'darwin', argv: ['app'] }), true);
  assert.equal(wasOpenedAtLogin({ app: fakeApp({ wasOpenedAtLogin: true }), platform: 'win32', argv: ['app'] }), false);
});
