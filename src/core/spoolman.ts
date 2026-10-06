import type { Filament } from './filaments';

/** The parts of a Spoolman spool (GET /api/v1/spool) this app uses. */
export interface SpoolmanSpool {
  id: number;
  archived?: boolean;
  remaining_weight?: number | null;
  location?: string | null;
  filament: {
    id: number;
    name?: string | null;
    material?: string | null;
    color_hex?: string | null;
    multi_color_hexes?: string | null;
    vendor?: { name?: string | null } | null;
  };
}

export interface SpoolmanInventory {
  /** One entry per Spoolman filament that has at least one usable spool. */
  filaments: Filament[];
  /** Spools left out, with the reason. */
  skipped: { spoolId: number; reason: 'empty' | 'archived' | 'no color' }[];
}

function hex(v: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec((v ?? '').trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

/**
 * Turn Spoolman spools into filaments "on hand". Spools of the same Spoolman
 * filament are combined (count and total remaining weight). Empty and archived
 * spools, and filaments without a color, are skipped.
 */
export function spoolsToInventory(spools: SpoolmanSpool[]): SpoolmanInventory {
  const byFilament = new Map<number, Filament>();
  const skipped: SpoolmanInventory['skipped'] = [];
  for (const s of spools) {
    if (!s || !s.filament) continue;
    if (s.archived) {
      skipped.push({ spoolId: s.id, reason: 'archived' });
      continue;
    }
    const remaining = typeof s.remaining_weight === 'number' ? s.remaining_weight : null;
    if (remaining !== null && remaining <= 0) {
      skipped.push({ spoolId: s.id, reason: 'empty' });
      continue;
    }
    const f = s.filament;
    const colors = (f.multi_color_hexes ?? '')
      .split(',')
      .map(hex)
      .filter((c): c is string => !!c);
    const main = hex(f.color_hex) ?? colors[0] ?? null;
    if (!main) {
      skipped.push({ spoolId: s.id, reason: 'no color' });
      continue;
    }
    const location = (s.location ?? '').trim();
    const existing = byFilament.get(f.id);
    if (existing?.stock) {
      const st = existing.stock;
      st.spools += 1;
      st.remainingG = st.remainingG === null || remaining === null ? null : st.remainingG + remaining;
      if (location && !st.locations.includes(location)) st.locations.push(location);
      continue;
    }
    byFilament.set(f.id, {
      id: `spoolman:${f.id}`,
      brand: (f.vendor?.name ?? '').trim() || 'Unknown brand',
      material: (f.material ?? '').trim(),
      name: (f.name ?? '').trim() || `Filament #${f.id}`,
      hex: main,
      stock: {
        source: 'spoolman',
        filamentId: f.id,
        spools: 1,
        remainingG: remaining,
        locations: location ? [location] : [],
        colors: colors.length > 1 ? colors : undefined,
      },
    });
  }
  const filaments = [...byFilament.values()].sort(
    (a, b) => a.brand.localeCompare(b.brand) || a.material.localeCompare(b.material) || a.name.localeCompare(b.name),
  );
  return { filaments, skipped };
}

/** "820 g · 2 spools · Shelf A" */
export function stockLabel(f: Filament): string {
  const st = f.stock;
  if (!st) return '';
  const parts: string[] = [];
  if (st.remainingG !== null) parts.push(`${Math.round(st.remainingG)} g`);
  if (st.spools > 1) parts.push(`${st.spools} spools`);
  if (st.locations.length) parts.push(st.locations.join(', '));
  if (st.colors) parts.push(`multicolor ${st.colors.join('/')}`);
  return parts.join(' · ');
}
