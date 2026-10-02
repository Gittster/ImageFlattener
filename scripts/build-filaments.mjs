// Compile SpoolmanDB (https://github.com/Donkie/SpoolmanDB, MIT) into the
// compact filament color table bundled with the app.
//
//   git clone --depth 1 https://github.com/Donkie/SpoolmanDB.git /tmp/SpoolmanDB
//   node scripts/build-filaments.mjs /tmp/SpoolmanDB
//
// Only what the color picker needs is kept: manufacturer, material, product
// name, color name, hex and a few appearance flags. Multi-color filaments
// (no single hex) are skipped.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/build-filaments.mjs <path to SpoolmanDB checkout>');
  process.exit(1);
}
const dir = path.join(src, 'filaments');
let commit = 'unknown';
try {
  commit = execSync('git rev-parse HEAD', { cwd: src }).toString().trim();
} catch {
  /* not a git checkout */
}

const brands = [];
const materials = [];
const index = (list, v) => {
  let i = list.indexOf(v);
  if (i < 0) i = list.push(v) - 1;
  return i;
};
const seen = new Set();
const items = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const brand = String(doc.manufacturer).trim();
  for (const f of doc.filaments ?? []) {
    for (const c of f.colors ?? []) {
      if (!c.hex || typeof c.hex !== 'string') continue;
      const hex = c.hex.replace('#', '').slice(0, 6).toUpperCase();
      if (!/^[0-9A-F]{6}$/.test(hex)) continue;
      const name = String(f.name ?? '{color_name}').replace('{color_name}', c.name).replace(/\s+/g, ' ').trim();
      const material = String(f.material ?? '').trim();
      const key = [brand, material, name, hex].join('|').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Flags: t = translucent, g = glow, s = sparkle/marble, m = matte, k = silk/glossy.
      const finish = String(c.finish ?? f.finish ?? '').toLowerCase();
      const pattern = c.pattern ?? f.pattern;
      let flags = '';
      if (c.translucent ?? f.translucent) flags += 't';
      if (c.glow ?? f.glow) flags += 'g';
      if (pattern) flags += 's';
      if (finish === 'matte') flags += 'm';
      if (finish === 'glossy') flags += 'k';
      items.push([index(brands, brand), index(materials, material), name, hex, flags]);
    }
  }
}
const out = {
  source: 'SpoolmanDB (https://github.com/Donkie/SpoolmanDB), MIT License, Copyright (c) 2024 Donkie',
  commit,
  brands,
  materials,
  // [brandIndex, materialIndex, productName, hex, flags]
  items,
};
const target = new URL('../src/data/filaments.json', import.meta.url);
fs.writeFileSync(target, JSON.stringify(out));
fs.copyFileSync(path.join(src, 'LICENSE'), new URL('../src/data/SpoolmanDB-LICENSE.txt', import.meta.url));
console.log(`${items.length} colors from ${brands.length} manufacturers, ${materials.length} materials (commit ${commit.slice(0, 7)})`);
