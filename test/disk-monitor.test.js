import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { DiskMonitor } from '../disk-monitor.js';

const quietLogger = () => {
  const calls = [];
  const log = (level) => (...args) => calls.push([level, args.join(' ')]);
  return { calls, warn: log('warn'), error: log('error'), log: log('log') };
};

function fakeSpawn() {
  const children = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.command = command;
    child.args = args;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      return true;
    };
    children.push(child);
    return child;
  };
  return { spawn, children };
}

test('linux: reads /proc/diskstats on a timer and emits rates, no processes', async () => {
  let sectors = 0;
  const reads = [];
  const monitor = new DiskMonitor({
    platform: 'linux',
    intervalMs: 10,
    logger: quietLogger(),
    readFile: async (file) => {
      reads.push(file);
      sectors += 2048; // 1 MiB read per tick
      return ` 8 0 sda 1 0 ${sectors} 0 0 0 0 0 0 0 0\n 8 1 sda1 1 0 ${sectors} 0 0 0 0 0 0 0 0\n`;
    },
    spawn: () => assert.fail('linux must not spawn processes')
  });
  const samples = [];
  monitor.on('sample', (s) => samples.push(s));
  monitor.start();
  await delay(80);
  monitor.stop();
  const count = samples.length;
  await delay(40);

  assert.ok(count >= 2, `expected samples, got ${count}`);
  assert.equal(samples.length, count, 'no samples after stop()');
  assert.ok(reads.every((f) => f === '/proc/diskstats'));
  for (const s of samples) {
    assert.ok(s.readBps > 0 && s.writeBps === 0 && s.totalBps === s.readBps);
    assert.equal(typeof s.at, 'number');
  }
});

test('linux: a disk appearing starts a new baseline instead of a burst', async () => {
  const texts = [
    ' 8 0 sda 1 0 1000 0 0 0 0 0 0 0 0\n',
    ' 8 0 sda 1 0 1000 0 0 0 0 0 0 0 0\n 8 16 sdb 1 0 99999999 0 0 0 0 0 0 0 0\n',
    ' 8 0 sda 1 0 1000 0 0 0 0 0 0 0 0\n 8 16 sdb 1 0 99999999 0 0 0 0 0 0 0 0\n'
  ];
  let i = 0;
  const monitor = new DiskMonitor({
    platform: 'linux',
    intervalMs: 10,
    logger: quietLogger(),
    readFile: async () => texts[Math.min(i++, texts.length - 1)]
  });
  const samples = [];
  monitor.on('sample', (s) => samples.push(s));
  monitor.start();
  await delay(60);
  monitor.stop();
  assert.ok(samples.length >= 1);
  assert.ok(samples.every((s) => s.totalBps === 0), 'no burst from the new disk');
});

test('darwin: one iostat process, skips the since-boot line, sums MB/s', async () => {
  const { spawn, children } = fakeSpawn();
  const monitor = new DiskMonitor({ platform: 'darwin', spawn, logger: quietLogger() });
  const samples = [];
  monitor.on('sample', (s) => samples.push(s));
  monitor.start();

  assert.equal(children.length, 1);
  assert.equal(children[0].command, '/usr/sbin/iostat');
  assert.deepEqual(children[0].args, ['-d', '-w', '1', '-K']);

  const out = children[0].stdout;
  out.write('              disk0               disk4 \n    KB/t  tps  MB/s     KB/t  tps  MB/s \n');
  out.write('   21.89   38 50.00    18.00    0  0.00 \n'); // since boot: ignored
  out.write('   16.00    3  1.00     0.00    0  0.');
  out.write('50 \n');
  await delay(5);

  assert.equal(samples.length, 1);
  assert.equal(samples[0].totalBps, 1.5 * 1024 * 1024);
  assert.equal(samples[0].readBps, null);
  assert.equal(samples[0].writeBps, null);

  monitor.stop();
  assert.equal(children[0].killed, true);
  await delay(5);
  assert.equal(children.length, 1, 'no restart after stop()');
});

test('win32: one typeperf process with both counters', async () => {
  const { spawn, children } = fakeSpawn();
  const monitor = new DiskMonitor({ platform: 'win32', spawn, logger: quietLogger() });
  const samples = [];
  monitor.on('sample', (s) => samples.push(s));
  monitor.start();

  assert.equal(children.length, 1);
  assert.match(children[0].command, /typeperf\.exe$/i);
  assert.deepEqual(children[0].args, [
    '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
    '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec',
    '-si',
    '1'
  ]);
  children[0].stdout.write('\r\n"(PDH-CSV 4.0)","\\\\PC\\PhysicalDisk(_Total)\\Disk Read Bytes/sec","\\\\PC\\PhysicalDisk(_Total)\\Disk Write Bytes/sec"\r\n');
  children[0].stdout.write('"10/01/2026 09:15:01.123"," "," "\r\n"10/01/2026 09:15:02.125","2048.0","1024.0"\r\n');
  await delay(5);
  assert.deepEqual(samples.map((s) => [s.readBps, s.writeBps, s.totalBps]), [[2048, 1024, 3072]]);
  monitor.stop();
  assert.equal(children[0].killed, true);
});

test('restarts a process that exits unexpectedly, with backoff', async () => {
  const { spawn, children } = fakeSpawn();
  const logger = quietLogger();
  const monitor = new DiskMonitor({ platform: 'win32', spawn, logger, backoffMs: { initial: 40, max: 160 } });
  monitor.start();

  children[0].emit('exit', 1, null);
  await delay(10);
  assert.equal(children.length, 1, 'waits before restarting');
  await delay(60);
  assert.equal(children.length, 2, 'restarted after the first delay');

  // A spawn failure (e.g. missing binary) also restarts, after a longer delay.
  children[1].emit('error', new Error('spawn ENOENT'));
  children[1].emit('exit', -2, null); // only one restart for error + exit
  await delay(50);
  assert.equal(children.length, 2, 'backoff doubled');
  await delay(80);
  assert.equal(children.length, 3);

  monitor.stop();
  assert.equal(children[2].killed, true);
  await delay(200);
  assert.equal(children.length, 3, 'no restart after stop()');
  assert.ok(logger.calls.some(([level, msg]) => level === 'warn' && /restarting/.test(msg)));
});

test('unsupported platforms emit nothing and log once', async () => {
  const logger = quietLogger();
  const monitor = new DiskMonitor({
    platform: 'freebsd',
    logger,
    spawn: () => assert.fail('must not spawn'),
    readFile: () => assert.fail('must not read')
  });
  let samples = 0;
  monitor.on('sample', () => samples++);
  monitor.start();
  monitor.stop();
  monitor.start();
  monitor.stop();
  await delay(20);
  assert.equal(samples, 0);
  assert.equal(logger.calls.length, 1);
  assert.match(logger.calls[0][1], /not supported on freebsd/);
});
