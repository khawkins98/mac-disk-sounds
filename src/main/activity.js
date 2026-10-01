// Turns raw disk throughput samples into "is the disk busy, and how busy"
// for the renderer. Pure: no timers, no Electron, time comes from samples
// (a monotonic clock in milliseconds; see DiskMonitor).

export const DEFAULTS = Object.freeze({
  // Combined read+write throughput below which the disk counts as idle.
  // Background housekeeping (logs, caches) rarely exceeds this.
  thresholdBps: 64 * 1024,
  // A single sample at or above this goes active at once.
  burstBps: 4 * 1024 * 1024,
  // Consecutive samples above the threshold needed to go active.
  samplesToActivate: 2,
  // Consecutive samples below the threshold needed to go idle.
  samplesToIdle: 3,
  // Periodic writers. A background job that writes a burst every few
  // seconds would otherwise click (and, on macOS, hold the power assertion)
  // forever: a short gap never leaves `samplesToIdle` quiet samples, and a
  // long gap ends each spell only for the next burst to start another.
  // The last `dutyWindow` samples are kept across active and idle spells.
  // The pattern counts as periodic when that window holds at least
  // `periodicRuns` separate busy runs and either less than `minDutyCycle`
  // of it was busy or every run was a single sample (a writer every 2 s).
  // Real work that is busy half the time in runs of 2 s or more is not.
  // While periodic, a quiet sample ends an active spell at once, and going
  // active needs `periodicSamplesToActivate` busy samples in a row (no
  // single-burst shortcut), so real load on top of the writer still starts
  // clicking within a few seconds. It stops counting as periodic once the
  // window no longer holds `periodicRuns` runs, i.e. after up to
  // `dutyWindow` seconds without the pattern.
  dutyWindow: 24,
  minDutyCycle: 0.5,
  periodicRuns: 3,
  periodicSamplesToActivate: 3,
  // Throughput that maps to the top level bucket.
  maxBps: 256 * 1024 * 1024,
  // Samples this soon after start are ignored, so the app's own startup I/O
  // (loading and decoding its sound files) does not click.
  warmupMs: 5000,
  // While active, also report the current rates at most this often even if
  // nothing else changed, so the speed readout stays live. Samples arrive
  // about a second apart; 900 ms lets every one through despite jitter.
  refreshMs: 900
});

export const MAX_LEVEL = 5;

/**
 * Map throughput to a level bucket 0..5 on a log scale. 0 is below the
 * threshold; the range threshold..maxBps is split into five buckets of equal
 * width in log(bytes/s), and anything above maxBps is 5. With the defaults
 * levels 1-5 start at about 64 KB/s, 337 KB/s, 1.7 MB/s, 9.2 MB/s and 48 MB/s.
 */
export function levelForBps(bps, { thresholdBps = DEFAULTS.thresholdBps, maxBps = DEFAULTS.maxBps } = {}) {
  if (!(bps >= thresholdBps)) return 0;
  const fraction = Math.log(bps / thresholdBps) / Math.log(maxBps / thresholdBps);
  return Math.min(MAX_LEVEL, 1 + Math.floor(fraction * MAX_LEVEL));
}

/**
 * Whether a window of busy/quiet samples looks like a periodic writer:
 * at least `periodicRuns` separate busy runs, and either less than
 * `minDutyCycle` busy or every run a single sample. See DEFAULTS.
 * @param {boolean[]} history oldest first
 */
export function isPeriodic(history, { periodicRuns, minDutyCycle } = DEFAULTS) {
  const runs = [];
  let run = 0;
  for (const busy of history) {
    if (busy) {
      run += 1;
    } else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);
  if (runs.length < periodicRuns) return false;
  const busyCount = runs.reduce((sum, length) => sum + length, 0);
  return busyCount < minDutyCycle * history.length || runs.every((length) => length === 1);
}

/**
 * Feed it samples with update(). It returns the current state when the
 * active/idle state or the level bucket changes, when going idle, and, while
 * active, at most every `refreshMs` with fresh rates; otherwise null.
 *
 * State: {active, level, readBps, writeBps, totalBps}. level is 0 when idle
 * and 1..5 when active. The rates are from the latest sample;
 * readBps/writeBps are null when the platform cannot split reads from writes
 * (macOS).
 */
export class ActivityModel {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.reset(null);
  }

  /** Start (or restart) the warm-up window at time `at` (ms). */
  reset(at) {
    this.startedAt = at;
    this.warmedUp = false;
    this.above = 0;
    this.below = 0;
    // Busy (true) or quiet (false) for the last `dutyWindow` samples, kept
    // across active and idle spells.
    this.history = [];
    // Whether the window looks like a periodic writer (see DEFAULTS).
    this.periodic = false;
    this.lastReportAt = null;
    this.state = { active: false, level: 0, readBps: 0, writeBps: 0, totalBps: 0 };
  }

  /**
   * @param {{readBps: number|null, writeBps: number|null, totalBps?: number, at: number}} sample
   * @returns {{active: boolean, level: number, readBps: number|null, writeBps: number|null, totalBps: number} | null}
   */
  update(sample) {
    const o = this.options;
    if (!this.warmedUp) {
      // A clock that went backwards restarts the window rather than
      // stretching it; once warmed up this is never checked again.
      if (this.startedAt === null || sample.at < this.startedAt) this.startedAt = sample.at;
      if (sample.at - this.startedAt < o.warmupMs) return null;
      this.warmedUp = true;
    }

    const total = sample.totalBps ?? (sample.readBps ?? 0) + (sample.writeBps ?? 0);
    const busy = total >= o.thresholdBps;

    if (busy) {
      this.above += 1;
      this.below = 0;
    } else {
      this.below += 1;
      this.above = 0;
    }
    this.history.push(busy);
    if (this.history.length > o.dutyWindow) this.history.shift();
    this.periodic = isPeriodic(this.history, o);

    let active = this.state.active;
    if (!active && busy) {
      active = this.periodic
        ? this.above >= o.periodicSamplesToActivate
        : this.above >= o.samplesToActivate || total >= o.burstBps;
    } else if (active && !busy) {
      active = !(this.periodic || this.below >= o.samplesToIdle);
    }

    // While active but briefly below the threshold, keep clicking gently.
    const level = active ? Math.max(1, levelForBps(total, o)) : 0;

    const changed = active !== this.state.active || level !== this.state.level;
    const elapsed = this.lastReportAt === null ? Infinity : sample.at - this.lastReportAt;
    // A backwards clock step (elapsed < 0) also refreshes, then resyncs.
    const refresh = active && (elapsed >= o.refreshMs || elapsed < 0);
    if (!changed && !refresh) return null;

    this.lastReportAt = sample.at;
    this.state = { active, level, readBps: sample.readBps, writeBps: sample.writeBps, totalBps: total };
    return this.state;
  }
}
