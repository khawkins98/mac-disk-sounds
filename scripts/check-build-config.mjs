// Checks that every path the electron-builder config in package.json names
// actually exists, so a moved file fails CI in a second instead of failing a
// release build on one platform.
//
//   node scripts/check-build-config.mjs
//
// Checked: "main", directories.buildResources, each platform's icon, and
// every "files" pattern (a glob must match at least one file). Each icon
// must also really be the format its name says: the Linux icon a square PNG
// (electron-builder otherwise falls back to other icon files and can fail in
// confusing ways), the macOS icon an icns container and the Windows icon an
// ico with a 256 px image. (build/icon.icns was once a renamed PNG banner.)
// scripts/make-app-icon.mjs writes all three.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build ?? {};
const failures = [];

const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
function requirePath(label, relative) {
  if (typeof relative !== 'string' || !exists(relative)) failures.push(`${label}: ${relative} does not exist`);
}

requirePath('main', pkg.main);
requirePath('directories.buildResources', build.directories?.buildResources ?? 'build');

for (const platform of ['mac', 'win', 'linux']) {
  const icon = build[platform]?.icon;
  if (icon !== undefined) requirePath(`${platform}.icon`, icon);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// What is wrong with an icon file, or null if it looks right.
const ICON_CHECKS = {
  linux(data) {
    if (data.length < 24 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'is not a PNG';
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width !== height || width < 512) return `is ${width}x${height}, expected a square of at least 512 px`;
    return null;
  },
  mac(data) {
    // 'icns', the file length, then (type, length, data) entries.
    if (data.length < 8 || data.toString('latin1', 0, 4) !== 'icns') return 'is not an icns file';
    if (data.readUInt32BE(4) !== data.length) return 'has an icns length field that does not match the file size';
    const types = [];
    for (let offset = 8; offset + 8 <= data.length;) {
      const length = data.readUInt32BE(offset + 4);
      if (length < 8 || offset + length > data.length) return 'has a malformed icns entry';
      types.push(data.toString('latin1', offset, offset + 4));
      offset += length;
    }
    if (!types.includes('ic10') && !types.includes('ic09')) return 'has no 512 or 1024 px image (ic09/ic10)';
    return null;
  },
  win(data) {
    // ICONDIR: reserved 0, type 1, count; then 16-byte entries.
    if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) return 'is not an ico file';
    const count = data.readUInt16LE(4);
    if (count === 0 || data.length < 6 + 16 * count) return 'has no images';
    let has256 = false;
    for (let n = 0; n < count; n++) {
      const at = 6 + 16 * n;
      const size = data.readUInt32LE(at + 8);
      const offset = data.readUInt32LE(at + 12);
      if (offset + size > data.length) return 'has an image past the end of the file';
      if (data[at] === 0 && data[at + 1] === 0) has256 = true;
    }
    if (!has256) return 'has no 256 px image (Windows and electron-builder need one)';
    return null;
  }
};

for (const [platform, check] of Object.entries(ICON_CHECKS)) {
  const icon = build[platform]?.icon;
  if (typeof icon !== 'string' || !exists(icon) || fs.statSync(path.join(ROOT, icon)).isDirectory()) continue;
  const problem = check(fs.readFileSync(path.join(ROOT, icon)));
  if (problem) failures.push(`${platform}.icon: ${icon} ${problem}`);
}

for (const pattern of build.files ?? []) {
  if (typeof pattern !== 'string' || pattern.startsWith('!')) continue;
  if (/[*?[{]/.test(pattern)) {
    const matches = fs.globSync(pattern, { cwd: ROOT });
    if (matches.length === 0) failures.push(`files: ${pattern} matches nothing`);
  } else {
    requirePath('files', pattern);
  }
}

if (failures.length > 0) {
  console.error(`electron-builder config problems:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('electron-builder config: every referenced path exists and the icons are real icns, ico and PNG files.');
