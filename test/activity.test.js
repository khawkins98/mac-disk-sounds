import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityModel, levelForBps, DEFAULTS } from '../activity.js';

const KIB = 1024;
const MIB = 1024 * KIB;

// Feed samples one second apart, starting after the warm-up window.
function feed(model, rates, { startAt = DEFAULTS.warmupMs } = {}) {
  return rates.map((bps, i) => model.update({ readBps: bps, writeBps: 0, at: startAt + i * 1000 }));
}

function startedModel(options) {
  const model = new ActivityModel(options);
  model.reset(0);
  return model;
}

test('levelForBps is 0 below the threshold and 1-5 on a log scale above it', () => {
  assert.equal(levelForBps(0), 0);
  assert.equal(levelForBps(64 * KIB - 1), 0);
  assert.equal(levelForBps(64 * KIB), 1);
  assert.equal(levelForBps(300 * KIB), 1);
  assert.equal(levelForBps(400 * KIB), 2);
  assert.equal(levelForBps(2 * MIB), 3);
  assert.equal(levelForBps(10 * MIB), 4);
  assert.equal(levelForBps(50 * MIB), 5);
  assert.equal(levelForBps(256 * MIB), 5);
  assert.equal(levelForBps(10 * 1024 * MIB), 5);
  assert.equal(levelForBps(NaN), 0);
});

test('levelForBps buckets are monotonic', () => {
  let previous = 0;
  for (let bps = 1; bps < 1024 * MIB; bps *= 1.1) {
    const level = levelForBps(bps);
    assert.ok(level >= previous, `level dropped at ${bps}`);
    previous = level;
  }
  assert.equal(previous, 5);
});

test('stays idle at zero and under the threshold', () => {
  const model = startedModel();
  const changes = feed(model, [0, 0, 10 * KIB, 63 * KIB, 0, 32 * KIB, 0]);
  assert.ok(changes.every((c) => c === null));
  assert.equal(model.state.active, false);
});

test('needs N consecutive samples above the threshold to go active', () => {
  const model = startedModel();
  // Isolated blips above the threshold are ignored.
  assert.deepEqual(feed(model, [100 * KIB, 0, 100 * KIB, 0]), [null, null, null, null]);
  const changes = feed(model, [100 * KIB, 100 * KIB], { startAt: 10000 });
  assert.equal(changes[0], null);
  assert.deepEqual(changes[1], { active: true, level: 1, readBps: 100 * KIB, writeBps: 0, totalBps: 100 * KIB });
});

test('one big burst goes active immediately', () => {
  const model = startedModel();
  const [change] = feed(model, [DEFAULTS.burstBps]);
  assert.equal(change.active, true);
  assert.equal(change.level, levelForBps(DEFAULTS.burstBps));
});

test('needs M consecutive samples below the threshold to go idle', () => {
  const model = startedModel({ refreshMs: Infinity });
  feed(model, [100 * MIB]);
  assert.equal(model.state.active, true);
  // Two quiet seconds, a busy one, then three quiet ones.
  const changes = feed(model, [0, 0, 100 * MIB, 0, 0, 0], { startAt: 6000 });
  assert.deepEqual(changes.map((c) => c && [c.active, c.level]), [
    [true, 1], // still active, gentle level while it is quiet
    null,
    [true, 5],
    [true, 1],
    null,
    [false, 0]
  ]);
});

test('without refreshes, reports only state or level changes', () => {
  const model = startedModel({ refreshMs: Infinity });
  const changes = feed(model, [100 * MIB, 120 * MIB, 90 * MIB, 2 * MIB, 2.5 * MIB, 100 * MIB]);
  assert.deepEqual(changes.map((c) => c && c.level), [5, null, null, 3, null, 5]);
});

test('ignores samples during the warm-up window after start', () => {
  const model = new ActivityModel();
  model.reset(1000);
  const during = [1000, 2000, 3000, 4000, 5999].map((at) => model.update({ readBps: 500 * MIB, writeBps: 0, at }));
  assert.ok(during.every((c) => c === null));
  assert.equal(model.state.active, false);
  const after = model.update({ readBps: 500 * MIB, writeBps: 0, at: 6000 });
  assert.equal(after.active, true);
});

test('warm-up starts at the first sample when reset without a time', () => {
  const model = new ActivityModel({ warmupMs: 2000 });
  assert.equal(model.update({ readBps: 500 * MIB, writeBps: 0, at: 50000 }), null);
  assert.equal(model.update({ readBps: 500 * MIB, writeBps: 0, at: 51000 }), null);
  assert.equal(model.update({ readBps: 500 * MIB, writeBps: 0, at: 52000 }).active, true);
});

test('reset returns to idle and restarts the warm-up', () => {
  const model = startedModel();
  feed(model, [100 * MIB]);
  model.reset(100000);
  assert.equal(model.state.active, false);
  assert.equal(model.update({ readBps: 100 * MIB, writeBps: 0, at: 101000 }), null);
});

test('uses totalBps when reads and writes are not split (macOS)', () => {
  const model = startedModel();
  const change = model.update({ readBps: null, writeBps: null, totalBps: 50 * MIB, at: 5000 });
  assert.deepEqual(change, { active: true, level: 5, readBps: null, writeBps: null, totalBps: 50 * MIB });
});

test('sums reads and writes against the threshold', () => {
  const model = startedModel({ samplesToActivate: 1 });
  const change = model.update({ readBps: 40 * KIB, writeBps: 40 * KIB, at: 5000 });
  assert.equal(change.active, true);
  assert.equal(change.totalBps, 80 * KIB);
});

test('while active, refreshes the rates about once a second', () => {
  const model = startedModel();
  const at = (t) => DEFAULTS.warmupMs + t;
  const send = (bps, t) => model.update({ readBps: 0, writeBps: bps, at: at(t) });
  assert.equal(send(100 * MIB, 0).level, 5);
  // Same level 400 ms later: too soon for a refresh.
  assert.equal(send(110 * MIB, 400), null);
  // A second after the last report: refreshed with the new rate.
  const refreshed = send(120 * MIB, 1000);
  assert.deepEqual(refreshed, { active: true, level: 5, readBps: 0, writeBps: 120 * MIB, totalBps: 120 * MIB });
  // Jitter: 950 ms later still refreshes.
  assert.equal(send(130 * MIB, 1950).totalBps, 130 * MIB);
});

test('reports going idle once and is then silent', () => {
  const model = startedModel();
  const changes = feed(model, [100 * MIB, 0, 0, 0, 0, 0]);
  assert.deepEqual(changes.map((c) => c && [c.active, c.level, c.totalBps]), [
    [true, 5, 100 * MIB],
    [true, 1, 0],
    [true, 1, 0], // refresh while winding down
    [false, 0, 0],
    null,
    null
  ]);
});

test('a backwards clock jump after warm-up does not mute it', () => {
  const model = startedModel();
  assert.equal(model.update({ readBps: 100 * MIB, writeBps: 0, at: 10000 }).active, true);
  // The clock goes back an hour.
  const back = 10000 - 3600 * 1000;
  const after = model.update({ readBps: 100 * MIB, writeBps: 0, at: back });
  assert.ok(after, 'still reports after the jump');
  assert.equal(after.active, true);
  feed(model, [0, 0, 0], { startAt: back + 1000 });
  assert.equal(model.state.active, false);
  assert.equal(model.update({ readBps: 100 * MIB, writeBps: 0, at: back + 4000 }).active, true);
});

test('a backwards clock jump during warm-up restarts the window instead of stalling', () => {
  const model = new ActivityModel();
  model.reset(1_000_000);
  assert.equal(model.update({ readBps: 100 * MIB, writeBps: 0, at: 1_001_000 }), null);
  // Back an hour: the warm-up restarts from here rather than lasting an hour.
  assert.equal(model.update({ readBps: 100 * MIB, writeBps: 0, at: 1000 }), null);
  assert.equal(model.update({ readBps: 100 * MIB, writeBps: 0, at: 4000 }), null);
  assert.equal(model.update({ readBps: 100 * MIB, writeBps: 0, at: 6000 }).active, true);
});
