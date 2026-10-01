import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityModel, levelForBps, isPeriodic, DEFAULTS } from '../src/main/activity.js';

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

// --- Duty cycle ---

const repeat = (pattern, times) => Array.from({ length: times }, () => pattern).flat();
const activeFlags = (model, rates, startAt) => rates.map((bps, i) => {
  model.update({ readBps: bps, writeBps: 0, at: startAt + i * 1000 });
  return model.state.active;
});

test('a periodic writer (one busy sample every 3 s) goes idle and stays idle', () => {
  const model = startedModel();
  // Two busy samples in a row (a write that straddled a sample) start it;
  // then one 100 KB/s sample every third second for two minutes.
  const flags = activeFlags(model, [100 * KIB, 100 * KIB, ...repeat([0, 0, 100 * KIB], 40)], DEFAULTS.warmupMs);
  assert.equal(flags[1], true, 'went active');
  const idleAt = flags.indexOf(false, 2);
  assert.ok(idleAt > 0 && idleAt <= 2 + DEFAULTS.dutyWindow + 3, `went idle at sample ${idleAt}`);
  assert.ok(flags.slice(idleAt).every((active) => !active), 'never comes back');
});

test('a periodic writer with big bursts cannot switch it back on every time', () => {
  const model = startedModel();
  const flags = activeFlags(model, repeat([0, 0, 8 * MIB], 40), DEFAULTS.warmupMs);
  // Each burst may switch it on until the pattern is recognised; after that
  // it stays off.
  const firstIdle = flags.findIndex((active, i) => i > 3 && !active);
  const lastMinute = flags.slice(-60);
  assert.ok(firstIdle > 0);
  assert.ok(lastMinute.every((active) => !active), `active in the last minute: ${lastMinute.filter(Boolean).length} s`);
});

test('sustained load stays active', () => {
  const model = startedModel();
  const flags = activeFlags(model, repeat([2 * MIB, 5 * MIB, 300 * KIB], 40), DEFAULTS.warmupMs);
  assert.ok(flags.slice(1).every(Boolean));
});

// A single busy second every other second is indistinguishable from a
// writer with a 2 s period, which must go idle (see below), so real bursty
// work here comes in runs of at least two seconds.
test('bursty real load (busy half the time or more, in runs of 2 s or more) keeps clicking', () => {
  for (const pattern of [[1, 1, 0, 0], [1, 1, 0], [1, 1, 1, 0, 0], [1, 1, 1, 0]]) {
    const model = startedModel();
    const rates = repeat(pattern.map((busy) => (busy ? 6 * MIB : 0)), 30);
    const flags = activeFlags(model, rates, DEFAULTS.warmupMs);
    const from = flags.indexOf(true);
    assert.ok(from >= 0 && from <= 1, `pattern ${pattern} went active at ${from}`);
    assert.ok(flags.slice(from).every(Boolean), `pattern ${pattern} dropped out`);
  }
});

test('real load starting on top of a periodic writer still goes active quickly', () => {
  const model = startedModel();
  const start = DEFAULTS.warmupMs;
  activeFlags(model, [100 * KIB, 100 * KIB, ...repeat([0, 0, 100 * KIB], 10)], start);
  assert.equal(model.state.active, false);
  assert.equal(model.periodic, true);
  const flags = activeFlags(model, repeat([2 * MIB], 6), start + 32 * 1000);
  const at = flags.indexOf(true);
  assert.ok(at >= 0 && at <= 2, `active after ${at + 1} s`);
  assert.ok(flags.slice(at).every(Boolean));
});

test('once the periodic writer stops, a single burst goes active at once again', () => {
  const model = startedModel();
  const start = DEFAULTS.warmupMs;
  activeFlags(model, [100 * KIB, 100 * KIB, ...repeat([0, 0, 100 * KIB], 10)], start);
  assert.equal(model.periodic, true);
  // Eight quiet seconds empty the window.
  activeFlags(model, repeat([0], DEFAULTS.dutyWindow), start + 32 * 1000);
  assert.equal(model.periodic, false);
  const change = model.update({ readBps: DEFAULTS.burstBps, writeBps: 0, at: start + 41 * 1000 });
  assert.equal(change.active, true);
});

test('a one-off burst still winds down over samplesToIdle quiet samples', () => {
  const model = startedModel({ refreshMs: Infinity });
  const flags = activeFlags(model, [50 * MIB, 0, 0, 0, 0], DEFAULTS.warmupMs);
  assert.deepEqual(flags, [true, true, true, false, false]);
});

// One burst every `period` seconds, for `seconds`. `straddle` makes every
// third burst span two samples, as a write that crosses a sample boundary.
function burstWriter(period, seconds, { bps = 8 * MIB, straddle = false } = {}) {
  const rates = [];
  let bursts = 0;
  for (let t = 0; t < seconds; t++) {
    if (t % period === 0) {
      bursts += 1;
      rates.push(bps);
    } else if (straddle && t % period === 1 && bursts % 3 === 0) {
      rates.push(bps / 2);
    } else {
      rates.push(0);
    }
  }
  return rates;
}

for (const period of [2, 3, 4, 5, 7]) {
  for (const straddle of [false, true]) {
    if (period === 2 && straddle) continue; // that is 1,1,0 now and then: real-looking
    test(`a writer bursting 8 MiB every ${period} s${straddle ? ' (some bursts over two samples)' : ''} goes idle and stays idle`, () => {
      const model = startedModel();
      const flags = activeFlags(model, burstWriter(period, 180, { straddle }), DEFAULTS.warmupMs);
      // Recognised within the first window (plus a few bursts); idle from then on.
      const settled = flags.slice(DEFAULTS.dutyWindow + 3 * period);
      assert.equal(settled.filter(Boolean).length, 0, `active ${settled.filter(Boolean).length} of the last ${settled.length} s`);
    });
  }
}

test('small periodic writes (100 KB every 2-7 s) never click at all', () => {
  for (const period of [2, 3, 4, 5, 7]) {
    const model = startedModel();
    const flags = activeFlags(model, burstWriter(period, 120, { bps: 100 * KIB }), DEFAULTS.warmupMs);
    assert.equal(flags.filter(Boolean).length, 0, `period ${period}`);
  }
});

test('real load on top of a bursting writer goes active within 3 s and stays active', () => {
  for (const period of [3, 5]) {
    const model = startedModel();
    const start = DEFAULTS.warmupMs;
    activeFlags(model, burstWriter(period, 60), start);
    assert.equal(model.periodic, true);
    const flags = activeFlags(model, repeat([20 * MIB], 20), start + 60 * 1000);
    const at = flags.indexOf(true);
    assert.ok(at >= 0 && at <= 2, `period ${period}: active after ${at + 1} s`);
    assert.ok(flags.slice(at).every(Boolean));
  }
});

test('isPeriodic: separate short runs with low duty, or only single samples', () => {
  const w = (text) => [...text].map((c) => c === '1');
  assert.equal(isPeriodic(w('100100100100')), true);
  assert.equal(isPeriodic(w('1010101010')), true, 'single samples every 2 s');
  assert.equal(isPeriodic(w('110000011000001100000')), true, 'low duty, runs of 2');
  assert.equal(isPeriodic(w('110011001100')), false, 'busy half the time in runs of 2');
  assert.equal(isPeriodic(w('100000000100')), false, 'only two runs');
  assert.equal(isPeriodic(w('111111111111')), false);
  assert.equal(isPeriodic(w('000000000000')), false);
});
