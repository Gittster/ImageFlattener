/// <reference lib="webworker" />
import { blurImage } from './core/blur';
import { despeckle, findThinFeatures, modeFilter } from './core/cleanup';
import { applyGroups, countLabels } from './core/palette';
import { quantize, type QuantizeResult } from './core/quantize';
import type { LabelMap, RasterImage } from './core/types';
import type { PipelineParams, PipelineResult, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let image: RasterImage | null = null;
let imageVersion = 0;
let quantCache: { key: string; result: QuantizeResult } | null = null;
let cleanCache: { key: string; map: LabelMap; thin: { count: number; mask: Uint8Array } } | null = null;

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
  return {
    width: quant.width,
    height: quant.height,
    quant: { key: qKey, centroids: quant.centroids, counts: quant.counts },
    entryCount,
    labels: labels.slice(),
    counts: countLabels(labels, entryCount),
    thinCount: cleanCache.thin.count,
    thinMask: cleanCache.thin.mask.slice(),
  };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'image') {
    image = { width: msg.width, height: msg.height, data: msg.data };
    imageVersion++;
    quantCache = null;
    cleanCache = null;
    return;
  }
  try {
    const result = run(msg.id, msg.params);
    post({ type: 'result', id: msg.id, result }, [result.labels.buffer, result.thinMask.buffer]);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
