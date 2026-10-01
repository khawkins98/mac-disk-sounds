import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCHER_NAME,
  hasStatusNotifierHost,
  parseNameHasOwnerReply,
  sessionBusAddress,
  trayFallback
} from '../src/main/tray-host.js';

// Replies as printed by gdbus 2.x and dbus-send 1.x (captured on a real
// session bus).
const GDBUS_TRUE = '(true,)\n';
const GDBUS_FALSE = '(false,)\n';
const DBUS_SEND_TRUE = 'method return time=1790836989.794469 sender=org.freedesktop.DBus -> destination=:1.3 serial=3 reply_serial=2\n   boolean true\n';
const DBUS_SEND_FALSE = 'method return time=1790836989.785198 sender=org.freedesktop.DBus -> destination=:1.1 serial=3 reply_serial=2\n   boolean false\n';

test('parseNameHasOwnerReply reads gdbus and dbus-send replies', () => {
  assert.equal(parseNameHasOwnerReply(GDBUS_TRUE), true);
  assert.equal(parseNameHasOwnerReply(GDBUS_FALSE), false);
  assert.equal(parseNameHasOwnerReply(DBUS_SEND_TRUE), true);
  assert.equal(parseNameHasOwnerReply(DBUS_SEND_FALSE), false);
  assert.equal(parseNameHasOwnerReply(''), null);
  assert.equal(parseNameHasOwnerReply('Error connecting: Cannot autolaunch D-Bus without X11 $DISPLAY'), null);
  assert.equal(parseNameHasOwnerReply('(uint32 1,)'), null);
});

test('sessionBusAddress uses the environment or the per-user socket, never autolaunch', () => {
  assert.equal(sessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }, () => false), 'unix:path=/run/user/1000/bus');
  assert.equal(sessionBusAddress({ XDG_RUNTIME_DIR: '/run/user/1000' }, (p) => p === '/run/user/1000/bus'), 'unix:path=/run/user/1000/bus');
  assert.equal(sessionBusAddress({ XDG_RUNTIME_DIR: '/run/user/1000' }, () => false), null);
  assert.equal(sessionBusAddress({}, () => true), null);
});

function fakeExecFile(replies) {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, env: options.env, timeout: options.timeout });
    const reply = replies[command];
    setImmediate(() => {
      if (reply instanceof Error) callback(reply, '', '');
      else callback(null, reply ?? '', '');
    });
  };
  return { execFile, calls };
}

test('hasStatusNotifierHost asks the session bus about the watcher with gdbus and dbus-send at once', async () => {
  const { execFile, calls } = fakeExecFile({ gdbus: GDBUS_TRUE, 'dbus-send': DBUS_SEND_TRUE });
  const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', DISPLAY: ':0' };
  assert.equal(await hasStatusNotifierHost({ env, execFile }), true);
  assert.deepEqual(calls.map((c) => c.command), ['gdbus', 'dbus-send']);
  assert.equal(calls[0].args.at(-1), WATCHER_NAME);
  assert.ok(calls[0].args.includes('org.freedesktop.DBus.NameHasOwner'));
  assert.equal(calls[0].env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  assert.ok(calls[0].timeout > 0);
});

test('hasStatusNotifierHost takes the first real answer, and stays within one time budget', async () => {
  // gdbus never answers; dbus-send does.
  const hanging = (command, args, options, callback) => {
    if (command === 'dbus-send') setTimeout(() => callback(null, DBUS_SEND_TRUE, ''), 10);
  };
  const env = { DBUS_SESSION_BUS_ADDRESS: 'x' };
  assert.equal(await hasStatusNotifierHost({ env, execFile: hanging, timeoutMs: 1000 }), true);
  // Neither answers: false once the budget is spent, not budget x 2.
  const silent = () => {};
  const started = Date.now();
  assert.equal(await hasStatusNotifierHost({ env, execFile: silent, timeoutMs: 80 }), false);
  const took = Date.now() - started;
  assert.ok(took >= 70 && took < 150, `took ${took} ms`);
});

test('hasStatusNotifierHost uses dbus-send when gdbus is missing', async () => {
  const missing = Object.assign(new Error('spawn gdbus ENOENT'), { code: 'ENOENT' });
  const { execFile, calls } = fakeExecFile({ gdbus: missing, 'dbus-send': DBUS_SEND_FALSE });
  assert.equal(await hasStatusNotifierHost({ env: { DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=x' }, execFile }), false);
  assert.deepEqual(calls.map((c) => c.command), ['gdbus', 'dbus-send']);
  assert.equal(calls[1].args.at(-1), `string:${WATCHER_NAME}`);
});

test('hasStatusNotifierHost: no session bus, or no answer, means no host', async () => {
  const { execFile, calls } = fakeExecFile({});
  assert.equal(await hasStatusNotifierHost({ env: { DISPLAY: ':0' }, execFile, exists: () => false }), false);
  assert.equal(calls.length, 0, 'nothing is run (gdbus would autolaunch a bus)');

  const failing = fakeExecFile({ gdbus: new Error('timed out'), 'dbus-send': new Error('timed out') });
  assert.equal(await hasStatusNotifierHost({ env: { DBUS_SESSION_BUS_ADDRESS: 'x' }, execFile: failing.execFile }), false);

  const throwing = () => {
    throw new Error('spawn EAGAIN');
  };
  assert.equal(await hasStatusNotifierHost({ env: { DBUS_SESSION_BUS_ADDRESS: 'x' }, execFile: throwing }), false);
});

test('trayFallback: the tray counts as missing only on Linux without a host, or if it could not be created', () => {
  const missing = (facts) => trayFallback(facts).trayMissing;
  assert.equal(missing({ platform: 'linux', trayCreated: true, hasHost: true }), false);
  assert.equal(missing({ platform: 'linux', trayCreated: true, hasHost: false }), true);
  assert.equal(missing({ platform: 'linux', trayCreated: false, hasHost: null }), true);
  for (const platform of ['darwin', 'win32']) {
    assert.equal(missing({ platform, trayCreated: true, hasHost: null }), false);
    assert.equal(missing({ platform, trayCreated: false, hasHost: null }), true);
  }
});

test('trayFallback: how the settings window starts', () => {
  const start = (facts) => trayFallback({ platform: 'linux', trayCreated: true, ...facts }).startWindow;
  // Started by hand: always shown.
  assert.equal(start({ hasHost: true, openedAtLogin: false }), 'shown');
  assert.equal(start({ hasHost: false, openedAtLogin: false }), 'shown');
  // At login: out of sight in the tray, or minimised to the taskbar when
  // there is no tray, so the app is never running with no way in.
  assert.equal(start({ hasHost: true, openedAtLogin: true }), 'none');
  assert.equal(start({ hasHost: false, openedAtLogin: true }), 'minimized');
  assert.equal(trayFallback({ platform: 'win32', trayCreated: false, hasHost: null, openedAtLogin: true }).startWindow, 'minimized');
  assert.equal(trayFallback({ platform: 'darwin', trayCreated: true, hasHost: null, openedAtLogin: true }).startWindow, 'none');
});
