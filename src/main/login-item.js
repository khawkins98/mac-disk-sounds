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
 * Quote a path for a desktop entry's Exec key. The Desktop Entry spec has
 * two layers: the key's value is first unescaped as a string (`\\` becomes
 * `\`), and the result is then split like a shell-quoted command line, where
 * `"`, `` ` ``, `$` and `\` inside double quotes need a backslash. So escape
 * for quoting first, then double every backslash for the string layer.
 *
 * A literal `%` in the path is not supported: the spec reserves `%` for
 * field codes, and launchers disagree on `%%` inside quotes. Paths with
 * `%` are refused (see createLoginItem).
 */
export function quoteExecArg(value) {
  if (value.includes('%')) throw new Error('A % in the executable path is not supported in a desktop entry');
  const quoted = value.replace(/[\\"`$]/g, (char) => `\\${char}`);
  return `"${quoted.replace(/\\/g, '\\\\')}"`;
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
 * @returns {{
 *   supported: boolean,
 *   get(): boolean,
 *   set(enabled: boolean): void,
 *   repair(): boolean
 * }} repair() brings an existing entry up to date with this executable
 * (true if it rewrote it); it is a no-op where nothing can go stale.
 */
export function createLoginItem({
  app,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  execPath = process.execPath,
  fs: fsImpl = fs
}) {
  const unsupported = { supported: false, get: () => false, set() {}, repair: () => false };
  if (!app.isPackaged) return unsupported;

  if (platform === 'darwin') {
    return {
      supported: true,
      get: () => app.getLoginItemSettings().openAtLogin,
      set: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
      repair: () => false
    };
  }

  if (platform === 'win32') {
    // Windows needs the same path and args to read the entry back. The
    // portable build runs from a temporary extraction directory; register
    // the portable .exe itself instead.
    const options = { args: [HIDDEN_ARG] };
    if (env.PORTABLE_EXECUTABLE_FILE) options.path = env.PORTABLE_EXECUTABLE_FILE;
    return {
      supported: true,
      get: () => app.getLoginItemSettings(options).openAtLogin,
      set: (enabled) => app.setLoginItemSettings({ ...options, openAtLogin: enabled }),
      repair: () => false
    };
  }

  if (platform === 'linux') {
    const file = path.join(autostartDir(env, home), DESKTOP_FILE);
    // An AppImage runs from a temporary mount; APPIMAGE is the real file.
    const target = env.APPIMAGE || execPath;
    // A desktop entry cannot point at a path with % in it (quoteExecArg).
    if (target.includes('%')) return unsupported;
    const entry = autostartDesktopEntry(target);
    const write = () => {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(file, entry);
    };
    const execLine = (text) => text.split('\n').find((line) => line.startsWith('Exec='));
    return {
      supported: true,
      get: () => fsImpl.existsSync(file),
      set(enabled) {
        if (enabled) {
          write();
        } else {
          fsImpl.rmSync(file, { force: true });
        }
      },
      // AppImage file names carry the version, so after an update the entry
      // may still start the old download. Point it at this one.
      repair() {
        let current;
        try {
          current = fsImpl.readFileSync(file, 'utf8');
        } catch {
          return false;
        }
        if (execLine(current) === execLine(entry)) return false;
        write();
        return true;
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
