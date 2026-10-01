// What a click on the tray icon does to the settings window. Pure, so it
// can be tested without Electron.

// On Windows, pressing on the tray icon moves the focus to the taskbar
// before the click arrives, so a window that was focused a moment ago
// already reports itself unfocused. A blur this recent counts as focused.
export const FOCUS_GRACE_MS = 300;

/**
 * 'hide' the window if the user is looking at it; otherwise 'show' it,
 * which also restores and focuses it. A window that is open but covered by
 * other windows is brought forward rather than closed.
 * @param {{visible: boolean, focused: boolean, msSinceBlur: number}} state
 *   visible: shown and not minimised; msSinceBlur: Infinity if it never
 *   lost the focus
 * @returns {'hide'|'show'}
 */
export function trayClickAction({ visible, focused, msSinceBlur }) {
  if (!visible) return 'show';
  if (focused || msSinceBlur <= FOCUS_GRACE_MS) return 'hide';
  return 'show';
}
