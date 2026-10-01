// Pure parsers for the per-platform disk statistics sources used by
// disk-monitor.js. No I/O happens here, so everything is unit-testable with
// fixture strings (see test/disk-parsers.test.js).

// /proc/diskstats always counts in 512-byte sectors, whatever the device's
// real sector size.
const SECTOR_BYTES = 512;

// Whole-disk devices only: SCSI/SATA/USB (sda), virtio (vda), Xen (xvda),
// NVMe (nvme0n1), SD/eMMC (mmcblk0), legacy IDE (hda) and User-mode Linux
// (ubda). Partitions (sda1, hda1, ubda1, nvme0n1p1, mmcblk0p1), loop, ram,
// device-mapper (dm-*) and zram devices are excluded so the same I/O is not
// counted twice and virtual devices are ignored.
const WHOLE_DISK = /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|ubd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/**
 * Sum bytes read and written across whole-disk devices in /proc/diskstats.
 * Fields (1-based): 3 = device name, 6 = sectors read, 10 = sectors written.
 * @param {string} text contents of /proc/diskstats
 * @returns {{readBytes: number, writeBytes: number, devices: string[]}}
 */
export function parseDiskstats(text) {
  let readBytes = 0;
  let writeBytes = 0;
  const devices = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10) continue;
    const name = fields[2];
    if (!WHOLE_DISK.test(name)) continue;
    const sectorsRead = Number(fields[5]);
    const sectorsWritten = Number(fields[9]);
    if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) continue;
    readBytes += sectorsRead * SECTOR_BYTES;
    writeBytes += sectorsWritten * SECTOR_BYTES;
    devices.push(name);
  }
  return { readBytes, writeBytes, devices };
}

/**
 * Turn two cumulative /proc/diskstats totals into rates. A counter that went
 * backwards (device removed, counter wrap) contributes 0 rather than a
 * negative rate.
 * @returns {{readBps: number, writeBps: number}}
 */
export function diskstatsRate(prev, curr, elapsedMs) {
  if (!(elapsedMs > 0)) return { readBps: 0, writeBps: 0 };
  const seconds = elapsedMs / 1000;
  return {
    readBps: Math.max(0, curr.readBytes - prev.readBytes) / seconds,
    writeBps: Math.max(0, curr.writeBytes - prev.writeBytes) / seconds
  };
}

/**
 * Split a chunk of process output into complete lines, carrying any partial
 * last line over to the next chunk.
 * @returns {{lines: string[], rest: string}}
 */
export function splitLines(buffered, chunk) {
  const parts = (buffered + chunk).split(/\r?\n/);
  const rest = parts.pop();
  return { lines: parts, rest };
}

const MIB = 1024 * 1024;

/**
 * Parse one line of macOS `iostat -d -w 1 -K` output.
 *
 * The output looks like:
 *
 *               disk0               disk4
 *     KB/t  tps  MB/s     KB/t  tps  MB/s
 *    22.37   41  0.89    35.01    0  0.00
 *
 * The device line and the column-heading line are reprinted from time to
 * time (and when disks come and go). iostat on macOS reports one combined
 * MB/s per disk, not separate read and write rates.
 *
 * @param {string} line
 * @param {number[]|null} mbColumns indexes of the MB/s columns from the last
 *   heading line, or null if none has been seen yet
 * @returns {{kind: 'devices', names: string[]} | {kind: 'header', mbColumns: number[]} |
 *   {kind: 'data', totalBps: number} | {kind: 'other'}}
 */
export function parseIostatLine(line, mbColumns) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'other' };

  if (tokens.includes('MB/s')) {
    const columns = [];
    tokens.forEach((token, i) => {
      if (token === 'MB/s') columns.push(i);
    });
    return { kind: 'header', mbColumns: columns };
  }

  // The device-name line, e.g. "disk0 disk4". iostat reprints it when the
  // set of disks shown changes.
  if (tokens.every((token) => /^[A-Za-z][\w.-]*$/.test(token)) && !tokens.includes('KB/t')) {
    return { kind: 'devices', names: tokens };
  }

  if (!tokens.every((token) => /^-?\d+(?:\.\d+)?$/.test(token))) {
    return { kind: 'other' };
  }

  // Without a heading, assume the default KB/t tps MB/s triples.
  const columns = mbColumns ?? tokens.map((_, i) => i).filter((i) => i % 3 === 2);
  let mbPerSecond = 0;
  for (const i of columns) {
    if (i < tokens.length) mbPerSecond += Number(tokens[i]);
  }
  return { kind: 'data', totalBps: mbPerSecond * MIB };
}

/** Parse one quoted CSV record as typeperf writes it. */
function parseCsvRecord(line) {
  const fields = [];
  const re = /"((?:[^"]|"")*)"|([^,]*)/g;
  let pos = 0;
  while (pos <= line.length) {
    re.lastIndex = pos;
    const m = re.exec(line);
    if (!m) break;
    fields.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]);
    pos = re.lastIndex;
    if (line[pos] !== ',') break;
    pos += 1;
  }
  return fields;
}

function parseTypeperfNumber(value) {
  const trimmed = (value ?? '').trim();
  // Some locales write a decimal comma inside the quoted field.
  const normalised = /^-?\d+,\d+$/.test(trimmed) ? trimmed.replace(',', '.') : trimmed;
  if (!/^-?\d+(?:\.\d+)?$/.test(normalised)) return null;
  return Number(normalised);
}

/**
 * Parse one line of
 *   typeperf "\PhysicalDisk(_Total)\Disk Read Bytes/sec"
 *            "\PhysicalDisk(_Total)\Disk Write Bytes/sec" -si 1
 *
 * Output is a blank line, a "(PDH-CSV 4.0)" heading record, then one record
 * per second: "timestamp","read","write". The first sample of a rate counter
 * can be blank. On exit typeperf prints a couple of plain-text status lines.
 *
 * @param {string} line
 * @returns {{kind: 'data', readBps: number, writeBps: number} | {kind: 'other'}}
 */
export function parseTypeperfLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('"')) return { kind: 'other' };
  const fields = parseCsvRecord(trimmed);
  if (fields.length < 3 || fields[0].startsWith('(PDH-CSV')) return { kind: 'other' };
  const readBps = parseTypeperfNumber(fields[1]);
  const writeBps = parseTypeperfNumber(fields[2]);
  if (readBps === null || writeBps === null) return { kind: 'other' };
  return { kind: 'data', readBps: Math.max(0, readBps), writeBps: Math.max(0, writeBps) };
}

/**
 * Parse one line printed by the PowerShell loop in disk-monitor.js
 * (CIM_DISK_SCRIPT):
 *
 *   MDS,<Timestamp_PerfTime>,<Frequency_PerfTime>,<DiskReadBytesPersec>,<DiskWriteBytesPersec>
 *
 * The values are the raw (cumulative) counters of the `_Total` instance of
 * Win32_PerfRawData_PerfDisk_PhysicalDisk, printed with the invariant
 * culture, so they are plain unsigned integers on every Windows language.
 * Anything else (PowerShell noise, a partial line) is 'other'.
 *
 * @param {string} line
 * @returns {{kind: 'data', timestamp: number, frequency: number, readBytes: number, writeBytes: number} | {kind: 'other'}}
 */
export function parseCimDiskLine(line) {
  const fields = line.trim().split(',');
  if (fields.length !== 5 || fields[0] !== 'MDS') return { kind: 'other' };
  const numbers = fields.slice(1).map((field) => (/^\d+$/.test(field) ? Number(field) : NaN));
  if (!numbers.every(Number.isFinite)) return { kind: 'other' };
  const [timestamp, frequency, readBytes, writeBytes] = numbers;
  if (!(frequency > 0)) return { kind: 'other' };
  return { kind: 'data', timestamp, frequency, readBytes, writeBytes };
}

/**
 * Rates between two parsed CIM lines. The byte counters are
 * PERF_COUNTER_BULK_COUNT, timed by the performance counter clock
 * (Timestamp_PerfTime ticks at Frequency_PerfTime per second). Returns null
 * when the clock did not move forward (a repeated or reset snapshot); a
 * counter that went backwards contributes 0.
 * @returns {{readBps: number, writeBps: number} | null}
 */
export function cimDiskRate(prev, curr) {
  const ticks = curr.timestamp - prev.timestamp;
  if (!(ticks > 0) || curr.frequency !== prev.frequency) return null;
  const seconds = ticks / curr.frequency;
  return {
    readBps: Math.max(0, curr.readBytes - prev.readBytes) / seconds,
    writeBps: Math.max(0, curr.writeBytes - prev.writeBytes) / seconds
  };
}
