// "Launch at login". macOS and Windows use Electron's login item API; on
// Linux we write or remove an XDG autostart entry
// (~/.config/autostart/mac-disk-sounds.desktop). Only offered in a packaged
// app: in development it would register the bare Electron binary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Passed when the OS starts us at login, so we start in the tray without
// opening the settings window.
export const HIDDEN_ARG = '--hidden';

const DESKTOP_FILE = 'mac-disk-sounds.desktop';

/**
 * Quote a path for a desktop entry's Exec key: wrap it in double quotes,
 * backslash-escape the characters the spec reserves inside quotes, and
 * double any % (field codes).
 */
export function quoteExecArg(value) {
  const escaped = value.replace(/[\\"`$]/g, (char) => `\\${char}`).replace(/%/g, '%%');
  return `"${escaped}"`;
}

/** The contents of the autostart entry that starts `execPath` hidden. */
export function autostartDesktopEntry(execPath, name = 'Mac Disk Sounds') {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${name}`,
    'Comment=Retro hard disk sounds for disk activity',
    `Exec=${quoteExecArg(execPath)} ${HIDDEN_ARG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

export function autostartDir(env = process.env, home = os.homedir()) {
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : path.join(home, '.config');
  return path.join(configHome, 'autostart');
}

/**
 * @returns {{supported: boolean, get(): boolean, set(enabled: boolean): void}}
 */
export function createLoginItem({
  app,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  fs: fsImpl = fs
}) {
  const unsupported = { supported: false, get: () => false, set() {} };
  if (!app.isPackaged) return unsupported;

  if (platform === 'darwin' || platform === 'win32') {
    // Windows needs the same args to read the entry back.
    const args = platform === 'win32' ? [HIDDEN_ARG] : [];
    return {
      supported: true,
      get: () => app.getLoginItemSettings({ args }).openAtLogin,
      set: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled, args })
    };
  }

  if (platform === 'linux') {
    const file = path.join(autostartDir(env, home), DESKTOP_FILE);
    // An AppImage runs from a temporary mount; APPIMAGE is the real file.
    const execPath = env.APPIMAGE || process.execPath;
    return {
      supported: true,
      get: () => fsImpl.existsSync(file),
      set(enabled) {
        if (enabled) {
          fsImpl.mkdirSync(path.dirname(file), { recursive: true });
          fsImpl.writeFileSync(file, autostartDesktopEntry(execPath));
        } else {
          fsImpl.rmSync(file, { force: true });
        }
      }
    };
  }

  return unsupported;
}

/** True when this process was started at login rather than by the user. */
export function wasOpenedAtLogin({ app, platform = process.platform, argv = process.argv }) {
  if (argv.includes(HIDDEN_ARG)) return true;
  if (platform === 'darwin') {
    try {
      return Boolean(app.getLoginItemSettings().wasOpenedAtLogin);
    } catch {
      return false;
    }
  }
  return false;
}
