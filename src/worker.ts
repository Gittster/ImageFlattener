/// <reference lib="webworker" />
import { blurImage } from './core/blur';
import { quantize, type QuantizeResult } from './core/quantize';
import type { RasterImage } from './core/types';
import type { PipelineParams, PipelineResult, WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let image: RasterImage | null = null;
let imageVersion = 0;
let quantCache: { key: string; result: QuantizeResult } | null = null;

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
  return {
    width: quant.width,
    height: quant.height,
    quant: { key: qKey, centroids: quant.centroids, counts: quant.counts },
    labels: quant.labels.slice(),
  };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'image') {
    image = { width: msg.width, height: msg.height, data: msg.data };
    imageVersion++;
    quantCache = null;
    return;
  }
  try {
    const result = run(msg.id, msg.params);
    post({ type: 'result', id: msg.id, result }, [result.labels.buffer]);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
