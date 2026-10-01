// The tray menu as plain data, built from the settings. No Electron here:
// tray.js passes the result to Menu.buildFromTemplate.

import { SOUND_SETS } from './settings.js';

/**
 * @param {object} settings current settings (see settings.js)
 * @param {{loginItemSupported: boolean, version: string}} options
 * @param {{setSettings(patch: object): void, openSettings(): void, checkForUpdates(): void, quit(): void}} actions
 * @returns {object[]} an Electron menu template
 */
export function trayMenuTemplate(settings, { loginItemSupported, version }, actions) {
  const template = [
    {
      id: 'enabled',
      label: 'Enabled',
      type: 'checkbox',
      checked: settings.enabled,
      // Electron flips `checked` before calling click.
      click: (item) => actions.setSettings({ enabled: item.checked })
    },
    {
      id: 'sound-set',
      label: 'Sound Set',
      submenu: Object.entries(SOUND_SETS).map(([value, label]) => ({
        id: `sound-set:${value}`,
        label,
        type: 'radio',
        checked: settings.soundSet === value,
        click: () => actions.setSettings({ soundSet: value })
      }))
    },
    { type: 'separator' },
    { id: 'open-settings', label: 'Open Settings…', click: () => actions.openSettings() }
  ];
  if (loginItemSupported) {
    template.push({
      id: 'launch-at-login',
      label: 'Launch at Login',
      type: 'checkbox',
      checked: settings.launchAtLogin,
      click: (item) => actions.setSettings({ launchAtLogin: item.checked })
    });
  }
  template.push(
    { type: 'separator' },
    // The app is not signed and does not update itself; this opens the
    // latest release on GitHub.
    { id: 'version', label: `Mac Disk Sounds v${version}`, enabled: false },
    { id: 'check-for-updates', label: 'Check for Updates…', click: () => actions.checkForUpdates() },
    { type: 'separator' },
    { id: 'quit', label: 'Quit Mac Disk Sounds', click: () => actions.quit() }
  );
  return template;
}

/** Tooltip for the tray icon. */
export function trayTooltip(settings) {
  return settings.enabled ? 'Mac Disk Sounds' : 'Mac Disk Sounds (off)';
}
