import { describe, expect, it } from 'vitest';
import { deltaE2000 } from '../src/core/color';
import { assignFilaments, filamentLabel, hungarian, nearestFilaments, parseFilamentTable, type Filament } from '../src/core/filaments';
import { entriesFromClusters, resolveColors } from '../src/core/palette';
import table from '../src/data/filaments.json';

describe('CIEDE2000', () => {
  // Reference pairs from Sharma, Wu & Dalal (2005), "The CIEDE2000 color-difference formula".
  const cases: [number, number, number, number, number, number, number][] = [
    [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
    [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
    [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
    [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
    [50, 0, 0, 50, -1, 2, 2.3669],
    [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
    [50, 2.5, 0, 73, 25, -18, 27.1492],
    [50, 2.5, 0, 50, 3.1736, 0.5854, 1.0],
    [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
    [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
    [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
    [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
  ];
  it.each(cases)('pair %#', (L1, a1, b1, L2, a2, b2, expected) => {
    expect(deltaE2000([L1, a1, b1], [L2, a2, b2])).toBeCloseTo(expected, 4);
    expect(deltaE2000([L2, a2, b2], [L1, a1, b1])).toBeCloseTo(expected, 4);
  });
});

const f = (id: string, hex: string): Filament => ({ id, brand: 'Test', material: 'PLA', name: id, hex });

describe('filament matching', () => {
  it('Hungarian assignment matches brute force', () => {
    let seed = 3;
    const rand = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 30; trial++) {
      const n = 1 + Math.floor(rand() * 4);
      const m = n + Math.floor(rand() * 3);
      const cost = Array.from({ length: n }, () => Array.from({ length: m }, () => Math.round(rand() * 100)));
      const a = hungarian(cost);
      expect(new Set(a).size).toBe(n);
      const total = a.reduce((s, j, i) => s + cost[i][j], 0);
      let best = Infinity;
      const perm = (i: number, used: Set<number>, acc: number): void => {
        if (i === n) return void (best = Math.min(best, acc));
        for (let j = 0; j < m; j++) if (!used.has(j)) perm(i + 1, new Set([...used, j]), acc + cost[i][j]);
      };
      perm(0, new Set(), 0);
      expect(total).toBe(best);
    }
  });

  it('assigns distinct filaments when there are enough, even if two colors prefer the same one', () => {
    const list = [f('red', '#E00000'), f('darkred', '#800000'), f('blue', '#0000E0')];
    // Both targets are closest to "red"; the optimum gives one of them dark red.
    const picks = assignFilaments(['#F00000', '#B00000', '#0000F0'], list);
    expect(picks.map((i) => list[i].id)).toEqual(['red', 'darkred', 'blue']);
  });

  it('reuses filaments when there are more colors than filaments', () => {
    const list = [f('white', '#FFFFFF'), f('black', '#000000')];
    const picks = assignFilaments(['#F0F0F0', '#101010', '#202020'], list);
    expect(picks.map((i) => list[i].id)).toEqual(['white', 'black', 'black']);
  });

  it('sorts by perceptual distance', () => {
    const list = [f('a', '#00FF00'), f('b', '#FF1010'), f('c', '#FF0000')];
    expect(nearestFilaments('#FE0000', list).map((x) => x.filament.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('filament library', () => {
  const lib = parseFilamentTable(table as never);
  it('parses the bundled SpoolmanDB table', () => {
    expect(lib.length).toBeGreaterThan(1000);
    expect(new Set(lib.map((x) => x.id)).size).toBe(lib.length);
    for (const x of lib) expect(x.hex).toMatch(/^#[0-9A-F]{6}$/);
    const jade = lib.find((x) => x.brand === 'Bambu Lab' && x.name === 'Jade White');
    expect(jade?.hex).toBe('#FFFFFF');
  });

  it('labels without repeating the material', () => {
    expect(filamentLabel({ brand: 'Bambu Lab', material: 'PLA', name: 'Jade White' })).toBe('Bambu Lab PLA Jade White');
    expect(filamentLabel({ brand: 'Polymaker', material: 'PLA', name: 'PolyTerra PLA Charcoal' })).toBe('Polymaker PolyTerra PLA Charcoal');
  });
});

describe('palette with filaments', () => {
  it('a chosen filament sets the output color and is not pinned to black/white', () => {
    const entries = entriesFromClusters([[10, 10, 10], [128, 0, 0], [250, 250, 250]]);
    entries[0].filament = f('charcoal', '#333333');
    entries[1].override = '#00FF00';
    entries[1].filament = f('red', '#C12E1F');
    expect(resolveColors(entries, true)).toEqual(['#333333', '#C12E1F', '#FFFFFF']);
  });
});
