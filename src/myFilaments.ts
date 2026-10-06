import type { Filament } from './core/filaments';
import { getServerState, putServerState, serverConfig } from './server';

/**
 * The viewer's own filaments ("My filaments"): ids of library entries plus
 * user-defined custom filaments. Stored in localStorage; every access is
 * guarded because storage can be unavailable (private mode, blocked site data).
 * With the self-hosted server the list is also kept on the server, so every
 * browser that opens the app shares it.
 */
const KEY = 'imageflattener.myFilaments.v1';
const SERVER_KEY = 'my-filaments';

export interface MyFilaments {
  ids: string[];
  custom: Filament[];
}

function sanitize(v: Partial<MyFilaments> | null | undefined): MyFilaments {
  return {
    ids: Array.isArray(v?.ids) ? v.ids.filter((x) => typeof x === 'string') : [],
    custom: Array.isArray(v?.custom) ? v.custom.filter((f) => f && typeof f.id === 'string' && /^#[0-9A-F]{6}$/i.test(f.hex)) : [],
  };
}

/** In-memory copy; survives when localStorage is unavailable. */
let current: MyFilaments | null = null;

export function loadMyFilaments(): MyFilaments {
  if (current) return { ids: current.ids.slice(), custom: current.custom.slice() };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) current = sanitize(JSON.parse(raw) as Partial<MyFilaments>);
  } catch {
    /* storage unavailable or corrupt */
  }
  current ??= { ids: [], custom: [] };
  return loadMyFilaments();
}

let serverSync = false;

export function saveMyFilaments(v: MyFilaments): void {
  current = sanitize(v);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: the list still works for this session */
  }
  if (serverSync) putServerState(SERVER_KEY, current).catch((err) => console.warn('Could not save my filaments on the server:', err));
}

/**
 * With the self-hosted server: adopt the server's list (or upload this
 * browser's list if the server has none yet). Returns true if the list changed.
 */
export async function syncMyFilamentsWithServer(): Promise<boolean> {
  const c = await serverConfig();
  if (!c?.storage.ok) return false;
  try {
    const remote = await getServerState<MyFilaments>(SERVER_KEY);
    serverSync = true;
    const local = loadMyFilaments();
    if (remote) {
      const r = sanitize(remote);
      const changed = JSON.stringify(r) !== JSON.stringify(local);
      current = null;
      saveMyFilamentsLocal(r);
      return changed;
    }
    if (local.ids.length || local.custom.length) await putServerState(SERVER_KEY, local);
  } catch (err) {
    console.warn('Could not load my filaments from the server:', err);
  }
  return false;
}

function saveMyFilamentsLocal(v: MyFilaments): void {
  current = v;
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* ignore */
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
