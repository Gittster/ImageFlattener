import { deltaE2000, hexToRgb, rgbToLab, type Lab } from './color';

/** A real filament color (from the bundled SpoolmanDB table or user-defined). */
export interface Filament {
  /** Stable id: "db:<brand>|<material>|<name>|<hex>", "custom:<n>" or "spoolman:<filament id>". */
  id: string;
  brand: string;
  material: string;
  name: string;
  /** #RRGGBB */
  hex: string;
  translucent?: boolean;
  glow?: boolean;
  sparkle?: boolean;
  matte?: boolean;
  silk?: boolean;
  custom?: boolean;
  /** Filament on hand, from Spoolman. */
  stock?: FilamentStock;
}

export interface FilamentStock {
  source: 'spoolman';
  filamentId: number;
  spools: number;
  /** Total remaining weight in grams; null if Spoolman doesn't know. */
  remainingG: number | null;
  locations: string[];
  /** All colors of a multicolor filament (hex is the first). */
  colors?: string[];
}

/** The compact table produced by scripts/build-filaments.mjs. */
export interface FilamentTable {
  source: string;
  commit: string;
  brands: string[];
  materials: string[];
  items: [number, number, string, string, string][];
}

export function filamentId(brand: string, material: string, name: string, hex: string): string {
  return `db:${brand}|${material}|${name}|${hex.toUpperCase()}`;
}

export function parseFilamentTable(t: FilamentTable): Filament[] {
  return t.items.map(([b, m, name, hex, flags]) => ({
    id: filamentId(t.brands[b], t.materials[m], name, `#${hex}`),
    brand: t.brands[b],
    material: t.materials[m],
    name,
    hex: `#${hex}`,
    translucent: flags.includes('t') || undefined,
    glow: flags.includes('g') || undefined,
    sparkle: flags.includes('s') || undefined,
    matte: flags.includes('m') || undefined,
    silk: flags.includes('k') || undefined,
  }));
}

/** "Brand Material Name" without repeating words the name already contains. */
export function filamentLabel(f: Pick<Filament, 'brand' | 'material' | 'name'>): string {
  const parts = [f.brand];
  if (f.material && !f.name.toLowerCase().includes(f.material.toLowerCase())) parts.push(f.material);
  parts.push(f.name);
  return parts.filter(Boolean).join(' ');
}

const labCache = new Map<string, Lab>();
export function hexLab(hex: string): Lab {
  let lab = labCache.get(hex);
  if (!lab) {
    lab = rgbToLab(...hexToRgb(hex));
    labCache.set(hex, lab);
  }
  return lab;
}

export function filamentDistance(targetHex: string, f: Filament): number {
  return deltaE2000(hexLab(targetHex), hexLab(f.hex));
}

/** Filaments sorted by perceptual distance to the target color. */
export function nearestFilaments(targetHex: string, list: Filament[], limit = Infinity): { filament: Filament; dE: number }[] {
  const scored = list.map((filament) => ({ filament, dE: filamentDistance(targetHex, filament) }));
  scored.sort((a, b) => a.dE - b.dE || a.filament.id.localeCompare(b.filament.id));
  return scored.slice(0, limit);
}

/**
 * Assign each target color a filament, minimizing the total CIEDE2000
 * distance. Each filament is used at most once while enough filaments are
 * available (exact, via the Hungarian algorithm); if there are more targets
 * than filaments, the rest reuse their nearest filament.
 * Returns, per target, the index into `list` (or -1 if `list` is empty).
 */
export function assignFilaments(targets: string[], list: Filament[]): number[] {
  const n = targets.length;
  const m = list.length;
  if (n === 0) return [];
  if (m === 0) return targets.map(() => -1);
  const cost = targets.map((t) => list.map((f) => filamentDistance(t, f)));
  const result = new Array<number>(n).fill(-1);
  if (n <= m) {
    const a = hungarian(cost);
    for (let i = 0; i < n; i++) result[i] = a[i];
  } else {
    // More colors than filaments: every filament is used at least once,
    // remaining colors take their nearest filament.
    const transposed = list.map((_, j) => targets.map((__, i) => cost[i][j]));
    const a = hungarian(transposed); // filament j -> target a[j]
    a.forEach((i, j) => (result[i] = j));
    for (let i = 0; i < n; i++) {
      if (result[i] >= 0) continue;
      let best = 0;
      for (let j = 1; j < m; j++) if (cost[i][j] < cost[i][best]) best = j;
      result[i] = best;
    }
  }
  return result;
}

/**
 * Minimum-cost assignment for an n x m cost matrix with n <= m.
 * Returns the column assigned to each row.
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0]?.length ?? 0;
  const INF = Number.POSITIVE_INFINITY;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0); // p[j]: row matched to column j (1-based)
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(INF);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] > 0) out[p[j] - 1] = j - 1;
  return out;
}

let libraryPromise: Promise<{ filaments: Filament[]; source: string; commit: string }> | null = null;

/** Load the bundled filament library (a separate chunk, fetched on first use). */
export function loadFilamentLibrary(): Promise<{ filaments: Filament[]; source: string; commit: string }> {
  libraryPromise ??= import('../data/filaments.json').then((mod) => {
    const table = (mod as unknown as { default: FilamentTable }).default;
    return { filaments: parseFilamentTable(table), source: table.source, commit: table.commit };
  });
  return libraryPromise;
}
