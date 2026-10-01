/** Label value used for transparent pixels (and the area outside the image). */
export const VOID = 255;

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8ClampedArray;
}

/** A per-pixel label map. Values 0..k-1 are palette entries, VOID is transparent. */
export interface LabelMap {
  width: number;
  height: number;
  labels: Uint8Array;
}
