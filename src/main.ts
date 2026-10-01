import './style.css';
import { hexToRgb, rgbToHex, type RGB } from './core/color';
import type { ExportMode, SvgLayer } from './core/svg';
import { layerId, svgDocument } from './core/svg';
import { baseName, downloadBlob, svgBlob, zipBlob } from './exporters';
import { EXPORT_MAX } from './imageLoader';
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
      <h2>Cleanup</h2>
      <div class="field">
        <label for="mode">Smooth edges (mode filter) <output id="mode-out"></output></label>
        <input id="mode" type="range" min="0" max="3" step="1" value="1" />
      </div>
      <label class="check"><input id="despeckle" type="checkbox" checked /> Despeckle</label>
      <div class="field">
        <div class="label"><span>Remove regions smaller than</span><span class="value" id="despeckle-info"></span></div>
        <div class="row">
          <input id="despeckle-mm" type="number" min="0" max="50" step="0.05" value="0.6" aria-label="Despeckle size in mm" /> mm
          <label class="check" style="margin:0"><input id="despeckle-auto" type="checkbox" checked /> = min feature</label>
        </div>
      </div>
      <div id="thin-warning" class="status"></div>
      <label class="check"><input id="show-thin" type="checkbox" /> Highlight thin features</label>
    </section>
    <section>
      <h2>Print size</h2>
      <div class="field">
        <div class="label"><span>Print width</span><span class="value" id="print-height"></span></div>
        <div class="row"><input id="print-width" type="number" min="1" max="2000" step="1" value="100" aria-label="Print width in mm" /> mm</div>
      </div>
      <div class="field">
        <div class="label"><span>Nozzle diameter</span></div>
        <div class="row"><input id="nozzle" type="number" min="0.05" max="2" step="0.05" value="0.4" aria-label="Nozzle diameter in mm" /> mm</div>
      </div>
      <div class="field">
        <div class="label"><span>Min feature size</span><span class="value" id="min-feature-info"></span></div>
        <div class="row"><input id="feature-mult" type="number" min="0.5" max="5" step="0.1" value="1.5" aria-label="Minimum feature size multiplier" /> × nozzle</div>
      </div>
      <div class="hint" id="resolution-info"></div>
    </section>
    <section>
      <h2>Vector</h2>
      <div class="field">
        <label for="tolerance">Simplification tolerance <output id="tolerance-out"></output></label>
        <input id="tolerance" type="range" min="0.25" max="4" step="0.25" value="1" />
      </div>
      <label class="check"><input id="curves" type="checkbox" checked /> Smooth curves (Bézier)</label>
    </section>
    <section>
      <h2>Export</h2>
      <div class="field">
        <div class="label"><span>Mode</span></div>
        <div class="seg" id="mode-seg">
          <button data-mode="stacked" class="on" title="Each layer continues under the layers above it">Stacked</button>
          <button data-mode="cutout" title="Non-overlapping shapes that tile the image">Cutout</button>
        </div>
      </div>
      <div class="field" id="bleed-field" hidden>
        <label for="bleed">Bleed / overlap <output id="bleed-out"></output></label>
        <input id="bleed" type="range" min="0" max="0.2" step="0.01" value="0" />
      </div>
      <div class="field">
        <div class="label"><span>Stack order</span><span class="value">top ↑</span></div>
        <ol id="stack" class="stack"></ol>
        <div class="hint">Drag to reorder (or use the arrows). Bottom of the list = bottom of the print.</div>
      </div>
      <div class="row" style="margin-bottom:10px">
        <label class="check" style="margin:0"><input id="bg" type="checkbox" /> Background rect</label>
        <input id="bg-color" type="color" value="#ffffff" aria-label="Background color" disabled />
      </div>
      <div class="export-buttons">
        <button id="export-svg" class="primary" disabled>Layered SVG</button>
        <button id="export-zip" disabled>Per-color SVGs (.zip)</button>
        <button id="export-png" disabled>Flattened PNG</button>
        <button id="export-json" disabled>Settings (.json)</button>
      </div>
      <div id="export-info" class="hint"></div>
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
        <div class="seg" id="view-seg">
          <button data-view="raster" class="on">Raster</button>
          <button data-view="vector">Vector</button>
        </div>
        <span class="spacer"></span>
        <button id="zoom-out" title="Zoom out">−</button>
        <button id="zoom-fit" title="Fit to view">Fit</button>
        <button id="zoom-in" title="Zoom in">+</button>
      </div>
      <div class="view" id="view-preview">
        <div class="content" id="content-preview">
          <canvas id="raster-canvas"></canvas>
          <img id="vector-img" alt="Vector preview" draggable="false" hidden />
          <canvas id="thin-canvas" hidden></canvas>
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
  /** Incremented for every loaded image. */
  imageVersion: number;
  loading: boolean;
  colors: number;
  blur: number;
  seed: number;
  result: PipelineResult | null;
  /** Quantize key the palette entries belong to. */
  quantKey: string;
  entries: PaletteEntry[];
  selected: Set<number>;
  forceBW: boolean;
  modeFilter: number;
  despeckle: boolean;
  despeckleAuto: boolean;
  despeckleMm: number;
  printWidthMm: number;
  nozzleMm: number;
  featureMult: number;
  showThin: boolean;
  tolerance: number;
  curves: boolean;
  mode: ExportMode;
  bleedMm: number;
  /** Palette entry ids, bottom of the stack first. */
  stackIds: number[];
  background: boolean;
  backgroundColor: string;
  view: 'raster' | 'vector';
}

const state: State = {
  image: null,
  imageVersion: 0,
  loading: false,
  colors: 4,
  blur: 0,
  seed: 1,
  result: null,
  quantKey: '',
  entries: [],
  selected: new Set(),
  forceBW: false,
  modeFilter: 1,
  despeckle: true,
  despeckleAuto: true,
  despeckleMm: 0.6,
  printWidthMm: 100,
  nozzleMm: 0.4,
  featureMult: 1.5,
  showThin: false,
  tolerance: 1,
  curves: true,
  mode: 'stacked',
  bleedMm: 0,
  stackIds: [],
  background: false,
  backgroundColor: '#FFFFFF',
  view: 'raster',
};

interface Derived {
  pxPerMm: number;
  heightMm: number;
  minFeatureMm: number;
  minFeaturePx: number;
  despeckleMm: number;
  despeckleArea: number;
}

/** Print-size dependent values, in working-image pixels. */
function derived(): Derived {
  const w = state.image?.working.width ?? 1;
  const h = state.image?.working.height ?? 1;
  const pxPerMm = w / state.printWidthMm;
  const minFeatureMm = state.nozzleMm * state.featureMult;
  const despeckleMm = state.despeckleAuto ? minFeatureMm : state.despeckleMm;
  const side = despeckleMm * pxPerMm;
  return {
    pxPerMm,
    heightMm: (state.printWidthMm * h) / w,
    minFeatureMm,
    minFeaturePx: minFeatureMm * pxPerMm,
    despeckleMm,
    despeckleArea: state.despeckle ? side * side : 0,
  };
}

// ------------------------------------------------------------- worker -----
const client = new WorkerClient();
let workerStage: string | null = null;
function updateBusy(): void {
  const text = state.loading ? 'Loading image…' : (workerStage ?? (runQueued && state.image ? 'Updating…' : null));
  $('busy').classList.toggle('on', text !== null);
  if (text) $('busy-text').textContent = text;
}
client.onProgress = (stage) => {
  workerStage = stage;
  updateBusy();
};
client.onError = (message) => setStatus(message, 'error');
client.onResult = (result) => {
  if (result.imageVersion !== state.imageVersion || state.loading) return; // stale
  state.result = result;
  if (result.quant.key !== state.quantKey) {
    // New clustering: palette edits from the previous one no longer apply.
    state.quantKey = result.quant.key;
    state.entries = entriesFromClusters(result.quant.centroids);
    state.selected.clear();
    syncStack();
  }
  renderResult();
};

client.onThin = (cleanKey, count, mask) => {
  const r = state.result;
  if (!r || r.cleanKey !== cleanKey) return;
  r.thinCount = count;
  r.thinMask = mask;
  renderThin(r);
};

let debounceTimer = 0;
let runQueued = false;
function schedule(delay = 200): void {
  window.clearTimeout(debounceTimer);
  runQueued = true;
  updateBusy();
  debounceTimer = window.setTimeout(runPipeline, delay);
}

function buildParams(): PipelineParams {
  const d = derived();
  return {
    imageVersion: state.imageVersion,
    cleanup: { modeFilter: state.modeFilter, despeckleArea: d.despeckleArea, minFeaturePx: d.minFeaturePx },
    quantize: { colors: state.colors, blur: state.blur, seed: state.seed },
    palette: { quantKey: state.quantKey, groups: clusterGroups(state.entries, state.result?.quant.centroids.length ?? 0) },
    vector: {
      tolerance: state.tolerance,
      curves: state.curves,
      mode: state.mode,
      stack: stackIndices(),
      bleedPx: state.bleedMm * d.pxPerMm,
      scale: 1 / d.pxPerMm,
    },
  };
}

function runPipeline(): void {
  runQueued = false;
  updateBusy();
  if (!state.image || state.loading) return;
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
  renderThin(r);
  renderPalette();
  renderStack();
  renderVector();
  updateExportButtons();
}

// ---------------------------------------------------------- stack order ---
/** Keep stackIds consistent with the current palette entries. */
function syncStack(): void {
  const ids = new Set(state.entries.map((e) => e.id));
  const kept = state.stackIds.filter((id) => ids.has(id));
  for (const e of state.entries) if (!kept.includes(e.id)) kept.push(e.id);
  state.stackIds = kept;
}

/** Stack as palette entry indices, bottom first. */
function stackIndices(): number[] {
  return state.stackIds.map((id) => state.entries.findIndex((e) => e.id === id)).filter((i) => i >= 0);
}

function moveStack(from: number, to: number): void {
  if (from === to || to < 0 || to >= state.stackIds.length) return;
  const [id] = state.stackIds.splice(from, 1);
  state.stackIds.splice(to, 0, id);
  renderStack();
  schedule(0);
}

function renderStack(): void {
  const list = $('stack');
  const hex = paletteHex();
  list.innerHTML = '';
  const n = state.stackIds.length;
  const counts = resultInSync() ? state.result!.counts : null;
  // Exported layer number for each stack position (removed colors are skipped).
  const layerNo: number[] = [];
  let next = 1;
  for (let pos = 0; pos < n; pos++) {
    const idx = state.entries.findIndex((e) => e.id === state.stackIds[pos]);
    layerNo.push(counts && idx >= 0 && counts[idx] === 0 ? 0 : next++);
  }
  // Display top of the stack first.
  for (let pos = n - 1; pos >= 0; pos--) {
    const idx = state.entries.findIndex((e) => e.id === state.stackIds[pos]);
    if (idx < 0) continue;
    const li = document.createElement('li');
    li.draggable = true;
    li.dataset.pos = String(pos);
    li.innerHTML = `<span class="grip" aria-hidden="true">⋮⋮</span>
      <span class="chip" style="background:${hex[idx]}"></span>
      <span class="hex">${layerNo[pos] ? `${layerNo[pos]}. ` : ''}${hex[idx]}${layerNo[pos] ? '' : ' <span class="tag">removed by cleanup</span>'}</span>
      <span class="spacer"></span>
      <button class="mini" title="Move up" ${pos === n - 1 ? 'disabled' : ''}>↑</button>
      <button class="mini" title="Move down" ${pos === 0 ? 'disabled' : ''}>↓</button>`;
    const [up, down] = li.querySelectorAll('button');
    up.addEventListener('click', () => moveStack(pos, pos + 1));
    down.addEventListener('click', () => moveStack(pos, pos - 1));
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', String(pos));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      li.classList.add('over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('over');
      const from = Number(e.dataTransfer?.getData('text/plain'));
      if (Number.isInteger(from)) moveStack(from, pos);
    });
    list.appendChild(li);
  }
}

// --------------------------------------------------------------- vector ---
function svgLayers(): SvgLayer[] | null {
  const v = state.result?.vector;
  if (!v || !resultInSync() || v.stack.length !== state.entries.length) return null;
  const hex = paletteHex();
  const counts = state.result!.counts;
  // Colors that cleanup removed entirely get no (empty) layer.
  return v.stack
    .map((entry, i) => ({ entry, d: v.paths[i] }))
    .filter(({ entry }) => counts[entry] > 0)
    .map(({ entry, d }, i) => ({ index: i + 1, color: hex[entry], d }));
}

/** Stack (entry indices, bottom first) without colors removed by cleanup. */
function exportedStack(): number[] {
  const counts = state.result?.counts ?? [];
  return stackIndices().filter((i) => (counts[i] ?? 0) > 0);
}

function currentSvg(layers = svgLayers()): string | null {
  if (!layers || !state.image) return null;
  const d = derived();
  return svgDocument({
    widthMm: state.printWidthMm,
    heightMm: d.heightMm,
    layers,
    background: state.background ? state.backgroundColor : null,
    title: `${state.image.name} (${state.mode})`,
  });
}

let vectorUrl: string | null = null;
function renderVector(): void {
  const img = $<HTMLImageElement>('vector-img');
  const svg = state.view === 'vector' ? currentSvg() : null;
  if (vectorUrl) URL.revokeObjectURL(vectorUrl);
  vectorUrl = svg ? URL.createObjectURL(svgBlob(svg)) : null;
  if (vectorUrl) img.src = vectorUrl;
  img.hidden = state.view !== 'vector' || !vectorUrl;
  $('raster-canvas').hidden = state.view !== 'raster';
  $('thin-canvas').hidden = state.view !== 'raster' || !state.showThin;
}

// --------------------------------------------------------------- export ---
function updateExportButtons(): void {
  const ok = !state.loading && !!svgLayers();
  for (const id of ['export-svg', 'export-zip', 'export-png', 'export-json']) $<HTMLButtonElement>(id).disabled = !ok;
  const d = derived();
  const size = exportPngSize();
  $('export-info').textContent = state.image
    ? `SVG: ${state.printWidthMm} × ${d.heightMm.toFixed(1)} mm · PNG: ${size.width} × ${size.height} px`
    : '';
}

function exportPngSize(): { width: number; height: number } {
  const img = state.image;
  if (!img) return { width: 0, height: 0 };
  const s = Math.min(1, EXPORT_MAX / Math.max(img.originalWidth, img.originalHeight));
  return { width: Math.max(1, Math.round(img.originalWidth * s)), height: Math.max(1, Math.round(img.originalHeight * s)) };
}

function exportName(suffix: string): string {
  return `${baseName(state.image?.name ?? 'image')}-${suffix}`;
}

$('export-svg').addEventListener('click', () => {
  const svg = currentSvg();
  if (svg) downloadBlob(svgBlob(svg), exportName(`${exportedStack().length}c-${state.mode}.svg`));
});

$('export-zip').addEventListener('click', () => {
  const layers = svgLayers();
  if (!layers || !state.image) return;
  const d = derived();
  const files = layers.map((layer) => ({
    name: `${String(layer.index).padStart(2, '0')}-${layerId(layer).replace('#', '')}.svg`,
    content: svgDocument({ widthMm: state.printWidthMm, heightMm: d.heightMm, layers: [layer], title: layerId(layer) }),
  }));
  files.push({ name: 'settings.json', content: settingsJson() });
  downloadBlob(zipBlob(files), exportName(`${exportedStack().length}c-${state.mode}-layers.zip`));
});

$('export-png').addEventListener('click', async () => {
  const r = state.result;
  if (!r) return;
  const btn = $<HTMLButtonElement>('export-png');
  btn.disabled = true;
  try {
    const { width, height } = exportPngSize();
    const colors: (RGB | null)[] = paletteColors();
    const blob = await client.renderPng(width, height, colors);
    downloadBlob(blob, exportName(`${exportedStack().length}c.png`));
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    btn.disabled = false;
  }
});

$('export-json').addEventListener('click', () => {
  downloadBlob(new Blob([settingsJson()], { type: 'application/json' }), exportName('settings.json'));
});

function settingsJson(): string {
  const r = state.result;
  const hex = paletteHex();
  const total = r ? r.counts.reduce((a, b) => a + b, 0) : 0;
  const stack = exportedStack();
  const d = derived();
  const doc = {
    generator: 'Image Flattener',
    version: 1,
    image: state.image && {
      name: state.image.name,
      originalWidth: state.image.originalWidth,
      originalHeight: state.image.originalHeight,
      workingWidth: state.image.working.width,
      workingHeight: state.image.working.height,
    },
    palette: state.entries.map((e, i) => ({
      index: i,
      color: hex[i],
      clusterColor: rgbToHex(e.base),
      overridden: e.override !== null,
      coveragePercent: total > 0 && r ? Math.round((10000 * r.counts[i]) / total) / 100 : 0,
      // null when cleanup removed every pixel of this color (not exported).
      stackPosition: stack.includes(i) ? stack.indexOf(i) + 1 : null,
      svgGroupId: stack.includes(i) ? `color-${stack.indexOf(i) + 1}-${hex[i]}` : null,
    })),
    stackOrder: stack.map((i) => hex[i]),
    settings: {
      colors: state.colors,
      blurPx: state.blur,
      seed: state.seed,
      forceBlackWhite: state.forceBW,
      modeFilterPasses: state.modeFilter,
      despeckle: state.despeckle,
      despeckleMm: d.despeckleMm,
      printWidthMm: state.printWidthMm,
      printHeightMm: Math.round(d.heightMm * 1000) / 1000,
      nozzleMm: state.nozzleMm,
      minFeatureMultiplier: state.featureMult,
      minFeatureMm: Math.round(d.minFeatureMm * 1000) / 1000,
      simplifyTolerancePx: state.tolerance,
      curves: state.curves,
      exportMode: state.mode,
      bleedMm: state.mode === 'cutout' ? state.bleedMm : 0,
      background: state.background ? state.backgroundColor : null,
    },
    thinFeatureWarnings: r && r.thinCount >= 0 ? r.thinCount : null,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

function renderThin(r: PipelineResult): void {
  const el = $('thin-warning');
  const d = derived();
  if (r.thinCount < 0) {
    el.textContent = 'Checking feature sizes…';
    el.className = 'status';
  } else if (r.thinCount > 0) {
    el.textContent = `⚠ ${r.thinCount} feature${r.thinCount === 1 ? ' is' : 's are'} thinner than ${d.minFeatureMm.toFixed(2)} mm.`;
    el.className = 'status warn';
  } else {
    el.textContent = r.entryCount > 0 ? `✓ No features thinner than ${d.minFeatureMm.toFixed(2)} mm.` : '';
    el.className = 'status';
  }
  const c = $<HTMLCanvasElement>('thin-canvas');
  const ready = r.thinMask.length === r.width * r.height;
  c.hidden = !state.showThin || state.view !== 'raster' || !ready;
  if (c.hidden) return;
  c.width = r.width;
  c.height = r.height;
  const g = c.getContext('2d')!;
  const img = g.createImageData(r.width, r.height);
  for (let i = 0; i < r.thinMask.length; i++) {
    if (!r.thinMask[i]) continue;
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 0;
    img.data[i * 4 + 2] = 200;
    img.data[i * 4 + 3] = 230;
  }
  g.putImageData(img, 0, 0);
}

function renderDerived(): void {
  const d = derived();
  $('print-height').textContent = state.image ? `height ${d.heightMm.toFixed(1)} mm` : '';
  $('min-feature-info').textContent = `${d.minFeatureMm.toFixed(2)} mm` + (state.image ? ` ≈ ${d.minFeaturePx.toFixed(1)} px` : '');
  const mmInput = $<HTMLInputElement>('despeckle-mm');
  mmInput.disabled = state.despeckleAuto || !state.despeckle;
  if (state.despeckleAuto) mmInput.value = d.minFeatureMm.toFixed(2);
  $('despeckle-info').textContent = state.despeckle && state.image ? `≈ ${Math.round(d.despeckleArea)} px²` : '';
  $('tolerance-out').textContent = `${state.tolerance} px` + (state.image ? ` ≈ ${(state.tolerance / d.pxPerMm).toFixed(2)} mm` : '');
  const mmPerPx = 1 / d.pxPerMm;
  $('resolution-info').textContent = state.image
    ? `Working image: ${state.image.working.width} × ${state.image.working.height} px → ${mmPerPx.toFixed(3)} mm per pixel.` +
      (mmPerPx > state.nozzleMm ? ' Pixels are larger than the nozzle; consider a smaller print or a higher-resolution image.' : '')
    : '';
  if (state.result) updateExportButtons();
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
    k === 0
      ? 'The image is fully transparent; there is nothing to flatten.'
      : k < state.colors
        ? `Image only has ${k} distinct color${k === 1 ? '' : 's'}; using ${k}.`
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
      <span class="pct" ${r && r.counts[i] === 0 ? 'title="Removed entirely by cleanup; not exported"' : ''}>${
        r && r.counts[i] === 0 ? 'removed' : pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`
      }</span>
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
      renderStack();
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
  syncStack();
  renderPalette();
  schedule(0);
});
$('reset-palette-btn').addEventListener('click', () => {
  const q = state.result?.quant;
  if (!q) return;
  state.entries = entriesFromClusters(q.centroids);
  state.selected.clear();
  state.stackIds = [];
  syncStack();
  renderPalette();
  schedule(0);
});
$<HTMLInputElement>('force-bw').addEventListener('change', (e) => {
  state.forceBW = (e.target as HTMLInputElement).checked;
  renderResult();
});

bindRange('mode', (v) => (v === 0 ? 'off' : `${v} pass${v > 1 ? 'es' : ''}`), (v) => (state.modeFilter = v));

function bindNumber(id: string, min: number, max: number, apply: (v: number) => void): void {
  const input = $<HTMLInputElement>(id);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v < min || v > max) {
      input.classList.add('invalid');
      return;
    }
    input.classList.remove('invalid');
    apply(v);
    renderDerived();
    schedule();
  });
}
bindNumber('despeckle-mm', 0, 50, (v) => (state.despeckleMm = v));
bindNumber('print-width', 1, 2000, (v) => (state.printWidthMm = v));
bindNumber('nozzle', 0.05, 2, (v) => (state.nozzleMm = v));
bindNumber('feature-mult', 0.5, 5, (v) => (state.featureMult = v));
function bindCheck(id: string, apply: (v: boolean) => void, rerun = true): void {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    apply((e.target as HTMLInputElement).checked);
    renderDerived();
    if (rerun) schedule(0);
    else renderResult();
  });
}
bindCheck('despeckle', (v) => (state.despeckle = v));
bindCheck('despeckle-auto', (v) => {
  state.despeckleAuto = v;
  if (!v) state.despeckleMm = Number($<HTMLInputElement>('despeckle-mm').value) || state.despeckleMm;
});
bindCheck('show-thin', (v) => (state.showThin = v), false);
bindRange('tolerance', (v) => `${v} px` + (state.image ? ` ≈ ${(v / derived().pxPerMm).toFixed(2)} mm` : ''), (v) => (state.tolerance = v));
bindCheck('curves', (v) => (state.curves = v));
bindRange('bleed', (v) => (v === 0 ? 'off' : `${v.toFixed(2)} mm`), (v) => (state.bleedMm = v));
for (const b of $('mode-seg').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    state.mode = b.dataset.mode as ExportMode;
    $('mode-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    $('bleed-field').hidden = state.mode !== 'cutout';
    schedule(0);
  });
}
for (const b of $('view-seg').querySelectorAll<HTMLButtonElement>('button')) {
  b.addEventListener('click', () => {
    state.view = b.dataset.view as 'raster' | 'vector';
    $('view-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderVector();
  });
}
bindCheck('bg', (v) => {
  state.background = v;
  $<HTMLInputElement>('bg-color').disabled = !v;
}, false);
$<HTMLInputElement>('bg-color').addEventListener('input', (e) => {
  state.backgroundColor = (e.target as HTMLInputElement).value.toUpperCase();
  renderVector();
});
renderDerived();

$('seed-out').textContent = String(state.seed);
$('reseed-btn').addEventListener('click', () => {
  state.seed = (Math.random() * 0xffffffff) >>> 0 || 1;
  $('seed-out').textContent = String(state.seed);
  schedule(0);
});

// ------------------------------------------------------------- loading ----
async function openBlob(blob: Blob, name: string): Promise<void> {
  state.loading = true;
  state.result = null;
  updateExportButtons();
  updateBusy();
  try {
    const img = await loadImage(blob, name);
    if (state.image) URL.revokeObjectURL(state.image.url);
    state.image = img;
    state.imageVersion++;
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
    renderDerived();
    viewports.fit();
    $('image-info').textContent =
      `${name} · ${img.originalWidth}×${img.originalHeight}` + (w !== img.originalWidth ? ` (working ${w}×${h})` : '');
    // Copy: the buffer is transferred to the worker.
    client.setImage(state.imageVersion, w, h, img.working.data.slice());
    state.loading = false;
    updateBusy();
    renderVector();
    schedule(0);
  } catch (err) {
    state.loading = false;
    updateBusy();
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
