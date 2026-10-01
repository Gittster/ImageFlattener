import './style.css';
import { hexToRgb, type RGB } from './core/color';
import { clusterGroups, entriesFromClusters, mergeEntries, resolveColors, type PaletteEntry } from './core/palette';
import { VOID } from './core/types';
import { loadImage, type LoadedImage } from './imageLoader';
import type { PipelineParams, PipelineResult } from './protocol';
import { SAMPLES } from './samples';
import { ViewportGroup } from './viewport';
import { WorkerClient } from './workerClient';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
<header class="top">
  <h1>Image Flattener</h1>
  <button id="open-btn" class="primary">Open image…</button>
  <input id="file-input" type="file" accept="image/*" hidden />
  <select id="sample-select" aria-label="Load sample">
    <option value="">Load sample…</option>
    ${SAMPLES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('')}
  </select>
  <span class="hint">or drop / paste an image</span>
  <span class="spacer"></span>
  <span id="image-info" class="hint"></span>
</header>
<div class="layout">
  <aside class="controls">
    <section>
      <h2>Colors</h2>
      <div class="field">
        <label for="colors">Number of colors <output id="colors-out"></output></label>
        <input id="colors" type="range" min="2" max="12" step="1" value="4" />
      </div>
      <div class="field">
        <label for="blur">Pre-blur <output id="blur-out"></output></label>
        <input id="blur" type="range" min="0" max="3" step="0.25" value="0" />
      </div>
      <div class="row">
        <button id="reseed-btn" title="Re-run clustering with a new random seed">Re-cluster (new seed)</button>
        <span class="hint">seed <span id="seed-out"></span></span>
      </div>
    </section>
    <section>
      <h2>Palette</h2>
      <div id="palette" class="palette"></div>
      <div class="row">
        <button id="merge-btn" disabled title="Merge the checked colors into one">Merge selected</button>
        <button id="reset-palette-btn" title="Undo merges and color overrides">Reset</button>
      </div>
      <label class="check" style="margin-top:8px"><input id="force-bw" type="checkbox" /> Force darkest/lightest to pure black/white</label>
      <div class="hint">Click a swatch to override its output color. Overrides don't change which pixels belong to it.</div>
    </section>
    <section>
      <div id="status" class="status"></div>
    </section>
  </aside>
  <main class="panes">
    <div class="pane">
      <div class="pane-head"><span class="title">Original</span></div>
      <div class="view" id="view-original">
        <div class="content" id="content-original"><img id="original-img" alt="" draggable="false" hidden /></div>
        <div class="empty" id="empty-original">Open, drop, or paste an image to start.</div>
      </div>
    </div>
    <div class="pane">
      <div class="pane-head">
        <span class="title">Preview</span>
        <span class="spacer"></span>
        <button id="zoom-out" title="Zoom out">−</button>
        <button id="zoom-fit" title="Fit to view">Fit</button>
        <button id="zoom-in" title="Zoom in">+</button>
      </div>
      <div class="view" id="view-preview">
        <div class="content" id="content-preview">
          <canvas id="raster-canvas"></canvas>
        </div>
        <div class="busy" id="busy"><span class="spinner"></span><span id="busy-text">Working…</span></div>
      </div>
    </div>
  </main>
</div>
<footer class="foot">Your images are processed locally in your browser and never uploaded.</footer>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------- state ---
interface State {
  image: LoadedImage | null;
  colors: number;
  blur: number;
  seed: number;
  result: PipelineResult | null;
  /** Quantize key the palette entries belong to. */
  quantKey: string;
  entries: PaletteEntry[];
  selected: Set<number>;
  forceBW: boolean;
}

const state: State = {
  image: null,
  colors: 4,
  blur: 0,
  seed: 1,
  result: null,
  quantKey: '',
  entries: [],
  selected: new Set(),
  forceBW: false,
};

// ------------------------------------------------------------- worker -----
const client = new WorkerClient();
client.onProgress = (stage) => {
  $('busy').classList.toggle('on', stage !== null);
  if (stage) $('busy-text').textContent = stage;
};
client.onError = (message) => setStatus(message, 'error');
client.onResult = (result) => {
  state.result = result;
  if (result.quant.key !== state.quantKey) {
    // New clustering: palette edits from the previous one no longer apply.
    state.quantKey = result.quant.key;
    state.entries = entriesFromClusters(result.quant.centroids);
    state.selected.clear();
  }
  renderResult();
};

let debounceTimer = 0;
function schedule(delay = 200): void {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(runPipeline, delay);
}

function buildParams(): PipelineParams {
  return {
    quantize: { colors: state.colors, blur: state.blur, seed: state.seed },
    palette: { quantKey: state.quantKey, groups: clusterGroups(state.entries, state.result?.quant.centroids.length ?? 0) },
  };
}

function runPipeline(): void {
  if (!state.image) return;
  client.process(buildParams());
}

// ------------------------------------------------------------ viewport ----
const viewports = new ViewportGroup();
viewports.add($('view-original'), $('content-original'));
viewports.add($('view-preview'), $('content-preview'));
$('zoom-in').addEventListener('click', () => viewports.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => viewports.zoomBy(0.8));
$('zoom-fit').addEventListener('click', () => viewports.fit());

// ------------------------------------------------------------- render -----
function paletteHex(): string[] {
  return resolveColors(state.entries, state.forceBW);
}

function paletteColors(): RGB[] {
  return paletteHex().map(hexToRgb);
}

/** True when the last result's labels match the current palette entries. */
function resultInSync(): boolean {
  const r = state.result;
  return !!r && r.quant.key === state.quantKey && r.entryCount === state.entries.length;
}

function renderResult(): void {
  const r = state.result;
  if (!r || !resultInSync()) return;
  renderRaster(r);
  renderPalette();
}

function renderRaster(r: PipelineResult): void {
  const canvas = $<HTMLCanvasElement>('raster-canvas');
  canvas.width = r.width;
  canvas.height = r.height;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(r.width, r.height);
  const colors = paletteColors();
  const d = img.data;
  for (let i = 0; i < r.labels.length; i++) {
    const l = r.labels[i];
    if (l === VOID) continue;
    const c = colors[l];
    d[i * 4] = c[0];
    d[i * 4 + 1] = c[1];
    d[i * 4 + 2] = c[2];
    d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const k = r.quant.centroids.length;
  setStatus(
    k < state.colors
      ? `Image only has ${k} distinct color${k === 1 ? '' : 's'}; using ${k}.`
      : k === 0
        ? 'Image is fully transparent.'
        : '',
    k < state.colors ? 'warn' : 'info',
  );
}

function renderPalette(): void {
  const el = $('palette');
  const r = resultInSync() ? state.result : null;
  const hex = paletteHex();
  const total = r ? r.counts.reduce((a, b) => a + b, 0) : 0;
  el.innerHTML = '';
  state.entries.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'swatch-row';
    const pct = total > 0 && r ? (100 * (r.counts[i] ?? 0)) / total : 0;
    const overridden = e.override !== null;
    row.innerHTML = `
      <input type="checkbox" aria-label="Select color ${i + 1}" ${state.selected.has(i) ? 'checked' : ''} />
      <button class="swatch" title="Click to override the output color" style="background:${hex[i]}"></button>
      <input type="color" value="${hex[i].toLowerCase()}" hidden />
      <span class="hex">${hex[i]}${overridden ? ' <span class="tag">edited</span>' : ''}</span>
      <span class="pct">${pct < 0.1 && pct > 0 ? '<0.1' : pct.toFixed(1)}%</span>
      <button class="mini" title="Revert to cluster color" ${overridden ? '' : 'hidden'}>↺</button>`;
    const [check, swatch, picker, , , revert] = [...row.children] as HTMLElement[];
    check.addEventListener('change', () => {
      if ((check as HTMLInputElement).checked) state.selected.add(i);
      else state.selected.delete(i);
      updateMergeButton();
    });
    swatch.addEventListener('click', () => (picker as HTMLInputElement).click());
    picker.addEventListener('input', () => {
      e.override = (picker as HTMLInputElement).value.toUpperCase();
      (swatch as HTMLElement).style.background = e.override;
      if (state.result) renderRaster(state.result);
    });
    picker.addEventListener('change', () => renderResult());
    revert.addEventListener('click', () => {
      e.override = null;
      renderResult();
    });
    el.appendChild(row);
  });
  updateMergeButton();
}

function updateMergeButton(): void {
  $<HTMLButtonElement>('merge-btn').disabled = state.selected.size < 2;
}

function setStatus(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind === 'info' ? '' : kind}`;
}

// ------------------------------------------------------------ controls ----
function bindRange(id: string, fmt: (v: number) => string, apply: (v: number) => void): (v: number) => void {
  const input = $<HTMLInputElement>(id);
  const out = $(`${id}-out`);
  const set = (v: number): void => {
    input.value = String(v);
    out.textContent = fmt(v);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = fmt(v);
    apply(v);
    schedule();
  });
  set(Number(input.value));
  return set;
}

const setColors = bindRange('colors', (v) => String(v), (v) => (state.colors = v));
const setBlur = bindRange('blur', (v) => (v === 0 ? 'off' : `${v} px`), (v) => (state.blur = v));
$('merge-btn').addEventListener('click', () => {
  const q = state.result?.quant;
  if (!q || state.selected.size < 2) return;
  state.entries = mergeEntries(state.entries, [...state.selected], q.centroids, q.counts);
  state.selected.clear();
  renderPalette();
  schedule(0);
});
$('reset-palette-btn').addEventListener('click', () => {
  const q = state.result?.quant;
  if (!q) return;
  state.entries = entriesFromClusters(q.centroids);
  state.selected.clear();
  renderPalette();
  schedule(0);
});
$<HTMLInputElement>('force-bw').addEventListener('change', (e) => {
  state.forceBW = (e.target as HTMLInputElement).checked;
  renderResult();
});

$('seed-out').textContent = String(state.seed);
$('reseed-btn').addEventListener('click', () => {
  state.seed = (Math.random() * 0xffffffff) >>> 0 || 1;
  $('seed-out').textContent = String(state.seed);
  schedule(0);
});

// ------------------------------------------------------------- loading ----
async function openBlob(blob: Blob, name: string): Promise<void> {
  try {
    $('busy').classList.add('on');
    $('busy-text').textContent = 'Loading image…';
    const img = await loadImage(blob, name);
    if (state.image) URL.revokeObjectURL(state.image.url);
    state.image = img;
    state.result = null;
    const { width: w, height: h } = img.working;
    const orig = $<HTMLImageElement>('original-img');
    orig.src = img.url;
    orig.hidden = false;
    $('empty-original').hidden = true;
    const c = $<HTMLCanvasElement>('raster-canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.clearRect(0, 0, w, h);
    viewports.setContentSize(w, h);
    viewports.fit();
    $('image-info').textContent =
      `${name} · ${img.originalWidth}×${img.originalHeight}` + (w !== img.originalWidth ? ` (working ${w}×${h})` : '');
    // Copy: the buffer is transferred to the worker.
    client.setImage(w, h, img.working.data.slice());
    schedule(0);
  } catch (err) {
    $('busy').classList.remove('on');
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
}

$('open-btn').addEventListener('click', () => $<HTMLInputElement>('file-input').click());
$<HTMLInputElement>('file-input').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void openBlob(file, file.name);
  input.value = '';
});

$<HTMLSelectElement>('sample-select').addEventListener('change', async (e) => {
  const sel = e.target as HTMLSelectElement;
  const sample = SAMPLES.find((s) => s.id === sel.value);
  sel.value = '';
  if (!sample) return;
  try {
    const res = await fetch(sample.url);
    if (!res.ok) throw new Error(`Failed to load sample (${res.status})`);
    state.colors = sample.colors;
    state.blur = sample.blur;
    setColors(sample.colors);
    setBlur(sample.blur);
    await openBlob(await res.blob(), sample.url.split('/').pop()!.replace(/-[\w-]{8}\./, '.'));
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  }
});

for (const view of [$('view-original'), $('view-preview')]) {
  view.addEventListener('dragover', (e) => {
    e.preventDefault();
    view.classList.add('drop-target');
  });
  view.addEventListener('dragleave', () => view.classList.remove('drop-target'));
  view.addEventListener('drop', (e) => {
    e.preventDefault();
    view.classList.remove('drop-target');
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) void openBlob(file, file.name);
  });
}
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  const file = item?.getAsFile();
  if (file) void openBlob(file, file.name || 'pasted.png');
});
window.addEventListener('resize', () => viewports.fit());
