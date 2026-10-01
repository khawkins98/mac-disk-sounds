// The tray (menu bar) icon and its menu.
import { Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';
import { trayMenuTemplate, trayTooltip } from './tray-menu.js';

/**
 * Create the tray icon. Clicking the icon calls `onClick` (the app toggles
 * the settings window); the menu holds everything else.
 *
 * Platforms differ in what a click does:
 * - macOS: left click calls onClick, right (or control) click opens the menu.
 * - Windows: left click calls onClick, right click opens the menu.
 * - Linux: most tray hosts (StatusNotifierItem/AppIndicator) only show the
 *   menu and never report clicks, so the menu's "Open Settings…" is the way
 *   in there.
 *
 * @returns {{refresh(settings: object): void, destroy(): void}}
 */
export function createTray({ iconDir, platform = process.platform, settings, loginItemSupported, actions, onClick }) {
  const isMac = platform === 'darwin';
  // macOS recolours a "Template" image for light and dark menu bars; the
  // matching @2x file is picked up automatically on Retina displays.
  const image = nativeImage.createFromPath(path.join(iconDir, isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) image.setTemplateImage(true);

  const tray = new Tray(image);
  let menu = null;

  const refresh = (current) => {
    menu = Menu.buildFromTemplate(trayMenuTemplate(current, { loginItemSupported }, actions));
    tray.setToolTip(trayTooltip(current));
    // On macOS a context menu set with setContextMenu would open on left
    // click too and swallow the click event, so it is popped up by hand.
    if (!isMac) tray.setContextMenu(menu);
  };

  tray.on('click', () => onClick());
  if (isMac) tray.on('right-click', () => tray.popUpContextMenu(menu));

  refresh(settings);
  return {
    refresh,
    destroy: () => tray.destroy()
  };
}
