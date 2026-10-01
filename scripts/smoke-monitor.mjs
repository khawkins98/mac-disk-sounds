// Smoke test for the real disk monitor backend on this machine: Linux
// /proc/diskstats, macOS iostat, Windows typeperf. Runs the DiskMonitor for
// a few seconds while writing (and fsyncing) a temporary file, then checks
// that the backend produced parsed samples with sane numbers.
//
//   node scripts/smoke-monitor.mjs
//
// Exits non-zero on failure. Used by CI on each platform.

import { DiskMonitor } from '../src/main/disk-monitor.js';
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
const logger = {
  log: (...args) => console.log('[monitor]', ...args),
  warn: (...args) => {
    console.warn('[monitor warn]', ...args);
    problems.push(args.join(' '));
  },
  error: (...args) => {
    console.error('[monitor error]', ...args);
    problems.push(args.join(' '));
  }
};

const isRate = (value) => value === null || (Number.isFinite(value) && value >= 0);

const monitor = new DiskMonitor({ logger });
monitor.on('sample', (sample) => {
  samples.push(sample);
  const mb = (value) => (value === null ? 'n/a' : (value / 1024 / 1024).toFixed(2));
  console.log(`sample ${samples.length}: read ${mb(sample.readBps)} MB/s, write ${mb(sample.writeBps)} MB/s, total ${mb(sample.totalBps)} MB/s`);
});

// Real disk I/O for the monitor to see: write and fsync a file over and over.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mds-smoke-'));
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

console.log(`Platform ${process.platform}: starting the disk monitor.`);
const started = Date.now();
monitor.start();
const io = generateIo();

while (Date.now() - started < MAX_RUN_MS) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (Date.now() - started >= MIN_RUN_MS && samples.length >= MIN_SAMPLES) break;
}

monitor.stop();
writing = false;
await io;
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
if (problems.length > 0) failures.push(`the monitor logged problems: ${problems.join(' | ')}`);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length > 0) {
  console.error(`FAIL after ${seconds} s:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`OK: ${samples.length} samples in ${seconds} s.`);
process.exit(0);
