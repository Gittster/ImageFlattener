import type { RGB } from './core/color';

export interface QuantizeParams {
  colors: number;
  blur: number;
  seed: number;
}

export interface PaletteParams {
  /** Quantize key the grouping was made for; ignored if it doesn't match. */
  quantKey: string;
  /** cluster index -> palette entry index */
  groups: number[];
}

export interface PipelineParams {
  quantize: QuantizeParams;
  palette: PaletteParams;
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
  /** Number of palette entries the labels refer to. */
  entryCount: number;
  /** Final label map (after palette merges and cleanup). */
  labels: Uint8Array;
  /** Pixel count per palette entry in the final label map. */
  counts: number[];
}

export type WorkerRequest =
  | { type: 'image'; width: number; height: number; data: Uint8ClampedArray }
  | { type: 'process'; id: number; params: PipelineParams };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string }
  | { type: 'result'; id: number; result: PipelineResult }
  | { type: 'error'; id: number; message: string };
