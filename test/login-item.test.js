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

test('quoteExecArg quotes and escapes for a desktop entry Exec key', () => {
  assert.equal(quoteExecArg('/opt/Mac Disk Sounds/mac-disk-sounds'), '"/opt/Mac Disk Sounds/mac-disk-sounds"');
  assert.equal(quoteExecArg('/a/"b"/$c/`d`/\\e/100%'), '"/a/\\"b\\"/\\$c/\\`d\\`/\\\\e/100%%"');
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
  assert.deepEqual(mac.calls.at(-1), ['set', { openAtLogin: false, args: [] }]);

  const win = fakeApp();
  const winItem = createLoginItem({ app: win, platform: 'win32' });
  winItem.get();
  winItem.set(true);
  assert.deepEqual(win.calls, [['get', { args: [HIDDEN_ARG] }], ['set', { openAtLogin: true, args: [HIDDEN_ARG] }]]);
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

test('wasOpenedAtLogin: --hidden anywhere, or macOS says so', () => {
  assert.equal(wasOpenedAtLogin({ app: fakeApp(), platform: 'linux', argv: ['app', HIDDEN_ARG] }), true);
  assert.equal(wasOpenedAtLogin({ app: fakeApp(), platform: 'linux', argv: ['app'] }), false);
  assert.equal(wasOpenedAtLogin({ app: fakeApp({ wasOpenedAtLogin: true }), platform: 'darwin', argv: ['app'] }), true);
  assert.equal(wasOpenedAtLogin({ app: fakeApp({ wasOpenedAtLogin: true }), platform: 'win32', argv: ['app'] }), false);
});
