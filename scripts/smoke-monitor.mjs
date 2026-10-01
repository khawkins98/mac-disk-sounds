// Smoke test for the real disk monitor backend on this machine: Linux
// /proc/diskstats, macOS iostat, Windows PowerShell/CIM (or typeperf). Runs
// the DiskMonitor for a few seconds while writing (and fsyncing) a temporary
// file, then checks that the backend produced parsed samples with sane
// numbers.
//
//   node scripts/smoke-monitor.mjs
//   node scripts/smoke-monitor.mjs --windows-backend=typeperf
//
// On Windows the default is what the app does: PowerShell/CIM, falling back
// to typeperf. The fallback logs a warning, which fails this test, so CI
// notices if CIM stops working. --windows-backend=cim or =typeperf forces
// one backend.
//
// Exits non-zero on failure. Used by CI on each platform.

import { DiskMonitor } from '../src/main/disk-monitor.js';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { parseIostatLine, parsePlistValues, splitLines } from '../src/main/disk-parsers.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MIN_RUN_MS = 5000; // run at least this long
const MAX_RUN_MS = 20000; // and give a slow-starting backend up to this
const MIN_SAMPLES = 2;
const CHUNK = Buffer.alloc(4 * 1024 * 1024, 0xa5);
const MAX_FILE_BYTES = 256 * 1024 * 1024;

const samples = [];
const problems = [];
const notes = [];
const logger = {
  log: (...args) => {
    console.log('[monitor]', ...args);
    notes.push(args.join(' '));
  },
  warn: (...args) => {
    console.warn('[monitor warn]', ...args);
    problems.push(args.join(' '));
  },
  error: (...args) => {
    console.error('[monitor error]', ...args);
    problems.push(args.join(' '));
  }
};

const backendArg = process.argv.find((arg) => arg.startsWith('--windows-backend='));
const windowsBackend = backendArg ? backendArg.split('=')[1] : 'auto';
if (!['auto', 'cim', 'typeperf'].includes(windowsBackend)) {
  console.error(`Unknown --windows-backend: ${windowsBackend}`);
  process.exit(2);
}

// Echo the first raw lines the backend reads (iostat, PowerShell or
// typeperf output, or /proc/diskstats), so a CI failure shows what the
// parser was given.
const RAW_LINES = 12;
let rawShown = 0;
function showRaw(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (rawShown >= RAW_LINES || line.trim() === '') continue;
    console.log(`[raw] ${line}`);
    rawShown += 1;
  }
}
const spawn = (command, args, options) => {
  console.log(`[spawn] ${command} ${args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`);
  const child = nodeSpawn(command, args, options);
  child.stdout?.on('data', showRaw);
  child.stdout?.on('data', (chunk) => {
    if (diskImage && new RegExp(`\\b${diskImage}\\b`).test(String(chunk))) imageListed = true;
  });
  // macOS: follow iostat's own per-disk rates, to check the monitor's total
  // against them (this listener runs before the monitor's own).
  if (process.platform === 'darwin') {
    let rest = '';
    let mbColumns = null;
    let names = [];
    child.stdout?.on('data', (chunk) => {
      const split = splitLines(rest, String(chunk));
      rest = split.rest;
      for (const line of split.lines) {
        const parsed = parseIostatLine(line, mbColumns);
        if (parsed.kind === 'devices') names = parsed.names;
        if (parsed.kind === 'header') mbColumns = parsed.mbColumns;
        if (parsed.kind === 'data' && parsed.deviceBps.length === names.length) {
          lastIostat = Object.fromEntries(names.map((name, i) => [name, parsed.deviceBps[i]]));
        }
      }
    });
  }
  child.stderr?.on('data', (chunk) => console.log(`[stderr] ${String(chunk).trimEnd()}`));
  return child;
};
// Set below on macOS: the attached disk image, and whether iostat listed it.
let diskImage = null;
let imageMount = null;
let imageListed = false;
// The per-disk rates of the latest iostat line, and the checks made with them.
let lastIostat = null;
const imageChecks = [];
let diskstatsShown = false;
const readFile = async (...args) => {
  const text = await fs.readFile(...args);
  if (!diskstatsShown) {
    diskstatsShown = true;
    console.log(`[read] ${args[0]} (loop, ram and zram devices left out here)`);
    showRaw(text.split('\n').filter((line) => !/\s(?:loop|ram|zram)\d+\s/.test(line)).join('\n'));
  }
  return text;
};

const isRate = (value) => value === null || (Number.isFinite(value) && value >= 0);

const monitor = new DiskMonitor({ logger, spawn, readFile, windowsBackend });
monitor.on('sample', (sample) => {
  samples.push(sample);
  // Once the monitor has said which disks it leaves out, its total must be
  // the sum of the other disks' rates on the same iostat line.
  const excluded = new Set(notes.filter((note) => /Not counting disk images/.test(note))
    .flatMap((note) => [...note.matchAll(/(disk\d+) \(BusProtocol/g)].map((m) => m[1])));
  if (diskImage && lastIostat && excluded.has(diskImage) && lastIostat[diskImage] !== undefined) {
    const all = Object.values(lastIostat).reduce((sum, bps) => sum + bps, 0);
    const counted = Object.entries(lastIostat).filter(([name]) => !excluded.has(name)).reduce((sum, [, bps]) => sum + bps, 0);
    imageChecks.push({ image: lastIostat[diskImage], all, expected: counted, reported: sample.totalBps });
    const mb = (value) => (value / 1024 / 1024).toFixed(2);
    console.log(`[dmg] ${diskImage} ${mb(lastIostat[diskImage])} MB/s, all disks ${mb(all)} MB/s, ` +
      `expected total without disk images ${mb(counted)} MB/s, monitor total ${mb(sample.totalBps)} MB/s`);
  }
  const mb = (value) => (value === null ? 'n/a' : (value / 1024 / 1024).toFixed(2));
  console.log(`sample ${samples.length}: read ${mb(sample.readBps)} MB/s, write ${mb(sample.writeBps)} MB/s, total ${mb(sample.totalBps)} MB/s`);
});

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mds-smoke-'));

// macOS: attach a small disk image first. Its reads and writes also show
// on the disk holding the image file, so the monitor must leave it out.
if (process.platform === 'darwin') {
  try {
    const image = path.join(dir, 'smoke.dmg');
    execFileSync('/usr/bin/hdiutil', ['create', '-quiet', '-size', '32m', '-fs', 'HFS+', '-volname', 'MDSSmoke', image]);
    const attached = execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-plist', image], { encoding: 'utf8' });
    const device = attached.match(/<string>\/dev\/(disk\d+)<\/string>/)?.[1];
    if (!device) throw new Error('no /dev/diskN in the hdiutil attach output');
    diskImage = device;
    imageMount = attached.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
    const info = parsePlistValues(execFileSync('/usr/sbin/diskutil', ['info', '-plist', device], { encoding: 'utf8' }));
    console.log(`[dmg] attached ${image} as ${device}: BusProtocol=${info.BusProtocol}, ` +
      `VirtualOrPhysical=${info.VirtualOrPhysical}, MediaName=${info.MediaName}`);
  } catch (error) {
    console.log(`[dmg] could not attach a disk image, so that check is skipped: ${error.message}`);
  }
}

// Real disk I/O for the monitor to see: write and fsync a file over and over.
const file = path.join(dir, 'io.bin');
let writing = true;
async function generateIo() {
  while (writing) {
    const handle = await fs.open(file, 'w');
    try {
      for (let written = 0; writing && written < MAX_FILE_BYTES; written += CHUNK.length) {
        await handle.write(CHUNK);
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
  }
}

// macOS: also write (and fsync) a few MB at a time to the disk image, so
// the subtraction is checked against a non-zero rate.
async function generateImageIo() {
  if (!imageMount) return;
  const imageFile = path.join(imageMount, 'io.bin');
  const chunk = CHUNK.subarray(0, 1024 * 1024);
  while (writing) {
    const handle = await fs.open(imageFile, 'w');
    try {
      for (let written = 0; writing && written < 16 * chunk.length; written += chunk.length) {
        await handle.write(chunk);
        await handle.sync();
      }
    } finally {
      await handle.close();
    }
  }
}
const imageCheckDone = () => !diskImage || !imageMount || imageChecks.some((check) => check.image > 0);

console.log(`Platform ${process.platform}: starting the disk monitor${process.platform === 'win32' ? ` (Windows backend: ${windowsBackend})` : ''}.`);
const started = Date.now();
monitor.start();
const io = Promise.all([generateIo(), generateImageIo()]);

while (Date.now() - started < MAX_RUN_MS) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (Date.now() - started >= MIN_RUN_MS && samples.length >= MIN_SAMPLES && imageCheckDone()) break;
}

monitor.stop();
writing = false;
await io;
if (diskImage) {
  try {
    execFileSync('/usr/bin/hdiutil', ['detach', '-quiet', '-force', `/dev/${diskImage}`]);
  } catch (error) {
    console.log(`[dmg] could not detach /dev/${diskImage}: ${error.message}`);
  }
}
await fs.rm(dir, { recursive: true, force: true });

const failures = [];
if (samples.length < MIN_SAMPLES) {
  failures.push(`expected at least ${MIN_SAMPLES} samples in ${MAX_RUN_MS} ms, got ${samples.length}`);
}
const bad = samples.filter((s) => !isRate(s.readBps) || !isRate(s.writeBps) || !(Number.isFinite(s.totalBps) && s.totalBps >= 0) || !Number.isFinite(s.at));
if (bad.length > 0) failures.push(`samples with invalid numbers: ${JSON.stringify(bad)}`);
if (samples.length >= MIN_SAMPLES && !samples.some((s) => s.totalBps > 0)) {
  failures.push('every sample reported 0 bytes/s while the script was writing to disk');
}
if (diskImage && !imageListed) console.log(`[dmg] iostat never listed ${diskImage}, so there was nothing to leave out.`);
if (diskImage && imageListed && !notes.some((note) => /Not counting disk images/.test(note) && new RegExp(`\\b${diskImage}\\b`).test(note))) {
  failures.push(`the attached disk image ${diskImage} was not recognised as one, so it would be counted twice`);
}
if (diskImage && imageListed && imageMount) {
  const busy = imageChecks.filter((check) => check.image > 0);
  if (busy.length === 0) failures.push(`never saw writes on ${diskImage} after it was left out, so the subtraction went unchecked`);
  const wrong = imageChecks.filter((check) => Math.abs(check.reported - check.expected) > 1024);
  if (wrong.length > 0) failures.push(`the monitor total did not leave out the disk images: ${JSON.stringify(wrong)}`);
}
if (problems.length > 0) failures.push(`the monitor logged problems: ${problems.join(' | ')}`);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`FAIL after ${seconds} s:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`OK: ${samples.length} samples in ${seconds} s.`);
process.exit(0);
