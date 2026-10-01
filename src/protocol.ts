import type { RGB } from './core/color';

export interface QuantizeParams {
  colors: number;
  blur: number;
  seed: number;
}

export interface PipelineParams {
  quantize: QuantizeParams;
}

export interface QuantizeInfo {
  key: string;
  centroids: RGB[];
  counts: number[];
}

export interface PipelineResult {
  width: number;
  height: number;
  quant: QuantizeInfo;
  /** Final label map (after palette merges and cleanup). */
  labels: Uint8Array;
}

export type WorkerRequest =
  | { type: 'image'; width: number; height: number; data: Uint8ClampedArray }
  | { type: 'process'; id: number; params: PipelineParams };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string }
  | { type: 'result'; id: number; result: PipelineResult }
  | { type: 'error'; id: number; message: string };
