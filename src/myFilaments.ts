import type { Filament } from './core/filaments';

/**
 * The viewer's own filaments ("My filaments"): ids of library entries plus
 * user-defined custom filaments. Stored in localStorage; every access is
 * guarded because storage can be unavailable (private mode, blocked site data).
 */
const KEY = 'imageflattener.myFilaments.v1';

export interface MyFilaments {
  ids: string[];
  custom: Filament[];
}

export function loadMyFilaments(): MyFilaments {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<MyFilaments>;
      return {
        ids: Array.isArray(v.ids) ? v.ids.filter((x) => typeof x === 'string') : [],
        custom: Array.isArray(v.custom)
          ? v.custom.filter((f) => f && typeof f.id === 'string' && /^#[0-9A-F]{6}$/i.test(f.hex))
          : [],
      };
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return { ids: [], custom: [] };
}

export function saveMyFilaments(v: MyFilaments): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: the list still works for this session */
  }
}

const PREFS_KEY = 'imageflattener.filamentPicker.v1';

export interface PickerPrefs {
  material: string;
  brand: string;
  onlyMine: boolean;
}

export function loadPickerPrefs(): PickerPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<PickerPrefs>;
    return { material: v.material ?? '', brand: v.brand ?? '', onlyMine: !!v.onlyMine };
  } catch {
    return { material: '', brand: '', onlyMine: false };
  }
}

export function savePickerPrefs(p: PickerPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
