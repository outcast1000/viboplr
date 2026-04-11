// Converts PNG screenshots to WebP using cwebp.
// Run after Playwright captures screenshots as PNG files.

import { execSync } from 'child_process';
import { readdirSync, renameSync, unlinkSync } from 'fs';
import path from 'path';

const dir = path.resolve('docs/assets/screenshots');
const files = readdirSync(dir).filter(f => f.endsWith('.png'));

if (files.length === 0) {
  console.log('No PNG screenshots found to convert.');
  process.exit(0);
}

for (const file of files) {
  const png = path.join(dir, file);
  const webp = path.join(dir, file.replace('.png', '.webp'));
  execSync(`cwebp -q 90 "${png}" -o "${webp}"`, { stdio: 'pipe' });
  unlinkSync(png);
}

console.log(`Converted ${files.length} screenshots to WebP`);
