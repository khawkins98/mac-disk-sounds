import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDiskstats,
  diskstatsRate,
  splitLines,
  parseIostatLine,
  parseTypeperfLine,
  parseCimDiskLine,
  cimDiskRate
} from '../src/main/disk-parsers.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MIB = 1024 * 1024;

test('parseDiskstats counts whole disks only', () => {
  const { devices, readBytes, writeBytes } = parseDiskstats(fixture('diskstats-before.txt'));
  assert.deepEqual(devices, ['nvme0n1', 'sda', 'mmcblk0', 'vda', 'xvda']);
  // Sectors read (field 6) and written (field 10) of those five, x 512.
  assert.equal(readBytes, (21874534 + 2048000 + 6000 + 9552634 + 1000) * 512);
  assert.equal(writeBytes, (39188392 + 409600 + 80 + 13126280 + 400) * 512);
});

test('parseDiskstats ignores partitions, loop, ram, dm, zram and optical drives', () => {
  const text = fixture('diskstats-before.txt')
    .split('\n')
    .filter((line) => /\b(sda1|nvme0n1p\d|mmcblk0p1|xvda1|loop\d|ram0|dm-0|zram0|sr0)\b/.test(line))
    .join('\n');
  assert.deepEqual(parseDiskstats(text), { readBytes: 0, writeBytes: 0, devices: [] });
});

test('parseDiskstats counts legacy IDE (hd*) and User-mode Linux (ubd*) disks, not their partitions', () => {
  const text = [
    '   3       0 hda 5000 0 80000 900 200 0 1600 40 0 600 940 0 0 0 0 0 0',
    '   3       1 hda1 4990 0 79900 899 200 0 1600 40 0 600 939 0 0 0 0 0 0',
    '   3      64 hdb 10 0 160 2 0 0 0 0 0 2 2 0 0 0 0 0 0',
    '  98       0 ubda 700 0 11200 50 30 0 240 3 0 40 53 0 0 0 0 0 0',
    '  98       1 ubda1 690 0 11000 49 30 0 240 3 0 40 52 0 0 0 0 0 0',
    '  98      16 ubdb 1 0 8 0 1 0 8 0 0 0 0 0 0 0 0 0 0',
    '  98      17 ubdb2 1 0 8 0 1 0 8 0 0 0 0 0 0 0 0 0 0'
  ].join('\n');
  const { devices, readBytes, writeBytes } = parseDiskstats(text);
  assert.deepEqual(devices, ['hda', 'hdb', 'ubda', 'ubdb']);
  assert.equal(readBytes, (80000 + 160 + 11200 + 8) * 512);
  assert.equal(writeBytes, (1600 + 0 + 240 + 8) * 512);
});

test('parseDiskstats tolerates empty and malformed input', () => {
  assert.deepEqual(parseDiskstats(''), { readBytes: 0, writeBytes: 0, devices: [] });
  assert.deepEqual(parseDiskstats('8 0 sda x y z\n'), { readBytes: 0, writeBytes: 0, devices: [] });
});

test('diskstatsRate diffs two samples into bytes per second', () => {
  const before = parseDiskstats(fixture('diskstats-before.txt'));
  const after = parseDiskstats(fixture('diskstats-after.txt'));
  // nvme0n1 read 4096 more sectors and sda wrote 4096 more: 2 MiB each.
  // The dm-0 and zram0 counters also jumped but must be ignored.
  assert.deepEqual(diskstatsRate(before, after, 1000), { readBps: 2 * MIB, writeBps: 2 * MIB });
  assert.deepEqual(diskstatsRate(before, after, 2000), { readBps: MIB, writeBps: MIB });
});

test('diskstatsRate never goes negative and handles zero elapsed time', () => {
  const before = parseDiskstats(fixture('diskstats-before.txt'));
  const after = parseDiskstats(fixture('diskstats-after.txt'));
  assert.deepEqual(diskstatsRate(after, before, 1000), { readBps: 0, writeBps: 0 });
  assert.deepEqual(diskstatsRate(before, after, 0), { readBps: 0, writeBps: 0 });
});

test('splitLines carries partial lines across chunks', () => {
  let state = splitLines('', 'abc\r\nde');
  assert.deepEqual(state, { lines: ['abc'], rest: 'de' });
  state = splitLines(state.rest, 'f\nghi\n');
  assert.deepEqual(state, { lines: ['def', 'ghi'], rest: '' });
});

test('parseIostatLine reads the MB/s columns of macOS iostat output', () => {
  const lines = fixture('iostat.txt').split('\n');
  assert.deepEqual(parseIostatLine(lines[0], null), { kind: 'devices', names: ['disk0', 'disk4'] });
  const header = parseIostatLine(lines[1], null);
  assert.deepEqual(header, { kind: 'header', mbColumns: [2, 5] });

  const totals = lines.slice(2, 6).map((line) => parseIostatLine(line, header.mbColumns));
  assert.deepEqual(totals.map((t) => t.kind), ['data', 'data', 'data', 'data']);
  assert.ok(Math.abs(totals[0].totalBps - 0.81 * MIB) < 1e-6);
  assert.ok(Math.abs(totals[1].totalBps - 0.05 * MIB) < 1e-6);
  assert.ok(Math.abs(totals[2].totalBps - 7.51 * MIB) < 1e-6);
  assert.equal(totals[3].totalBps, 0);
});

test('parseIostatLine assumes KB/t tps MB/s triples before any heading', () => {
  const result = parseIostatLine('   64.00  120  7.50     4.00    2  0.25 ', null);
  assert.equal(result.kind, 'data');
  assert.ok(Math.abs(result.totalBps - 7.75 * MIB) < 1e-6);
});

test('parseIostatLine follows a changed heading when a disk appears', () => {
  const header = parseIostatLine('    KB/t  tps  MB/s     KB/t  tps  MB/s     KB/t  tps  MB/s ', null);
  assert.deepEqual(header.mbColumns, [2, 5, 8]);
  const result = parseIostatLine('   1.00  1  1.00   1.00  1  2.00   1.00  1  3.00', header.mbColumns);
  assert.equal(result.totalBps, 6 * MIB);
});

test('parseIostatLine ignores blank lines and error text', () => {
  assert.deepEqual(parseIostatLine('', null), { kind: 'other' });
  assert.deepEqual(parseIostatLine('iostat: some error', null), { kind: 'other' });
});

test('parseTypeperfLine reads read and write bytes/sec from typeperf CSV', () => {
  const results = fixture('typeperf.txt').split(/\r?\n/).map(parseTypeperfLine);
  const data = results.filter((r) => r.kind === 'data');
  assert.deepEqual(data, [
    { kind: 'data', readBps: 0, writeBps: 40960.351231 },
    { kind: 'data', readBps: 1048576, writeBps: 524288 },
    { kind: 'data', readBps: 0, writeBps: 0 }
  ]);
  // Blank line, PDH heading, the blank first sample, and the exit messages.
  assert.equal(results.filter((r) => r.kind === 'other').length, results.length - 3);
});

test('parseTypeperfLine accepts a decimal comma inside quoted fields', () => {
  assert.deepEqual(
    parseTypeperfLine('"01.10.2026 09:15:02.125","1024,500000","0,000000"'),
    { kind: 'data', readBps: 1024.5, writeBps: 0 }
  );
});

test('parseTypeperfLine rejects headings, blanks and garbage', () => {
  assert.deepEqual(parseTypeperfLine('"(PDH-CSV 4.0)","a","b"'), { kind: 'other' });
  assert.deepEqual(parseTypeperfLine('"10/01/2026 09:15:01.123"," "," "'), { kind: 'other' });
  assert.deepEqual(parseTypeperfLine('"10/01/2026 09:15:01.123","-1"'), { kind: 'other' });
  assert.deepEqual(parseTypeperfLine('Exiting, please wait...'), { kind: 'other' });
  assert.deepEqual(parseTypeperfLine(''), { kind: 'other' });
});

test('parseCimDiskLine reads the raw counters printed by the PowerShell loop', () => {
  const results = fixture('cim-disk.txt').split(/\r?\n/).map(parseCimDiskLine);
  const data = results.filter((r) => r.kind === 'data');
  assert.equal(data.length, 4);
  assert.deepEqual(data[0], {
    kind: 'data',
    timestamp: 2617463825123,
    frequency: 10000000,
    readBytes: 48318382080,
    writeBytes: 96636764160
  });
  // The blank line, the warning, the line with a missing field and the
  // empty last line are not data.
  assert.equal(results.length - data.length, 4);
});

test('parseCimDiskLine rejects anything but MDS lines of unsigned integers', () => {
  for (const line of [
    '',
    'MDS',
    'MDS,1,2,3',
    'MDS,1,2,3,4,5',
    'XYZ,1,10000000,3,4',
    'MDS,1,10000000,-3,4',
    'MDS,1,10000000,3.5,4',
    'MDS,1,10000000,3 456,4',
    'MDS,1,0,3,4',
    'MDS,1,10000000,1.234.567,4'
  ]) {
    assert.deepEqual(parseCimDiskLine(line), { kind: 'other' }, line);
  }
  // CRLF line endings and stray spaces are fine.
  assert.equal(parseCimDiskLine('  MDS,1,10000000,3,4\r').kind, 'data');
});

test('cimDiskRate turns two raw snapshots into bytes per second on the counter clock', () => {
  const [a, b, c, d] = fixture('cim-disk.txt').split(/\r?\n/).map(parseCimDiskLine).filter((r) => r.kind === 'data');
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
  const ab = cimDiskRate(a, b);
  close(ab.readBps, 0);
  close(ab.writeBps, 80896 / (10016748 / 1e7));
  const bc = cimDiskRate(b, c);
  close(bc.readBps, MIB / (10016626 / 1e7));
  close(bc.writeBps, (MIB / 2) / (10016626 / 1e7));
  assert.deepEqual(cimDiskRate(c, d), { readBps: 0, writeBps: 0 });
});

test('cimDiskRate: a clock that did not move forward gives null; counters going back give 0', () => {
  const snap = (timestamp, readBytes, writeBytes, frequency = 10000000) => ({ timestamp, frequency, readBytes, writeBytes });
  assert.equal(cimDiskRate(snap(100, 0, 0), snap(100, 10, 10)), null);
  assert.equal(cimDiskRate(snap(100, 0, 0), snap(50, 10, 10)), null);
  assert.equal(cimDiskRate(snap(100, 0, 0), snap(200, 10, 10, 3000000)), null, 'clock frequency changed');
  assert.deepEqual(cimDiskRate(snap(0, 500, 500), snap(10000000, 100, 600)), { readBps: 0, writeBps: 100 });
});
