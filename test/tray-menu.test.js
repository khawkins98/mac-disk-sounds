import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trayMenuTemplate, trayTooltip } from '../src/main/tray-menu.js';
import { DEFAULT_SETTINGS, SOUND_SETS } from '../src/main/settings.js';

function recorder() {
  const calls = [];
  return {
    calls,
    actions: {
      setSettings: (patch) => calls.push(['setSettings', patch]),
      openSettings: () => calls.push(['openSettings']),
      checkForUpdates: () => calls.push(['checkForUpdates']),
      quit: () => calls.push(['quit'])
    }
  };
}

const byId = (items, id) => items.find((item) => item.id === id);
const OPTIONS = { loginItemSupported: true, version: '1.2.3' };

test('menu reflects the settings', () => {
  const { actions } = recorder();
  const settings = { ...DEFAULT_SETTINGS, enabled: false, soundSet: 'ibm', launchAtLogin: true };
  const menu = trayMenuTemplate(settings, OPTIONS, actions);

  assert.deepEqual(menu.map((item) => item.id ?? item.type), [
    'enabled', 'sound-set', 'separator', 'open-settings', 'launch-at-login', 'separator',
    'version', 'check-for-updates', 'separator', 'quit'
  ]);
  assert.equal(byId(menu, 'enabled').type, 'checkbox');
  assert.equal(byId(menu, 'enabled').checked, false);
  assert.equal(byId(menu, 'launch-at-login').checked, true);

  const sets = byId(menu, 'sound-set').submenu;
  assert.deepEqual(sets.map((item) => item.label), Object.values(SOUND_SETS));
  assert.ok(sets.every((item) => item.type === 'radio'));
  assert.deepEqual(sets.filter((item) => item.checked).map((item) => item.id), ['sound-set:ibm']);
});

test('launch at login is left out where it is not supported', () => {
  const { actions } = recorder();
  const menu = trayMenuTemplate(DEFAULT_SETTINGS, { ...OPTIONS, loginItemSupported: false }, actions);
  assert.equal(byId(menu, 'launch-at-login'), undefined);
});

test('menu items call the actions', () => {
  const { calls, actions } = recorder();
  const menu = trayMenuTemplate(DEFAULT_SETTINGS, OPTIONS, actions);

  // Electron flips a checkbox before calling click; the handler uses that.
  byId(menu, 'enabled').click({ checked: false });
  byId(menu, 'launch-at-login').click({ checked: true });
  byId(byId(menu, 'sound-set').submenu, 'sound-set:ibm').click({ checked: true });
  byId(menu, 'open-settings').click();
  byId(menu, 'check-for-updates').click();
  byId(menu, 'quit').click();

  assert.deepEqual(calls, [
    ['setSettings', { enabled: false }],
    ['setSettings', { launchAtLogin: true }],
    ['setSettings', { soundSet: 'ibm' }],
    ['openSettings'],
    ['checkForUpdates'],
    ['quit']
  ]);
});

test('menu shows the version, disabled, above Check for Updates', () => {
  const { actions } = recorder();
  const menu = trayMenuTemplate(DEFAULT_SETTINGS, OPTIONS, actions);
  const version = byId(menu, 'version');
  assert.equal(version.label, 'Mac Disk Sounds v1.2.3');
  assert.equal(version.enabled, false);
  assert.equal(version.click, undefined);
  assert.equal(byId(menu, 'check-for-updates').label, 'Check for Updates…');
  assert.equal(menu.indexOf(version) + 1, menu.indexOf(byId(menu, 'check-for-updates')));
});

test('tooltip says when the sounds are off', () => {
  assert.equal(trayTooltip({ enabled: true }), 'Mac Disk Sounds');
  assert.equal(trayTooltip({ enabled: false }), 'Mac Disk Sounds (off)');
});
