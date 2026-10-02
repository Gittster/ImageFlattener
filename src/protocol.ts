import type { RGB } from './core/color';
import type { ExportMode } from './core/svg';
import type { Model3dOptions } from './core/model3d';

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

export interface CleanupParams {
  /** Number of 3x3 majority-filter passes (0 = off). */
  modeFilter: number;
  /** Regions smaller than this many pixels are merged into a neighbour (0 = off). */
  despeckleArea: number;
  /** Minimum printable feature width in pixels (for thin-feature warnings). */
  minFeaturePx: number;
}

export interface VectorParams {
  /** Simplification tolerance in pixels. */
  tolerance: number;
  curves: boolean;
  mode: ExportMode;
  /** Palette entry indices, bottom of the stack first. */
  stack: number[];
  /** Cutout bleed in pixels. */
  bleedPx: number;
  /** Output units per pixel (mm per working-image pixel). */
  scale: number;
}

export interface EditParams {
  /** Version of the edit layer last sent with an 'edits' message (0 = none). */
  version: number;
  /** Palette entry id -> current entry index (-1 if gone), length 255. */
  idToIndex: number[];
}

export interface PipelineParams {
  /** Image the request was made for; results for older images are discarded. */
  imageVersion: number;
  quantize: QuantizeParams;
  palette: PaletteParams;
  cleanup: CleanupParams;
  /** Omitted when no vector output is needed. */
  vector?: VectorParams;
  edits: EditParams;
}

export interface VectorResult {
  /** Stack actually used (palette entry indices, bottom first). */
  stack: number[];
  /** SVG path data per stack position, in output units. */
  paths: string[];
  mode: ExportMode;
}

export interface QuantizeInfo {
  key: string;
  centroids: RGB[];
  counts: number[];
}

export interface PipelineResult {
  imageVersion: number;
  width: number;
  height: number;
  quant: QuantizeInfo;
  /** Number of palette entries the labels refer to. */
  entryCount: number;
  /** Final label map (after palette merges, cleanup and brush edits). */
  labels: Uint8Array;
  /** Labels before brush edits (only when edits were applied; empty otherwise). */
  baseLabels: Uint8Array;
  /** Pixel count per palette entry in the final label map. */
  counts: number[];
  /** Identifies the cleaned label map (thin-feature results refer to it). */
  cleanKey: string;
  /** Features thinner than the minimum feature size; -1 while still being computed. */
  thinCount: number;
  /** 1 for pixels belonging to a thin feature (empty while pending). */
  thinMask: Uint8Array;
  vector: VectorResult | null;
}

export type WorkerRequest =
  | { type: 'image'; version: number; width: number; height: number; data: Uint8ClampedArray }
  | { type: 'process'; id: number; params: PipelineParams }
  | { type: 'edits'; version: number; width: number; height: number; data: Uint8Array }
  | { type: 'png'; id: number; width: number; height: number; colors: (RGB | null)[] }
  | { type: '3mf'; id: number; cleanKey: string; options: Model3dOptions; objectName: string };

export type WorkerResponse =
  | { type: 'progress'; id: number; stage: string }
  | { type: 'result'; id: number; result: PipelineResult }
  | { type: 'thin'; cleanKey: string; count: number; mask: Uint8Array }
  | { type: 'error'; id: number; message: string }
  | { type: 'png'; id: number; blob: Blob | null; rgba: Uint8ClampedArray | null; width: number; height: number }
  | { type: '3mf'; id: number; data: Uint8Array; parts: number };
