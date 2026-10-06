import { describe, expect, it } from 'vitest';
import { spoolsToInventory, stockLabel, type SpoolmanSpool } from '../src/core/spoolman';

const fil = (id: number, extra: Partial<SpoolmanSpool['filament']> = {}): SpoolmanSpool['filament'] => ({
  id,
  name: `F${id}`,
  material: 'PLA',
  color_hex: '112233',
  vendor: { name: 'Acme' },
  ...extra,
});

describe('Spoolman inventory', () => {
  it('combines spools of the same filament and skips unusable ones', () => {
    const inv = spoolsToInventory([
      { id: 1, remaining_weight: 820, location: 'Shelf A', filament: fil(1, { color_hex: '000000', name: 'Black' }) },
      { id: 2, remaining_weight: 1000, location: 'Dry box', filament: fil(1, { color_hex: '000000', name: 'Black' }) },
      { id: 3, remaining_weight: 0, filament: fil(2) },
      { id: 4, archived: true, remaining_weight: 300, filament: fil(3) },
      { id: 5, remaining_weight: 500, filament: fil(4, { color_hex: null }) },
      { id: 6, remaining_weight: 700, filament: fil(5, { color_hex: null, multi_color_hexes: 'd4af37,C0C0C0' }) },
      { id: 7, remaining_weight: null, filament: fil(6, { color_hex: '#ff0000', vendor: null, name: null, material: null }) },
    ]);
    expect(inv.skipped).toEqual([
      { spoolId: 3, reason: 'empty' },
      { spoolId: 4, reason: 'archived' },
      { spoolId: 5, reason: 'no color' },
    ]);
    const byId = Object.fromEntries(inv.filaments.map((f) => [f.id, f]));
    expect(Object.keys(byId).sort()).toEqual(['spoolman:1', 'spoolman:5', 'spoolman:6']);
    expect(byId['spoolman:1']).toMatchObject({ brand: 'Acme', name: 'Black', hex: '#000000', stock: { spools: 2, remainingG: 1820, locations: ['Shelf A', 'Dry box'] } });
    expect(byId['spoolman:5']).toMatchObject({ hex: '#D4AF37', stock: { colors: ['#D4AF37', '#C0C0C0'] } });
    expect(byId['spoolman:6']).toMatchObject({ brand: 'Unknown brand', name: 'Filament #6', material: '', hex: '#FF0000', stock: { remainingG: null } });
    expect(stockLabel(byId['spoolman:1'])).toBe('1820 g · 2 spools · Shelf A, Dry box');
  });

  it('accepts colors with an alpha channel', () => {
    const inv = spoolsToInventory([{ id: 1, remaining_weight: 10, filament: fil(1, { color_hex: 'AABBCCFF' }) }]);
    expect(inv.filaments[0].hex).toBe('#AABBCC');
  });
});
