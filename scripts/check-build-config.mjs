// Checks that every path the electron-builder config in package.json names
// actually exists, so a moved file fails CI in a second instead of failing a
// release build on one platform.
//
//   node scripts/check-build-config.mjs
//
// Checked: "main", directories.buildResources, each platform's icon, and
// every "files" pattern (a glob must match at least one file). The Linux
// icon must also be a real PNG: electron-builder otherwise falls back to
// other icon files and can fail in confusing ways.

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
const linuxIcon = build.linux?.icon;
if (typeof linuxIcon === 'string' && exists(linuxIcon) && !fs.statSync(path.join(ROOT, linuxIcon)).isDirectory()) {
  const head = fs.readFileSync(path.join(ROOT, linuxIcon)).subarray(0, 8);
  if (!head.equals(PNG_SIGNATURE)) failures.push(`linux.icon: ${linuxIcon} is not a PNG`);
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
console.log('electron-builder config: every referenced path exists.');
