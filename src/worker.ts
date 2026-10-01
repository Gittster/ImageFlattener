/// <reference lib="webworker" />
import { blurImage } from './core/blur';
import { despeckle, findThinFeatures, modeFilter } from './core/cleanup';
import { applyGroups, countLabels } from './core/palette';
import { quantize, type QuantizeResult } from './core/quantize';
import { buildLayerPaths } from './core/svg';
import { traceEdges, type EdgeGraph } from './core/trace';
import { VOID, type LabelMap, type RasterImage } from './core/types';
import type { PipelineParams, PipelineResult, VectorResult, WorkerRequest, WorkerResponse } from './protocol';
import type { RGB } from './core/color';

declare const self: DedicatedWorkerGlobalScope;

let image: RasterImage | null = null;
let imageVersion = 0;
let quantCache: { key: string; result: QuantizeResult } | null = null;
let cleanCache: { key: string; map: LabelMap; thin: { count: number; mask: Uint8Array } } | null = null;
let graphCache: { key: string; graph: EdgeGraph } | null = null;
let vectorCache: { key: string; result: VectorResult } | null = null;

function post(msg: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function run(id: number, params: PipelineParams): PipelineResult {
  if (!image) throw new Error('No image loaded');
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
    post({ type: 'progress', id, stage: 'Checking feature sizes…' });
    cleanCache = { key: cKey, map, thin: findThinFeatures(map, c.minFeaturePx) };
  }
  const labels = cleanCache.map.labels;

  let vector: VectorResult | null = null;
  const v = params.vector;
  if (v && entryCount > 0) {
    const gKey = JSON.stringify([cKey, v.tolerance, v.curves]);
    if (!graphCache || graphCache.key !== gKey) {
      post({ type: 'progress', id, stage: 'Tracing shapes…' });
      graphCache = { key: gKey, graph: traceEdges(cleanCache.map, { tolerance: v.tolerance, curves: v.curves }) };
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
    width: quant.width,
    height: quant.height,
    quant: { key: qKey, centroids: quant.centroids, counts: quant.counts },
    entryCount,
    labels: labels.slice(),
    counts: countLabels(labels, entryCount),
    thinCount: cleanCache.thin.count,
    thinMask: cleanCache.thin.mask.slice(),
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

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'image') {
    image = { width: msg.width, height: msg.height, data: msg.data };
    imageVersion++;
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
  try {
    const result = run(msg.id, msg.params);
    post({ type: 'result', id: msg.id, result }, [result.labels.buffer, result.thinMask.buffer]);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
