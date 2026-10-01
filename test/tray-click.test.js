import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOCUS_GRACE_MS, trayClickAction } from '../src/main/tray-click.js';

test('a hidden, closed or minimised window is shown', () => {
  assert.equal(trayClickAction({ visible: false, focused: false, msSinceBlur: Infinity }), 'show');
  assert.equal(trayClickAction({ visible: false, focused: false, msSinceBlur: 10 }), 'show');
});

test('a window the user is looking at is hidden', () => {
  assert.equal(trayClickAction({ visible: true, focused: true, msSinceBlur: Infinity }), 'hide');
});

test('Windows: a window that lost the focus to the tray click itself still counts as focused', () => {
  assert.equal(trayClickAction({ visible: true, focused: false, msSinceBlur: 40 }), 'hide');
  assert.equal(trayClickAction({ visible: true, focused: false, msSinceBlur: FOCUS_GRACE_MS }), 'hide');
});

test('a visible window covered by other windows is brought forward, not closed', () => {
  assert.equal(trayClickAction({ visible: true, focused: false, msSinceBlur: FOCUS_GRACE_MS + 1 }), 'show');
  assert.equal(trayClickAction({ visible: true, focused: false, msSinceBlur: 60000 }), 'show');
  assert.equal(trayClickAction({ visible: true, focused: false, msSinceBlur: Infinity }), 'show');
});
