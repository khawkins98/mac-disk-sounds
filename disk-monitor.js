import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
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

/**
 * Samples whole-machine disk throughput about once a second.
 *
 * Emits `sample` with `{readBps, writeBps, totalBps, at}`. On macOS iostat
 * only reports a combined rate, so `readBps` and `writeBps` are null there
 * and only `totalBps` is meaningful.
 *
 * Backends:
 * - linux: reads /proc/diskstats on a timer (no child processes).
 * - darwin: one long-lived `iostat -d -w 1 -K`.
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
    backoffMs = { initial: 1000, max: 60000 },
    now = Date.now
  } = {}) {
    super();
    this.platform = platform;
    this.intervalMs = intervalMs;
    this.readFile = readFile;
    this.spawn = spawn;
    this.logger = logger;
    this.backoffMs = backoffMs;
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
          args: ['-d', '-w', '1', '-K'],
          makeLineHandler: () => this.#iostatLineHandler()
        });
        break;
      case 'win32':
        this.backend = this.#startProcess({
          command: path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'typeperf.exe'),
          args: [...TYPEPERF_COUNTERS, '-si', '1'],
          makeLineHandler: () => (line) => {
            const parsed = parseTypeperfLine(line);
            if (parsed.kind !== 'data') return false;
            this.#emitSample(parsed.readBps, parsed.writeBps);
            return true;
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

  #emitSample(readBps, writeBps, totalBps = readBps + writeBps) {
    if (!this.running) return;
    this.emit('sample', { readBps, writeBps, totalBps, at: this.now() });
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
          this.#emitSample(readBps, writeBps);
        }
        previous = { ...totals, deviceKey, at };
      } catch (error) {
        this.#logOnce('diskstats', 'error', 'Cannot read /proc/diskstats; no disk sounds will play.', error);
      } finally {
        reading = false;
      }
    };

    tick();
    const timer = setInterval(tick, this.intervalMs);
    return {
      stop() {
        stopped = true;
        clearInterval(timer);
      }
    };
  }

  #iostatLineHandler() {
    let mbColumns = null;
    // The first report is the average since boot, not the last second.
    let skippedFirst = false;
    return (line) => {
      const parsed = parseIostatLine(line, mbColumns);
      if (parsed.kind === 'header') {
        mbColumns = parsed.mbColumns;
        return false;
      }
      if (parsed.kind !== 'data') return false;
      if (!skippedFirst) {
        skippedFirst = true;
        return false;
      }
      this.#emitSample(null, null, parsed.totalBps);
      return true;
    };
  }

  #startProcess({ command, args, makeLineHandler }) {
    let child = null;
    let restartTimer = null;
    let delay = this.backoffMs.initial;
    let stopped = false;
    const name = path.basename(command);

    const launch = () => {
      restartTimer = null;
      if (stopped) return;
      const onLine = makeLineHandler();
      let buffered = '';
      let stderr = '';

      try {
        child = this.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        this.logger.error(`Could not start ${name}:`, error);
        scheduleRestart();
        return;
      }
      const current = child;

      current.stdout.setEncoding('utf8');
      current.stdout.on('data', (chunk) => {
        const { lines, rest } = splitLines(buffered, chunk);
        buffered = rest;
        for (const line of lines) {
          // A process that is producing samples is healthy again.
          if (onLine(line)) delay = this.backoffMs.initial;
        }
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
        this.logger.warn(`${name} ${description}; restarting in ${delay / 1000} s.`, stderr.trim());
        scheduleRestart();
      };
      current.on('error', (error) => finish(`failed (${error.message})`));
      current.on('exit', (code, signal) => finish(`exited (code ${code}, signal ${signal})`));
    };

    const scheduleRestart = () => {
      if (stopped || restartTimer) return;
      restartTimer = setTimeout(launch, delay);
      delay = Math.min(delay * 2, this.backoffMs.max);
    };

    launch();
    return {
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
  }
}
