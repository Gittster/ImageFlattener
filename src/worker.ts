/// <reference lib="webworker" />
import { blurImage } from './core/blur';
import { despeckle, modeFilter, thinFeatureSteps, type ThinFeatures } from './core/cleanup';
import { applyGroups, countLabels } from './core/palette';
import { quantize, type QuantizeResult } from './core/quantize';
import { zipSync, strToU8 } from 'fflate';
import { buildParts, type Model3dOptions } from './core/model3d';
import { buildLayerPaths } from './core/svg';
import { buildThreeMf } from './core/threemf';
import { traceEdges, type EdgeGraph } from './core/trace';
import { VOID, type LabelMap, type RasterImage } from './core/types';
import type { PipelineParams, PipelineResult, VectorResult, WorkerRequest, WorkerResponse } from './protocol';
import type { RGB } from './core/color';

declare const self: DedicatedWorkerGlobalScope;

let image: RasterImage | null = null;
let imageVersion = 0;
let quantCache: { key: string; result: QuantizeResult } | null = null;
let cleanCache: { key: string; map: LabelMap; minFeaturePx: number; thin: ThinFeatures | null } | null = null;
/** Incremented on every incoming message; background work stops when it changes. */
let messageSerial = 0;
let graphCache: { key: string; cleanKey: string; graph: EdgeGraph } | null = null;
let vectorCache: { key: string; result: VectorResult } | null = null;

class StaleRequest extends Error {
  constructor() {
    super('stale');
  }
}

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function run(id: number, params: PipelineParams): PipelineResult {
  if (!image) throw new Error('No image loaded');
  if (params.imageVersion !== imageVersion) throw new StaleRequest();
  const q = params.quantize;
  const qKey = JSON.stringify([imageVersion, q.colors, q.blur, q.seed]);
  if (!quantCache || quantCache.key !== qKey) {
    post({ type: 'progress', id, stage: 'Clustering colors…' });
    const src = q.blur > 0 ? blurImage(image, q.blur) : image;
    quantCache = { key: qKey, result: quantize(src, { k: q.colors, seed: q.seed }) };
  }
  const quant = quantCache.result;
  const k = quant.centroids.length;
  // Palette merges. A grouping made for a different clustering is ignored.
  const groups =
    params.palette.quantKey === qKey && params.palette.groups.length === k
      ? params.palette.groups
      : [...Array(k).keys()];
  const entryCount = k === 0 ? 0 : Math.max(...groups) + 1;

  const c = params.cleanup;
  const cKey = JSON.stringify([qKey, groups, c.modeFilter, Math.round(c.despeckleArea), c.minFeaturePx.toFixed(3)]);
  if (!cleanCache || cleanCache.key !== cKey) {
    post({ type: 'progress', id, stage: 'Cleaning up…' });
    let map: LabelMap = { width: quant.width, height: quant.height, labels: applyGroups(quant.labels, groups) };
    if (c.modeFilter > 0) map = modeFilter(map, c.modeFilter);
    if (c.despeckleArea > 1) map = despeckle(map, c.despeckleArea);
    cleanCache = { key: cKey, map, minFeaturePx: c.minFeaturePx, thin: null };
  }
  const labels = cleanCache.map.labels;

  let vector: VectorResult | null = null;
  const v = params.vector;
  if (v && entryCount > 0) {
    const gKey = JSON.stringify([cKey, v.tolerance, v.curves]);
    if (!graphCache || graphCache.key !== gKey) {
      post({ type: 'progress', id, stage: 'Tracing shapes…' });
      graphCache = { key: gKey, cleanKey: cKey, graph: traceEdges(cleanCache.map, { tolerance: v.tolerance, curves: v.curves }) };
    }
    // A stack made for a different palette is replaced by the default order.
    const valid =
      v.stack.length === entryCount && new Set(v.stack).size === entryCount && v.stack.every((i) => i >= 0 && i < entryCount);
    const stack = valid ? v.stack : [...Array(entryCount).keys()];
    const bleedPx = v.mode === 'cutout' ? v.bleedPx : 0;
    const vKey = JSON.stringify([gKey, v.mode, stack, bleedPx.toFixed(4), v.scale]);
    if (!vectorCache || vectorCache.key !== vKey) {
      post({ type: 'progress', id, stage: 'Building layers…' });
      const paths = buildLayerPaths(graphCache.graph, { mode: v.mode, stack, bleedPx }, v.scale);
      vectorCache = { key: vKey, result: { stack, paths, mode: v.mode } };
    }
    vector = vectorCache.result;
  }
  return {
    imageVersion,
    width: quant.width,
    height: quant.height,
    quant: { key: qKey, centroids: quant.centroids, counts: quant.counts },
    entryCount,
    labels: labels.slice(),
    counts: countLabels(labels, entryCount),
    cleanKey: cKey,
    thinCount: cleanCache.thin ? cleanCache.thin.count : -1,
    thinMask: cleanCache.thin ? cleanCache.thin.mask.slice() : new Uint8Array(0),
    vector,
  };
}

/** Full-resolution flattened PNG, nearest-neighbour mapped from the label map. */
async function renderPng(id: number, ow: number, oh: number, colors: (RGB | null)[]): Promise<void> {
  try {
    if (!cleanCache) throw new Error('Nothing to export yet');
    const { width: w, height: h, labels } = cleanCache.map;
    const lut = new Uint32Array(256);
    const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    colors.forEach((c, i) => {
      if (!c || i === VOID) return;
      lut[i] = little ? (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0] : (c[0] << 24) | (c[1] << 16) | (c[2] << 8) | 255;
    });
    const rgba = new Uint8ClampedArray(ow * oh * 4);
    const px = new Uint32Array(rgba.buffer);
    const xs = new Int32Array(ow);
    for (let x = 0; x < ow; x++) xs[x] = Math.min(w - 1, Math.floor(((x + 0.5) * w) / ow));
    for (let y = 0; y < oh; y++) {
      const row = Math.min(h - 1, Math.floor(((y + 0.5) * h) / oh)) * w;
      const o = y * ow;
      for (let x = 0; x < ow; x++) px[o + x] = lut[labels[row + xs[x]]];
    }
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(ow, oh);
      const g = canvas.getContext('2d');
      if (g) {
        g.putImageData(new ImageData(rgba, ow, oh), 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        post({ type: 'png', id, blob, rgba: null, width: ow, height: oh });
        return;
      }
    }
    post({ type: 'png', id, blob: null, rgba, width: ow, height: oh }, [rgba.buffer]);
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Thin-feature detection is the slowest step, so it runs after the result has
 * been posted, one color per task, and is abandoned when a new message arrives.
 */
function computeThinInBackground(): void {
  const cache = cleanCache;
  if (!cache || cache.thin) return;
  const serial = messageSerial;
  const steps = thinFeatureSteps(cache.map, cache.minFeaturePx);
  const step = (): void => {
    if (serial !== messageSerial || cleanCache !== cache) return;
    const r = steps.next();
    if (!r.done) {
      setTimeout(step, 0);
      return;
    }
    cache.thin = r.value;
    post({ type: 'thin', cleanKey: cache.key, count: r.value.count, mask: r.value.mask.slice() });
  };
  setTimeout(step, 0);
}

/** Bambu Studio-compatible 3MF built from the current traced shapes. */
function render3mf(id: number, cleanKey: string, options: Model3dOptions, objectName: string): void {
  try {
    if (!graphCache || graphCache.cleanKey !== cleanKey) {
      throw new Error('The preview is out of date; wait for it to finish updating and try again.');
    }
    const parts = buildParts(graphCache.graph, options);
    const files = buildThreeMf({ objectName, parts });
    const entries: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
    const data = zipSync(entries, { level: 6 });
    post({ type: '3mf', id, data, parts: parts.filter((p) => p.mesh.triangles.length > 0).length }, [data.buffer]);
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  messageSerial++;
  if (msg.type === 'image') {
    image = { width: msg.width, height: msg.height, data: msg.data };
    imageVersion = msg.version;
    quantCache = null;
    cleanCache = null;
    graphCache = null;
    vectorCache = null;
    return;
  }
  if (msg.type === 'png') {
    void renderPng(msg.id, msg.width, msg.height, msg.colors);
    return;
  }
  if (msg.type === '3mf') {
    render3mf(msg.id, msg.cleanKey, msg.options, msg.objectName);
    return;
  }
  try {
    const result = run(msg.id, msg.params);
    post({ type: 'result', id: msg.id, result }, [result.labels.buffer, result.thinMask.buffer]);
    computeThinInBackground();
  } catch (err) {
    if (err instanceof StaleRequest) post({ type: 'error', id: msg.id, message: '' });
    else post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
