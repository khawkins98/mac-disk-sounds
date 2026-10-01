import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { DiskMonitor, cleanRate, CIM_DISK_SCRIPT, POWERSHELL_ARGS } from '../src/main/disk-monitor.js';

const MIB = 1024 * 1024;

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
  assert.deepEqual(children[0].args, ['-d', '-n', '64', '-w', '1', '-K']);

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

test('win32 (typeperf forced): one typeperf process with both counters', async () => {
  const { spawn, children } = fakeSpawn();
  const monitor = new DiskMonitor({ platform: 'win32', windowsBackend: 'typeperf', spawn, logger: quietLogger() });
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

test('win32: one long-lived PowerShell reading raw CIM counters, rates from the counter clock', async () => {
  const { spawn, children } = fakeSpawn();
  const monitor = new DiskMonitor({ platform: 'win32', spawn, logger: quietLogger(), env: { SystemRoot: 'D:\\Win' } });
  const samples = [];
  monitor.on('sample', (s) => samples.push(s));
  monitor.start();

  assert.equal(children.length, 1);
  assert.equal(children[0].command, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(children[0].args, POWERSHELL_ARGS);
  assert.deepEqual(POWERSHELL_ARGS.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  // Only untranslated WMI names, and nothing the Windows command line would
  // need to escape.
  assert.match(CIM_DISK_SCRIPT, /Win32_PerfRawData_PerfDisk_PhysicalDisk/);
  assert.match(CIM_DISK_SCRIPT, /\[Console\]::Out\.Flush\(\)/);
  assert.match(CIM_DISK_SCRIPT, /InvariantCulture/);
  assert.doesNotMatch(CIM_DISK_SCRIPT, /["\\\n]/);

  const out = children[0].stdout;
  out.write('MDS,1000000000,10000000,5000,7000\r\n'); // baseline only
  out.write('MDS,1010000000,10000000,1053576,7000\r\nMDS,1015000000,10000');
  out.write('000,1053576,531288\r\n');
  out.write('MDS,1015000000,10000000,1053576,531288\r\n'); // same snapshot: ignored
  await delay(5);
  assert.deepEqual(samples.map((s) => [s.readBps, s.writeBps]), [[MIB, 0], [0, MIB]]);
  monitor.stop();
  assert.equal(children[0].killed, true);
});

test('win32: falls back to typeperf if PowerShell/CIM gives no sample in time', async () => {
  const { spawn, children } = fakeSpawn();
  const logger = quietLogger();
  const monitor = new DiskMonitor({ platform: 'win32', spawn, logger, windowsFallbackMs: 30, backoffMs: { initial: 5 } });
  const samples = [];
  monitor.on('sample', (s) => samples.push(s.readBps));
  monitor.start();
  // PowerShell prints only a baseline (or nothing, or keeps failing).
  children[0].stdout.write('MDS,1000000000,10000000,5000,7000\r\n');
  await delay(60);

  assert.equal(children[0].killed, true);
  const typeperf = children.at(-1);
  assert.match(typeperf.command, /typeperf\.exe$/);
  assert.equal(children.filter((c) => /powershell/.test(c.command) && !c.killed).length, 0, 'no PowerShell left running');
  // A late line from the killed PowerShell does not count.
  children[0].stdout.write('MDS,1010000000,10000000,999999,7000\r\n');
  typeperf.stdout.write('"10/01/2026 09:15:02.125","2048.0","1024.0"\r\n');
  await delay(5);
  assert.deepEqual(samples, [2048]);
  assert.equal(logger.calls.filter(([level, text]) => level === 'warn' && /using typeperf instead/.test(text)).length, 1);
  monitor.stop();
  assert.equal(typeperf.killed, true);
});

test('win32: no fallback once PowerShell/CIM has delivered a sample', async () => {
  const { spawn, children } = fakeSpawn();
  const logger = quietLogger();
  const monitor = new DiskMonitor({ platform: 'win32', spawn, logger, windowsFallbackMs: 30 });
  let samples = 0;
  monitor.on('sample', () => samples++);
  monitor.start();
  children[0].stdout.write('MDS,1000000000,10000000,5000,7000\r\nMDS,1010000000,10000000,6000,7000\r\n');
  await delay(60);
  assert.equal(samples, 1);
  assert.equal(children.length, 1);
  assert.equal(children[0].killed, false);
  assert.deepEqual(logger.calls, []);
  monitor.stop();
});

test('win32: stopping before the fallback time cancels the fallback', async () => {
  const { spawn, children } = fakeSpawn();
  const monitor = new DiskMonitor({ platform: 'win32', spawn, logger: quietLogger(), windowsFallbackMs: 20 });
  monitor.start();
  monitor.stop();
  await delay(50);
  assert.equal(children.length, 1);
});

test('restarts a process that exits unexpectedly, with backoff', async () => {
  const { spawn, children } = fakeSpawn();
  const logger = quietLogger();
  const monitor = new DiskMonitor({ platform: 'win32', windowsBackend: 'typeperf', spawn, logger, backoffMs: { initial: 40, max: 160 } });
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
});

test('a crash loop keeps backing off even if it emits samples, and logs once', async () => {
  const { spawn, children } = fakeSpawn();
  const logger = quietLogger();
  let clock = 0;
  const monitor = new DiskMonitor({
    platform: 'win32',
    windowsBackend: 'typeperf',
    spawn,
    logger,
    now: () => clock,
    backoffMs: { initial: 20, max: 1000, stableMs: 10000 }
  });
  let samples = 0;
  monitor.on('sample', () => samples++);
  monitor.start();

  // Each child prints one good sample and dies at once.
  const crash = (child) => {
    child.stdout.write('"10/01/2026 09:15:02.125","2048.0","1024.0"\r\n');
    setImmediate(() => child.emit('exit', 1, null));
  };
  const started = [];
  let last = performance.now();
  for (let i = 0; i < 4; i++) {
    crash(children[i]);
    while (children.length === i + 1) await delay(2);
    const t = performance.now();
    started.push(t - last);
    last = t;
  }
  assert.equal(samples, 4);
  // Delays roughly 20, 40, 80, 160 ms: each at least the doubled minimum.
  assert.ok(started[1] >= 35 && started[2] >= 75 && started[3] >= 155, `delays ${started.map(Math.round)}`);
  const warnings = logger.calls.filter(([level]) => level === 'warn');
  assert.equal(warnings.length, 1, 'repeated failures are logged once');

  // A child that stays up for stableMs resets the backoff and the logging.
  clock += 10000;
  children[4].emit('exit', 1, null);
  const t0 = performance.now();
  while (children.length === 5) await delay(2);
  assert.ok(performance.now() - t0 < 150, 'restarted from the initial delay');
  assert.equal(logger.calls.filter(([level]) => level === 'warn').length, 2);
  monitor.stop();
});

test('samples from a replaced child or a stopped monitor are dropped', async () => {
  const { spawn, children } = fakeSpawn();
  const monitor = new DiskMonitor({ platform: 'win32', windowsBackend: 'typeperf', spawn, logger: quietLogger(), backoffMs: { initial: 5 } });
  const samples = [];
  monitor.on('sample', (s) => samples.push(s.readBps));
  monitor.start();
  const old = children[0];
  old.emit('exit', 1, null);
  while (children.length === 1) await delay(2);
  // The old child's pipe still delivers a line after it was replaced.
  old.stdout.write('"t","111","0"\n');
  children[1].stdout.write('"t","222","0"\n');
  await delay(5);
  monitor.stop();
  children[1].stdout.write('"t","333","0"\n');
  await delay(5);
  assert.deepEqual(samples, [222]);
});

test('cleanRate turns NaN, negative and infinite rates into 0 and keeps null', () => {
  assert.equal(cleanRate(NaN), 0);
  assert.equal(cleanRate(-5), 0);
  assert.equal(cleanRate(Infinity), 0);
  assert.equal(cleanRate(undefined), 0);
  assert.equal(cleanRate(1234.5), 1234.5);
  assert.equal(cleanRate(null), null);
});

test('darwin: a change in the disk set skips the next report (no fake burst)', async () => {
  const { spawn, children } = fakeSpawn();
  const monitor = new DiskMonitor({ platform: 'darwin', spawn, logger: quietLogger() });
  const samples = [];
  monitor.on('sample', (s) => samples.push(s.totalBps / (1024 * 1024)));
  monitor.start();
  const out = children[0].stdout;
  out.write('              disk0 \n    KB/t  tps  MB/s \n   21.89   38 50.00 \n');
  out.write('   16.00    3  1.00 \n');
  // disk4 is attached: iostat reprints the device line, and the next report
  // includes disk4's bytes since boot.
  out.write('              disk0               disk4 \n    KB/t  tps  MB/s     KB/t  tps  MB/s \n');
  out.write('   16.00    3  1.00    512.00 9000 4500.00 \n');
  out.write('   16.00    3  1.00      4.00    2  0.25 \n');
  // The same header reprinted (iostat does this periodically) skips nothing.
  out.write('              disk0               disk4 \n    KB/t  tps  MB/s     KB/t  tps  MB/s \n');
  out.write('   16.00    3  2.00      4.00    2  0.00 \n');
  await delay(5);
  monitor.stop();
  assert.deepEqual(samples, [1, 1.25, 2]);
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
