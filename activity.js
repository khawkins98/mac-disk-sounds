// Turns raw disk throughput samples into "is the disk busy, and how busy"
// for the renderer. Pure: no timers, no Electron, time comes from samples.

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
  // Throughput that maps to the top level bucket.
  maxBps: 256 * 1024 * 1024,
  // Samples this soon after start are ignored, so the app's own startup I/O
  // (loading and decoding its sound files) does not click.
  warmupMs: 5000
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
 * Feed it samples with update(); it returns the new state when the
 * active/idle state or the level bucket changes, and null otherwise.
 *
 * State: {active, level, readBps, writeBps, totalBps}. level is 0 when idle
 * and 1..5 when active. The rates are from the sample that caused the change;
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
    this.above = 0;
    this.below = 0;
    this.state = { active: false, level: 0, readBps: 0, writeBps: 0, totalBps: 0 };
  }

  /**
   * @param {{readBps: number|null, writeBps: number|null, totalBps?: number, at: number}} sample
   * @returns {{active: boolean, level: number, readBps: number|null, writeBps: number|null, totalBps: number} | null}
   */
  update(sample) {
    const o = this.options;
    if (this.startedAt === null) this.startedAt = sample.at;
    if (sample.at - this.startedAt < o.warmupMs) return null;

    const total = sample.totalBps ?? (sample.readBps ?? 0) + (sample.writeBps ?? 0);
    const busy = total >= o.thresholdBps;

    if (busy) {
      this.above += 1;
      this.below = 0;
    } else {
      this.below += 1;
      this.above = 0;
    }

    let active = this.state.active;
    if (!active && busy && (this.above >= o.samplesToActivate || total >= o.burstBps)) {
      active = true;
    } else if (active && !busy && this.below >= o.samplesToIdle) {
      active = false;
    }

    // While active but briefly below the threshold, keep clicking gently.
    const level = active ? Math.max(1, levelForBps(total, o)) : 0;

    if (active === this.state.active && level === this.state.level) return null;
    this.state = { active, level, readBps: sample.readBps, writeBps: sample.writeBps, totalBps: total };
    return this.state;
  }
}
