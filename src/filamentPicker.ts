import {
  filamentDistance,
  filamentLabel,
  loadFilamentLibrary,
  type Filament,
} from './core/filaments';
import { stockLabel } from './core/spoolman';
import { loadMyFilaments, loadPickerPrefs, saveMyFilaments, savePickerPrefs, type MyFilaments } from './myFilaments';
import { serverConfig, setSpoolmanUrl, spoolmanInventory, type SpoolmanState } from './server';

const MAX_ROWS = 150;

export interface PickerOptions {
  /** Color to match; results are sorted by distance to it. */
  targetHex?: string;
  /** Currently chosen filament (enables "Remove filament"). */
  current?: Filament | null;
  /** Called with the chosen filament, or null to remove it. Omit for "manage" mode. */
  onPick?: (f: Filament | null) => void;
  /** Called whenever "My filaments" changes. */
  onMineChange?: () => void;
  /** Optional message shown at the top. */
  notice?: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

let library: Filament[] = [];
let librarySource = '';
/** Filaments on hand from Spoolman (empty without a server/Spoolman). */
let stock: Filament[] = [];
let stockState: { info: SpoolmanState | null; error: string | null } = { info: null, error: null };
let mine: MyFilaments = loadMyFilaments();
let dialog: HTMLDialogElement | null = null;
let opts: PickerOptions = {};
let query = '';
const prefs = loadPickerPrefs();

/** All filaments in "My filaments" (Spoolman stock + starred library entries + custom ones). */
export async function getMyFilaments(): Promise<Filament[]> {
  await Promise.all([ensureLibrary(), loadStock(false)]);
  mine = loadMyFilaments();
  const ids = new Set(mine.ids);
  return [...stock, ...library.filter((f) => ids.has(f.id)), ...mine.custom];
}

export function myFilamentCount(): number {
  mine = loadMyFilaments();
  return stock.length + mine.ids.length + mine.custom.length;
}

/** Spoolman status for the sidebar: null when Spoolman isn't set up. */
export function spoolmanStatus(): { count: number; error: string | null } | null {
  if (stockState.error) return { count: 0, error: stockState.error };
  return stockState.info ? { count: stock.length, error: null } : null;
}

/** (Re)load the Spoolman inventory. Never throws; errors are kept for display. */
export async function loadStock(refresh: boolean): Promise<void> {
  try {
    const info = await spoolmanInventory(refresh);
    stockState = { info, error: null };
    stock = info?.filaments ?? [];
  } catch (err) {
    stockState = { info: null, error: err instanceof Error ? err.message : String(err) };
    stock = [];
  }
}

async function ensureLibrary(): Promise<void> {
  if (library.length) return;
  const lib = await loadFilamentLibrary();
  library = lib.filaments;
  librarySource = lib.source;
}

function isMine(f: Filament): boolean {
  if (f.stock) return true;
  return f.custom ? mine.custom.some((c) => c.id === f.id) : mine.ids.includes(f.id);
}

function toggleMine(f: Filament): void {
  if (f.stock) return; // managed in Spoolman
  if (f.custom) mine.custom = mine.custom.filter((c) => c.id !== f.id);
  else if (mine.ids.includes(f.id)) mine.ids = mine.ids.filter((id) => id !== f.id);
  else mine.ids = [...mine.ids, f.id];
  saveMyFilaments(mine);
  opts.onMineChange?.();
}

function build(): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.className = 'filament-dialog';
  d.innerHTML = `
    <form method="dialog" class="fd-head">
      <span class="fd-target" hidden></span>
      <h3 class="fd-title"></h3>
      <span class="spacer"></span>
      <button value="close" aria-label="Close">✕</button>
    </form>
    <div class="fd-notice status warn" hidden></div>
    <div class="fd-filters">
      <input class="fd-search" type="search" placeholder="Search brand, material, color…" aria-label="Search filaments" />
      <select class="fd-material" aria-label="Material"></select>
      <select class="fd-brand" aria-label="Brand"></select>
      <label class="check"><input class="fd-mine" type="checkbox" /> Only my filaments</label>
    </div>
    <div class="fd-count hint"></div>
    <ul class="fd-list" role="listbox"></ul>
    <details class="fd-custom">
      <summary>Add a custom filament (or a color you measured from your own spool)</summary>
      <div class="row">
        <input class="fd-c-name" type="text" placeholder="Name, e.g. My Black PLA" aria-label="Custom filament name" />
        <input class="fd-c-material" type="text" placeholder="Material" value="PLA" aria-label="Custom filament material" />
        <input class="fd-c-hex" type="color" value="#808080" aria-label="Custom filament color" />
        <button type="button" class="fd-c-add">Add to my filaments</button>
      </div>
    </details>
    <div class="fd-spoolman" hidden>
      <span class="fd-sm-status"></span>
      <span class="spacer"></span>
      <button type="button" class="fd-sm-refresh">Refresh</button>
      <button type="button" class="fd-sm-edit">Spoolman URL…</button>
      <form class="fd-sm-form row" hidden>
        <input class="fd-sm-url" type="text" placeholder="http://192.168.1.20:7912" aria-label="Spoolman URL" />
        <button type="submit">Save</button>
        <span class="hint fd-sm-hint"></span>
      </form>
    </div>
    <div class="fd-foot">
      <span class="hint fd-source"></span>
      <span class="spacer"></span>
      <button type="button" class="fd-clear" hidden>Remove filament</button>
    </div>`;
  document.body.appendChild(d);
  const q = <T extends Element>(sel: string): T => d.querySelector(sel) as T;
  q<HTMLInputElement>('.fd-search').addEventListener('input', (e) => {
    query = (e.target as HTMLInputElement).value;
    renderList();
  });
  for (const [sel, key] of [['.fd-material', 'material'], ['.fd-brand', 'brand']] as const) {
    q<HTMLSelectElement>(sel).addEventListener('change', (e) => {
      prefs[key] = (e.target as HTMLSelectElement).value;
      savePickerPrefs(prefs);
      renderList();
    });
  }
  q<HTMLInputElement>('.fd-mine').addEventListener('change', (e) => {
    prefs.onlyMine = (e.target as HTMLInputElement).checked;
    q<HTMLSelectElement>('.fd-brand').disabled = prefs.onlyMine;
    savePickerPrefs(prefs);
    renderList();
  });
  q<HTMLButtonElement>('.fd-c-add').addEventListener('click', () => {
    const name = q<HTMLInputElement>('.fd-c-name').value.trim() || 'Custom filament';
    const material = q<HTMLInputElement>('.fd-c-material').value.trim();
    const hex = q<HTMLInputElement>('.fd-c-hex').value.toUpperCase();
    const f: Filament = { id: `custom:${Date.now().toString(36)}`, brand: 'Custom', material, name, hex, custom: true };
    mine.custom = [...mine.custom, f];
    saveMyFilaments(mine);
    opts.onMineChange?.();
    q<HTMLInputElement>('.fd-c-name').value = '';
    renderList();
  });
  q<HTMLButtonElement>('.fd-sm-refresh').addEventListener('click', async () => {
    q('.fd-sm-status').textContent = 'Refreshing from Spoolman…';
    await loadStock(true);
    opts.onMineChange?.();
    await renderSpoolman();
    renderList();
  });
  q<HTMLButtonElement>('.fd-sm-edit').addEventListener('click', async () => {
    const form = q<HTMLFormElement>('.fd-sm-form');
    form.hidden = !form.hidden;
    if (!form.hidden) {
      const c = await serverConfig();
      q<HTMLInputElement>('.fd-sm-url').value = c?.spoolman.url ?? '';
      q('.fd-sm-hint').textContent = c?.spoolman.envUrl
        ? `Leave empty to use the container's SPOOLMAN_URL (${c.spoolman.envUrl}).`
        : 'The address you open Spoolman at, e.g. http://192.168.1.20:7912.';
      q<HTMLInputElement>('.fd-sm-url').focus();
    }
  });
  q<HTMLFormElement>('.fd-sm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hint = q('.fd-sm-hint');
    try {
      await setSpoolmanUrl(q<HTMLInputElement>('.fd-sm-url').value);
      q<HTMLFormElement>('.fd-sm-form').hidden = true;
      q('.fd-sm-status').textContent = 'Connecting to Spoolman…';
      await loadStock(true);
      opts.onMineChange?.();
      await renderSpoolman();
      renderList();
    } catch (err) {
      hint.textContent = err instanceof Error ? err.message : String(err);
    }
  });
  q<HTMLButtonElement>('.fd-clear').addEventListener('click', () => {
    opts.onPick?.(null);
    d.close();
  });
  // Close when clicking the backdrop.
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  return d;
}

function fillSelect(sel: HTMLSelectElement, all: string, values: string[], current: string): void {
  sel.innerHTML = `<option value="">${all}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
  sel.value = values.includes(current) ? current : '';
}

function candidates(): Filament[] {
  if (prefs.onlyMine) {
    const ids = new Set(mine.ids);
    return [...stock, ...library.filter((f) => ids.has(f.id)), ...mine.custom];
  }
  return [...stock, ...mine.custom, ...library];
}

/** The Spoolman bar: shown with the self-hosted server. */
async function renderSpoolman(): Promise<void> {
  if (!dialog) return;
  const bar = dialog.querySelector<HTMLElement>('.fd-spoolman')!;
  const c = await serverConfig();
  bar.hidden = !c;
  if (!c) return;
  const status = dialog.querySelector<HTMLElement>('.fd-sm-status')!;
  status.classList.toggle('error', !!stockState.error);
  dialog.querySelector<HTMLButtonElement>('.fd-sm-refresh')!.hidden = !c.spoolman.url;
  if (!c.spoolman.url) {
    status.textContent = 'Spoolman: not connected. Set its URL to use the spools you have on hand.';
  } else if (stockState.error) {
    status.textContent = `Spoolman: ${stockState.error}`;
  } else if (stockState.info) {
    const i = stockState.info;
    const empty = i.skipped.filter((x) => x.reason === 'empty').length;
    const noColor = i.skipped.filter((x) => x.reason === 'no color').length;
    const notes = [empty ? `${empty} empty spool${empty === 1 ? '' : 's'}` : '', noColor ? `${noColor} without a color` : ''].filter(Boolean);
    status.textContent =
      `Spoolman: ${stock.length} filament${stock.length === 1 ? '' : 's'} on hand` +
      (notes.length ? ` (skipped ${notes.join(', ')})` : '') +
      ` · ${i.loadedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
}

function renderList(): void {
  if (!dialog) return;
  const d = dialog;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let list = candidates().filter(
    (f) =>
      (!prefs.material || f.material === prefs.material) &&
      // "Only my filaments" is already a short list; don't let a remembered
      // brand filter hide custom filaments (brand "Custom") or other spools.
      (prefs.onlyMine || !prefs.brand || f.brand === prefs.brand) &&
      tokens.every((t) => `${f.brand} ${f.material} ${f.name} ${f.hex}`.toLowerCase().includes(t)),
  );
  const target = opts.targetHex;
  let scored: { f: Filament; dE: number | null }[];
  if (target) {
    scored = list.map((f) => ({ f, dE: filamentDistance(target, f) })).sort((a, b) => a.dE! - b.dE!);
  } else {
    list = list.sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name));
    scored = list.map((f) => ({ f, dE: null }));
  }
  const ul = d.querySelector('.fd-list')!;
  ul.innerHTML = '';
  for (const { f, dE } of scored.slice(0, MAX_ROWS)) {
    const li = document.createElement('li');
    const chosen = opts.current?.id === f.id;
    const tags = [
      f.stock ? `on hand: ${stockLabel(f)}` : '',
      f.custom ? 'custom' : '',
      f.translucent ? 'translucent' : '',
      f.silk ? 'silk' : '',
      f.matte ? 'matte' : '',
      f.sparkle ? 'sparkle' : '',
      f.glow ? 'glow' : '',
    ].filter(Boolean);
    li.className = chosen ? 'chosen' : '';
    li.innerHTML = `
      <button type="button" class="fd-pick" ${opts.onPick ? '' : 'tabindex="-1"'}>
        <span class="fd-chip" style="background:${f.hex}"></span>
        <span class="fd-text">
          <span class="fd-name">${esc(f.name)}</span>
          <span class="fd-meta">${esc(f.brand)} · ${esc(f.material || '?')} · ${f.hex}${tags.length ? ' · ' + tags.join(', ') : ''}</span>
        </span>
        ${dE !== null ? `<span class="fd-de" title="Color difference (CIEDE2000): under 2 is hard to tell apart, over 10 is a clearly different color">ΔE ${dE.toFixed(1)}</span>` : ''}
      </button>
      ${
        f.stock
          ? `<span class="fd-star fd-stock" title="On hand in Spoolman (manage it there)">●</span>`
          : `<button type="button" class="fd-star ${isMine(f) ? 'on' : ''}" title="${f.custom ? 'Delete this custom filament' : isMine(f) ? 'Remove from my filaments' : 'Add to my filaments'}">${f.custom ? '✕' : isMine(f) ? '★' : '☆'}</button>`
      }`;
    const [pick, star] = li.querySelectorAll('button') as unknown as [HTMLButtonElement, HTMLButtonElement | undefined];
    if (opts.onPick) {
      pick.addEventListener('click', () => {
        opts.onPick?.(f);
        d.close();
      });
    } else pick.addEventListener('click', () => (toggleMine(f), renderList()));
    star?.addEventListener('click', () => (toggleMine(f), renderList()));
    ul.appendChild(li);
  }
  const total = scored.length;
  d.querySelector('.fd-count')!.textContent =
    total === 0
      ? prefs.onlyMine
        ? 'No matching filaments in your list. Untick "Only my filaments" to browse the library and star the spools you own' +
          (stockState.info ? ', or add spools in Spoolman.' : '.')
        : 'No filaments match.'
      : `${total > MAX_ROWS ? `Showing the ${MAX_ROWS} ${target ? 'closest' : 'first'} of ${total}` : `${total} filament${total === 1 ? '' : 's'}`}` +
        `${target ? ', closest color first' : ''}. ${stock.length ? '● = on hand in Spoolman, ' : ''}★ = in my filaments (${myFilamentCount()}).`;
}

/** Open the filament picker (pick mode with onPick, otherwise "manage my filaments"). */
export async function openFilamentPicker(o: PickerOptions): Promise<void> {
  opts = o;
  dialog ??= build();
  const d = dialog;
  const title = d.querySelector('.fd-title')!;
  title.textContent = o.onPick ? 'Choose a filament' : 'My filaments';
  const chip = d.querySelector<HTMLElement>('.fd-target')!;
  chip.hidden = !o.targetHex;
  if (o.targetHex) chip.style.background = o.targetHex;
  const notice = d.querySelector<HTMLElement>('.fd-notice')!;
  notice.hidden = !o.notice;
  notice.textContent = o.notice ?? '';
  d.querySelector<HTMLButtonElement>('.fd-clear')!.hidden = !(o.onPick && o.current);
  d.querySelector('.fd-count')!.textContent = 'Loading filament library…';
  d.querySelector('.fd-list')!.innerHTML = '';
  if (!d.open) d.showModal();
  try {
    await Promise.all([ensureLibrary(), loadStock(false)]);
  } catch {
    d.querySelector('.fd-count')!.textContent = 'Could not load the filament library.';
    return;
  }
  void renderSpoolman();
  mine = loadMyFilaments();
  const all = [...stock, ...library];
  const materials = countSorted(all.map((f) => f.material));
  const brands = [...new Set(all.map((f) => f.brand))].sort((a, b) => a.localeCompare(b));
  fillSelect(d.querySelector('.fd-material')!, 'All materials', materials, prefs.material);
  fillSelect(d.querySelector('.fd-brand')!, 'All brands', brands, prefs.brand);
  d.querySelector<HTMLInputElement>('.fd-mine')!.checked = prefs.onlyMine;
  d.querySelector<HTMLSelectElement>('.fd-brand')!.disabled = prefs.onlyMine;
  d.querySelector('.fd-source')!.textContent = `Library: ${library.length} colors from ${librarySource.replace(/ \(.*$/, '')} (MIT). Colors are manufacturer values; add a custom filament to use your own measurement.`;
  renderList();
  d.querySelector<HTMLInputElement>('.fd-search')!.focus();
}

/** Values sorted by frequency (most common first), then name. */
function countSorted(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
}

export { filamentLabel };
