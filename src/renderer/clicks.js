// Click density, shared by the audio window (which plays the clicks) and the
// settings window (which blinks the activity dots at the same pace).

// Clicks per second for each activity level (index 0 = idle).
export const CLICKS_PER_SECOND = Object.freeze([0, 1.5, 2.5, 4, 6, 9]);

/** Seconds until the next click at `level` (1-5), with seek-like jitter. */
export function nextInterval(level) {
  return (1 / CLICKS_PER_SECOND[level]) * (0.4 + Math.random() * 1.2);
}
