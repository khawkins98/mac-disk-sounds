import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import {
  parseDiskstats,
  diskstatsRate,
  splitLines,
  parseIostatLine,
  parseTypeperfLine,
  parseCimDiskLine,
  cimDiskRate,
  parsePlistValues,
  isDiskImageInfo
} from './disk-parsers.js';

// typeperf takes counter paths by their display names, which Windows
// translates: on a German install this is "\Physikalischer Datenträger...",
// and the English names fail. So typeperf is only the fallback.
const TYPEPERF_COUNTERS = [
  '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',
  '\\PhysicalDisk(_Total)\\Disk Write Bytes/sec'
];

// The primary Windows backend: one long-lived PowerShell that reads the raw
// disk counters through CIM once a second. WMI class and property names are
// never translated, so this works whatever the display language. The raw
// counters are cumulative byte counts plus the counter clock; the rates are
// worked out here (parseCimDiskLine, cimDiskRate) rather than trusting the
// "formatted" class, whose rates depend on when the WMI provider last
// sampled. The line is written with the invariant culture and flushed
// straight away, since PowerShell otherwise buffers output to a pipe.
//
// One CIM session (over DCOM, which needs no WinRM service) is opened before
// the loop and reused, rather than a new connection every second; if it
// cannot be opened, each query connects on its own as before.
//
// The script is one line with no double quotes or backslashes, so passing
// it as one -Command argument needs no escaping on the Windows command line.
const CIM_LOOP_BODY = [
  "$d = Get-CimInstance @q -ClassName Win32_PerfRawData_PerfDisk_PhysicalDisk -Filter 'Name=''_Total''' | Select-Object -First 1",
  "if ($d) { [Console]::Out.WriteLine([string]::Format($inv, 'MDS,{0},{1},{2},{3}', $d.Timestamp_PerfTime, $d.Frequency_PerfTime, $d.DiskReadBytesPersec, $d.DiskWriteBytesPersec)); [Console]::Out.Flush() }",
  'Start-Sleep -Seconds 1'
].join('; ');
export const CIM_DISK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$inv = [Globalization.CultureInfo]::InvariantCulture',
  '$q = @{}',
  'try { $q.CimSession = New-CimSession -SessionOption (New-CimSessionOption -Protocol Dcom) } catch { }',
  `while ($true) { ${CIM_LOOP_BODY} }`
].join('; ');

export const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', CIM_DISK_SCRIPT];

// If PowerShell/CIM has produced no sample this long after starting,
// typeperf covers for it until it does. PowerShell itself can take several
// seconds to start on a cold, busy machine, and the first sample needs two
// readings.
const WINDOWS_FALLBACK_MS = 20000;
// Longest wait between PowerShell restarts while typeperf covers for it.
const CIM_MAX_BACKOFF_MS = 5 * 60 * 1000;

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
 * - darwin: one long-lived `iostat -d -n 64 -w 1 -K`. Mounted disk images
 *   are left out of the total (their I/O also shows on the disk holding the
 *   image file); see findDiskImages.
 * - win32: one long-lived PowerShell reading the raw disk counters through
 *   CIM (CIM_DISK_SCRIPT), which works on any display language. While it
 *   is not delivering (its process failed, or no sample yet after
 *   `windowsFallbackMs`), one long-lived `typeperf ... -si 1` covers for
 *   it; typeperf needs English counter names. PowerShell keeps being
 *   retried, and its first sample stops typeperf. `windowsBackend` ('cim'
 *   or 'typeperf') forces one of them, with no fallback.
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
    windowsBackend = 'auto',
    windowsFallbackMs = WINDOWS_FALLBACK_MS,
    env = process.env,
    // Used on macOS to run diskutil (see findDiskImages).
    execFile = nodeExecFile,
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
    this.windowsBackend = windowsBackend;
    this.windowsFallbackMs = windowsFallbackMs;
    this.env = env;
    this.execFile = execFile;
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
          makeLineHandler: (emit) => iostatLineHandler(emit, (names) =>
            findDiskImages(names, { execFile: this.execFile, logger: this.logger }))
        });
        break;
      case 'win32':
        this.backend = this.#startWindows();
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
  // Returns whether the sample was emitted.
  #emitSample(backend, readBps, writeBps, totalBps) {
    if (!this.running || backend !== this.backend) return false;
    const read = cleanRate(readBps);
    const write = cleanRate(writeBps);
    const total = totalBps === undefined ? (read ?? 0) + (write ?? 0) : cleanRate(totalBps) ?? 0;
    this.emit('sample', { readBps: read, writeBps: write, totalBps: total, at: this.now() });
    return true;
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

  #windowsCommand(...parts) {
    return path.win32.join(this.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts);
  }

  #startCim(owner, { onSample = null, onFailure = null } = {}) {
    return this.#startProcess({
      command: this.#windowsCommand('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: POWERSHELL_ARGS,
      makeLineHandler: (emit) => cimLineHandler(emit),
      owner,
      onSample,
      onFailure,
      // While typeperf covers for it, retrying PowerShell every minute would
      // cost a second of CPU each time; back off further.
      maxBackoffMs: owner ? CIM_MAX_BACKOFF_MS : undefined
    });
  }

  #startTypeperf(owner) {
    return this.#startProcess({
      command: this.#windowsCommand('typeperf.exe'),
      args: [...TYPEPERF_COUNTERS, '-si', '1'],
      makeLineHandler: (emit) => (line) => {
        const parsed = parseTypeperfLine(line);
        if (parsed.kind === 'data') emit(parsed.readBps, parsed.writeBps);
      },
      owner
    });
  }

  // CIM always runs (restarted with backoff if it exits). typeperf covers
  // for it while it is not delivering: from when the PowerShell process
  // fails (exits or cannot start), or after windowsFallbackMs without a
  // sample (a slow start), until CIM produces a sample, which stops
  // typeperf again.
  #startWindows() {
    if (this.windowsBackend === 'cim') return this.#startCim();
    if (this.windowsBackend === 'typeperf') return this.#startTypeperf();
    let cim = null;
    let typeperf = null;
    let timer = null;
    let stopped = false;
    const backend = {
      stop() {
        stopped = true;
        clearTimeout(timer);
        cim?.stop();
        typeperf?.stop();
        typeperf = null;
      }
    };
    const startTypeperf = (reason) => {
      clearTimeout(timer);
      if (stopped || typeperf || !this.running || this.backend !== backend) return;
      this.#logOnce('cim-fallback', 'warn',
        `PowerShell/CIM ${reason}; using typeperf (which needs English performance counter names) until it works.`);
      typeperf = this.#startTypeperf(backend);
    };
    cim = this.#startCim(backend, {
      onSample: () => {
        clearTimeout(timer);
        if (!typeperf) return;
        typeperf.stop();
        typeperf = null;
        this.logger.log('PowerShell/CIM is giving disk samples; typeperf stopped.');
      },
      onFailure: () => startTypeperf('failed')
    });
    timer = setTimeout(() => startTypeperf(`gave no disk samples in ${this.windowsFallbackMs / 1000} s`), this.windowsFallbackMs);
    return backend;
  }

  // `owner` is the backend object samples are checked against (this one,
  // unless it is part of a composite backend); `onSample` is called after
  // each sample it emits, `onFailure` whenever the process exits or cannot
  // be started (before the restart).
  #startProcess({ command, args, makeLineHandler, owner = null, onSample = null, onFailure = null, maxBackoffMs = this.backoffMs.max }) {
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
      delay = Math.min(delay * 2, maxBackoffMs);
      onFailure?.();
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
        if (this.#emitSample(owner ?? backend, readBps, writeBps, totalBps)) onSample?.();
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
 *
 * `findExcluded(names)`, if given, is called once per change of the device
 * set and resolves to the set of names not to count (disk images, see
 * findDiskImages). Until it resolves, or if it fails, every disk counts.
 */
export function iostatLineHandler(emit, findExcluded = null) {
  let mbColumns = null;
  let devices = null;
  let names = [];
  let excluded = new Set();
  let skipNext = true;
  let generation = 0;
  return (line) => {
    const parsed = parseIostatLine(line, mbColumns);
    switch (parsed.kind) {
      case 'devices': {
        const key = parsed.names.join(' ');
        if (key !== devices) {
          devices = key;
          names = parsed.names;
          excluded = new Set();
          skipNext = true;
          if (findExcluded) {
            const current = ++generation;
            Promise.resolve()
              .then(() => findExcluded(parsed.names))
              .then((found) => {
                if (current === generation && found instanceof Set) excluded = found;
              }, () => {});
          }
        }
        break;
      }
      case 'header':
        mbColumns = parsed.mbColumns;
        break;
      case 'data':
        if (skipNext) {
          skipNext = false;
        } else if (excluded.size > 0 && parsed.deviceBps.length === names.length) {
          const counted = parsed.deviceBps.filter((_, i) => !excluded.has(names[i]));
          emit(null, null, counted.reduce((sum, bps) => sum + bps, 0));
        } else {
          emit(null, null, parsed.totalBps);
        }
        break;
    }
  };
}

/**
 * Which of the iostat disk names are mounted disk images, by asking
 * `diskutil info -plist` about each (in parallel, once per change of the
 * device set). A disk diskutil cannot describe (an error, a timeout,
 * unexpected output) is counted, so a failure here can only mean double
 * counting, never missing activity.
 * @param {string[]} names e.g. ['disk0', 'disk4']
 * @returns {Promise<Set<string>>}
 */
export async function findDiskImages(names, { execFile = nodeExecFile, timeoutMs = 5000, logger = console } = {}) {
  const results = await Promise.all(names.map((name) => new Promise((resolve) => {
    if (!/^disk\d+$/.test(name)) {
      resolve(false);
      return;
    }
    try {
      execFile('/usr/sbin/diskutil', ['info', '-plist', name], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
          logger.log(`Cannot tell whether ${name} is a disk image (${error.message.trim()}); counting it.`);
          resolve(false);
          return;
        }
        const info = parsePlistValues(String(stdout));
        resolve(isDiskImageInfo(info) ? info : false);
      });
    } catch (error) {
      logger.log(`Cannot run diskutil (${error.message}); counting every disk.`);
      resolve(false);
    }
  })));
  const images = new Set(names.filter((_, i) => results[i]));
  if (images.size > 0) {
    const described = names.flatMap((name, i) => {
      const info = results[i];
      return info ? [`${name} (BusProtocol=${info.BusProtocol}, VirtualOrPhysical=${info.VirtualOrPhysical}, MediaName=${info.MediaName})`] : [];
    });
    logger.log(`Not counting disk images (already counted on the disk holding them): ${described.join(', ')}`);
  }
  return images;
}

/**
 * Line handler for one PowerShell/CIM process. Each line carries cumulative
 * counters; the first is only a baseline, every later one emits the rates
 * since the one before. A snapshot whose clock went backwards (a counter
 * reset) becomes the new baseline; one that repeats the last is ignored.
 */
export function cimLineHandler(emit) {
  let previous = null;
  return (line) => {
    const parsed = parseCimDiskLine(line);
    if (parsed.kind !== 'data') return;
    if (previous === null) {
      previous = parsed;
      return;
    }
    const rate = cimDiskRate(previous, parsed);
    if (rate) {
      emit(rate.readBps, rate.writeBps);
      previous = parsed;
    } else if (parsed.timestamp !== previous.timestamp) {
      previous = parsed;
    }
  };
}
