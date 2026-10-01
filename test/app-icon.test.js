// The committed app icons (build/icon.png, .icns, .ico) are real files of
// their format and match what scripts/make-app-icon.mjs draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ICNS_TYPES, ICO_SIZES, buildIcns, buildIco, renderIcon } from '../scripts/make-app-icon.mjs';
import { decodePng, encodePng } from '../scripts/png.mjs';

const read = (file) => readFileSync(fileURLToPath(new URL(`../build/${file}`, import.meta.url)));

function parseIcns(data) {
  assert.equal(data.toString('latin1', 0, 4), 'icns');
  assert.equal(data.readUInt32BE(4), data.length);
  const entries = new Map();
  for (let offset = 8; offset < data.length;) {
    const length = data.readUInt32BE(offset + 4);
    entries.set(data.toString('latin1', offset, offset + 4), data.subarray(offset + 8, offset + length));
    offset += length;
  }
  return entries;
}

function parseIco(data) {
  assert.equal(data.readUInt16LE(0), 0);
  assert.equal(data.readUInt16LE(2), 1);
  const entries = new Map();
  for (let n = 0; n < data.readUInt16LE(4); n++) {
    const at = 6 + 16 * n;
    const size = data[at] || 256;
    assert.equal(data[at + 1] || 256, size);
    assert.equal(data.readUInt16LE(at + 6), 32);
    const length = data.readUInt32LE(at + 8);
    const offset = data.readUInt32LE(at + 12);
    entries.set(size, data.subarray(offset, offset + length));
  }
  return entries;
}

const pixelsMatch = (png, size) => {
  const image = decodePng(png);
  assert.equal(image.width, size);
  assert.equal(image.height, size);
  assert.ok(Buffer.from(image.rgba).equals(Buffer.from(renderIcon(size))), `${size} px image is out of date: run node scripts/make-app-icon.mjs`);
};

test('build/icon.png is the 1024 px icon', () => {
  const image = decodePng(read('icon.png'));
  assert.equal(image.width, 1024);
  assert.equal(image.height, 1024);
});

test('build/icon.icns holds every size as PNG, matching the drawing', () => {
  const entries = parseIcns(read('icon.icns'));
  assert.deepEqual([...entries.keys()], ICNS_TYPES.map(([type]) => type));
  for (const [type, size] of ICNS_TYPES) {
    const image = decodePng(entries.get(type));
    assert.equal(image.width, size, type);
  }
  pixelsMatch(entries.get('icp4'), 16);
  pixelsMatch(entries.get('ic11'), 32);
});

test('build/icon.ico holds 16 to 256 px as PNG, matching the drawing', () => {
  const entries = parseIco(read('icon.ico'));
  assert.deepEqual([...entries.keys()], ICO_SIZES);
  for (const size of ICO_SIZES) assert.equal(decodePng(entries.get(size)).width, size);
  pixelsMatch(entries.get(24), 24);
  pixelsMatch(entries.get(256), 256);
});

test('containers round-trip', () => {
  const png = (size) => encodePng(size, size, new Uint8Array(size * size * 4));
  const bySize = new Map([16, 24, 32, 48, 64, 128, 256, 512, 1024].map((size) => [size, png(size)]));
  const icns = parseIcns(buildIcns(bySize));
  assert.ok(icns.get('ic10').equals(bySize.get(1024)));
  const ico = parseIco(buildIco(bySize));
  assert.ok(ico.get(256).equals(bySize.get(256)));
  assert.ok(ico.get(16).equals(bySize.get(16)));
});
