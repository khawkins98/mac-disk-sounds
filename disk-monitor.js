import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import {
  parseDiskstats,
  diskstatsRate,
  splitLines,
  parseIostatLine,
  parseTypeperfLine
} from './disk-parsers.js';

const TYPEPERF_COUNTERS = [
  '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
  '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec'
];

// iostat -d shows only 4 disks unless told otherwise (sorted by name), which
// can hide a busy external drive.
const IOSTAT_MAX_DISKS = '64';

// A rate is a finite, non-negative number; anything else counts as 0.
// null stays null: it means "not reported" (read/write split on macOS).
export function cleanRate(value) {
  if (value === null) return null;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Samples whole-machine disk throughput about once a second.
 *
 * Emits `sample` with `{readBps, writeBps, totalBps, at}`. `at` is a
 * monotonic time in milliseconds (performance.now() by default), so wall
 * clock changes cannot disturb rates or the activity model's warm-up. On
 * macOS iostat only reports a combined rate, so `readBps` and `writeBps` are
 * null there and only `totalBps` is meaningful.
 *
 * Backends:
 * - linux: reads /proc/diskstats on a timer (no child processes).
 * - darwin: one long-lived `iostat -d -n 64 -w 1 -K`.
 * - win32: one long-lived `typeperf ... -si 1`.
 * Long-lived processes are restarted with backoff if they exit unexpectedly
 * and killed on stop(). Other platforms emit nothing.
 */
export class DiskMonitor extends EventEmitter {
  constructor({
    platform = process.platform,
    intervalMs = 1000,
    readFile = nodeReadFile,
    spawn = nodeSpawn,
    logger = console,
    // The restart delay doubles from `initial` to `max`, and goes back to
    // `initial` only after a process has stayed up for `stableMs`.
    backoffMs = { initial: 1000, max: 60000, stableMs: 10000 },
    now = () => performance.now()
  } = {}) {
    super();
    this.platform = platform;
    this.intervalMs = intervalMs;
    this.readFile = readFile;
    this.spawn = spawn;
    this.logger = logger;
    this.backoffMs = { initial: 1000, max: 60000, stableMs: 10000, ...backoffMs };
    this.now = now;
    this.running = false;
    this.backend = null;
    this.loggedOnce = new Set();
  }

  start() {
    if (this.running) return;
    this.running = true;
    switch (this.platform) {
      case 'linux':
        this.backend = this.#startLinux();
        break;
      case 'darwin':
        this.backend = this.#startProcess({
          command: '/usr/sbin/iostat',
          args: ['-d', '-n', IOSTAT_MAX_DISKS, '-w', '1', '-K'],
          makeLineHandler: (emit) => iostatLineHandler(emit)
        });
        break;
      case 'win32':
        this.backend = this.#startProcess({
          command: path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'typeperf.exe'),
          args: [...TYPEPERF_COUNTERS, '-si', '1'],
          makeLineHandler: (emit) => (line) => {
            const parsed = parseTypeperfLine(line);
            if (parsed.kind === 'data') emit(parsed.readBps, parsed.writeBps);
          }
        });
        break;
      default:
        this.#logOnce('unsupported', 'warn',
          `Disk activity monitoring is not supported on ${this.platform}; no disk sounds will play.`);
        this.backend = { stop() {} };
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.backend?.stop();
    this.backend = null;
  }

  // Samples from a backend that has been stopped or replaced are dropped.
  #emitSample(backend, readBps, writeBps, totalBps) {
    if (!this.running || backend !== this.backend) return;
    const read = cleanRate(readBps);
    const write = cleanRate(writeBps);
    const total = totalBps === undefined ? (read ?? 0) + (write ?? 0) : cleanRate(totalBps) ?? 0;
    this.emit('sample', { readBps: read, writeBps: write, totalBps: total, at: this.now() });
  }

  #logOnce(key, level, ...args) {
    if (this.loggedOnce.has(key)) return;
    this.loggedOnce.add(key);
    this.logger[level](...args);
  }

  #startLinux() {
    let previous = null;
    let reading = false;
    let stopped = false;
    let timer = null;
    const backend = {
      stop() {
        stopped = true;
        clearInterval(timer);
      }
    };

    const tick = async () => {
      if (reading || stopped) return;
      reading = true;
      try {
        const text = await this.readFile('/proc/diskstats', 'utf8');
        if (stopped) return;
        const totals = parseDiskstats(text);
        const at = this.now();
        if (totals.devices.length === 0) {
          this.#logOnce('no-disks', 'warn', 'No whole-disk devices found in /proc/diskstats; no disk sounds will play.');
        }
        // When a disk appears or disappears, its lifetime counters would
        // look like a burst; start a fresh baseline instead.
        const deviceKey = totals.devices.join(' ');
        if (previous && previous.deviceKey === deviceKey) {
          const { readBps, writeBps } = diskstatsRate(previous, totals, at - previous.at);
          this.#emitSample(backend, readBps, writeBps);
        }
        previous = { ...totals, deviceKey, at };
      } catch (error) {
        this.#logOnce('diskstats', 'error', 'Cannot read /proc/diskstats; no disk sounds will play.', error);
      } finally {
        reading = false;
      }
    };

    tick();
    timer = setInterval(tick, this.intervalMs);
    return backend;
  }

  #startProcess({ command, args, makeLineHandler }) {
    let child = null;
    let restartTimer = null;
    let delay = this.backoffMs.initial;
    let failureLogged = false;
    let stopped = false;
    const name = path.basename(command);
    const backend = {
      stop() {
        stopped = true;
        clearTimeout(restartTimer);
        restartTimer = null;
        if (child) {
          child.kill();
          child = null;
        }
      }
    };

    const scheduleRestart = (description, stderr = '') => {
      if (stopped || restartTimer) return;
      // Log the first failure of a run of failures, not every retry.
      if (!failureLogged) {
        failureLogged = true;
        this.logger.warn(`${name} ${description}; restarting with backoff.`, stderr.trim());
      }
      restartTimer = setTimeout(launch, delay);
      delay = Math.min(delay * 2, this.backoffMs.max);
    };

    const launch = () => {
      restartTimer = null;
      if (stopped) return;
      let buffered = '';
      let stderr = '';
      let current;

      try {
        current = this.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        scheduleRestart(`could not be started (${error.message})`);
        return;
      }
      child = current;
      const launchedAt = this.now();

      // Only the current child of a running backend may emit.
      const emit = (readBps, writeBps, totalBps) => {
        if (stopped || child !== current) return;
        this.#emitSample(backend, readBps, writeBps, totalBps);
      };
      const onLine = makeLineHandler(emit);

      current.stdout.setEncoding('utf8');
      current.stdout.on('data', (chunk) => {
        const { lines, rest } = splitLines(buffered, chunk);
        buffered = rest;
        for (const line of lines) onLine(line);
      });
      current.stderr?.setEncoding('utf8');
      current.stderr?.on('data', (chunk) => {
        if (stderr.length < 2000) stderr += chunk;
      });

      let finished = false;
      const finish = (description) => {
        if (finished) return;
        finished = true;
        if (child === current) child = null;
        if (stopped) return;
        // A process that stayed up for a while was healthy: start the
        // backoff again from the beginning. A crash loop keeps backing off.
        if (this.now() - launchedAt >= this.backoffMs.stableMs) {
          delay = this.backoffMs.initial;
          failureLogged = false;
        }
        scheduleRestart(description, stderr);
      };
      current.on('error', (error) => finish(`failed (${error.message})`));
      current.on('exit', (code, signal) => finish(`exited (code ${code}, signal ${signal})`));
    };

    launch();
    return backend;
  }
}

/**
 * Line handler for one iostat process. The first report is the average
 * since boot, and when the set of disks shown changes (a disk is attached,
 * or slides into the visible set) iostat reprints the device line and the
 * next report counts a new disk's bytes since boot. Skip the data line after
 * any change of device line, which also covers the first one.
 */
export function iostatLineHandler(emit) {
  let mbColumns = null;
  let devices = null;
  let skipNext = true;
  return (line) => {
    const parsed = parseIostatLine(line, mbColumns);
    switch (parsed.kind) {
      case 'devices': {
        const key = parsed.names.join(' ');
        if (key !== devices) {
          devices = key;
          skipNext = true;
        }
        break;
      }
      case 'header':
        mbColumns = parsed.mbColumns;
        break;
      case 'data':
        if (skipNext) {
          skipNext = false;
        } else {
          emit(null, null, parsed.totalBps);
        }
        break;
    }
  };
}
