// Is there anywhere to show a tray icon, and what to do with the settings
// window when there is not. Electron has no API for "is my tray icon
// visible", so on Linux this asks D-Bus whether a StatusNotifierItem host
// (org.kde.StatusNotifierWatcher) is running: KDE, XFCE, Cinnamon, MATE and
// Ubuntu's GNOME have one; stock GNOME without the AppIndicator extension
// does not, and there the icon is simply never shown.
//
// The check leans towards "no tray": the cost of a wrong "no tray" is a
// window that minimises instead of closing (and a note saying so); the cost
// of a wrong "tray" is an app that cannot be reached without relaunching it.
// A desktop with only an old XEmbed system tray reads as "no tray" here.

import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';

/**
 * The reply to org.freedesktop.DBus.NameHasOwner as printed by
 * `gdbus call` ("(true,)") or `dbus-send --print-reply` ("   boolean true").
 * @returns {boolean|null} null if it is neither
 */
export function parseNameHasOwnerReply(stdout) {
  const text = String(stdout);
  const match = text.match(/^\s*\((true|false),\)\s*$/m) ?? text.match(/^\s*boolean (true|false)\s*$/m);
  return match ? match[1] === 'true' : null;
}

/**
 * The session bus address to use, without letting gdbus or dbus-send
 * autolaunch a new bus (which they otherwise do when $DISPLAY is set).
 * @returns {string|null} null when there is no session bus
 */
export function sessionBusAddress(env = process.env, exists = fs.existsSync) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env.DBUS_SESSION_BUS_ADDRESS;
  if (env.XDG_RUNTIME_DIR) {
    const socket = path.join(env.XDG_RUNTIME_DIR, 'bus');
    if (exists(socket)) return `unix:path=${socket}`;
  }
  return null;
}

const QUERIES = [
  ['gdbus', ['call', '--session', '--timeout', '2', '--dest', 'org.freedesktop.DBus',
    '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER_NAME]],
  ['dbus-send', ['--session', '--print-reply', '--reply-timeout=2000', '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', `string:${WATCHER_NAME}`]]
];

/**
 * Whether a StatusNotifierItem host is running on this Linux session.
 * Tries gdbus, then dbus-send; each gets `timeoutMs`.
 * @returns {Promise<boolean>} false when there is no session bus or the
 *   question could not be answered
 */
export async function hasStatusNotifierHost({ env = process.env, execFile = nodeExecFile, exists = fs.existsSync, timeoutMs = 3000 } = {}) {
  const address = sessionBusAddress(env, exists);
  if (!address) return false;
  const childEnv = { ...env, DBUS_SESSION_BUS_ADDRESS: address };
  for (const [command, args] of QUERIES) {
    const answer = await new Promise((resolve) => {
      try {
        execFile(command, args, { env: childEnv, timeout: timeoutMs }, (error, stdout) => {
          resolve(error ? null : parseNameHasOwnerReply(stdout));
        });
      } catch {
        resolve(null);
      }
    });
    if (answer !== null) return answer;
  }
  return false;
}

/**
 * What the app does about a missing tray.
 * @param {{platform: string, trayCreated: boolean, hasHost: boolean|null}} facts
 *   hasHost: the result of hasStatusNotifierHost (Linux), or null if not
 *   checked (other platforms always have a tray area)
 * @returns {{trayMissing: boolean}} when trayMissing, the settings window
 *   says so, offers Quit, and closing it minimises it instead
 */
export function trayFallback({ platform, trayCreated, hasHost }) {
  return { trayMissing: !trayCreated || (platform === 'linux' && hasHost === false) };
}
