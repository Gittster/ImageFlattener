import { VOID, type LabelMap } from './types';

/**
 * Brush edits are stored per working-image pixel, in palette-entry-id space so
 * they survive palette merges and reordering:
 *   0          no edit (use the computed label)
 *   1..254     palette entry with id = value - 1
 *   EDIT_VOID  painted transparent
 */
export const EDIT_NONE = 0;
export const EDIT_VOID = 255;

export function editValueForEntry(id: number): number {
  return id + 1;
}

/**
 * Apply edits on top of a (cleaned) label map. `idToIndex[id]` maps a palette
 * entry id to its current index (or -1 if it no longer exists).
 */
export function applyEdits(map: LabelMap, edits: Uint8Array, idToIndex: ArrayLike<number>): LabelMap {
  const labels = map.labels.slice();
  for (let i = 0; i < labels.length; i++) {
    const v = edits[i];
    if (v === EDIT_NONE) continue;
    if (v === EDIT_VOID) labels[i] = VOID;
    else {
      const idx = idToIndex[v - 1];
      if (idx !== undefined && idx >= 0) labels[i] = idx;
    }
  }
  return { width: map.width, height: map.height, labels };
}

export function hasEdits(edits: Uint8Array | null): boolean {
  if (!edits) return false;
  for (let i = 0; i < edits.length; i++) if (edits[i] !== EDIT_NONE) return true;
  return false;
}

/** Record of the pixels a stroke changed, for undo. */
export interface StrokeUndo {
  indices: number[];
  previous: number[];
}

/**
 * Stamp a round brush of the given diameter (pixels) along the segment
 * (x0,y0)-(x1,y1). Returns how many pixels changed; their previous values are
 * appended to `undo` (each pixel at most once per stroke via `touched`).
 */
export function paintSegment(
  edits: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  diameter: number,
  value: number,
  undo: StrokeUndo,
  touched: Set<number>,
  onPixel?: (i: number) => void,
): number {
  const r = Math.max(0.5, diameter / 2);
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len / Math.max(0.5, r / 2)));
  let changed = 0;
  for (let s = 0; s <= steps; s++) {
    const cx = x0 + ((x1 - x0) * s) / steps;
    const cy = y0 + ((y1 - y0) * s) / steps;
    const xa = Math.max(0, Math.floor(cx - r)), xb = Math.min(width - 1, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r)), yb = Math.min(height - 1, Math.ceil(cy + r));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        // Pixel centers within the brush circle.
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > r * r) continue;
        const i = y * width + x;
        if (edits[i] === value) continue;
        if (!touched.has(i)) {
          touched.add(i);
          undo.indices.push(i);
          undo.previous.push(edits[i]);
        }
        edits[i] = value;
        changed++;
        onPixel?.(i);
      }
    }
  }
  return changed;
}

export function undoStroke(edits: Uint8Array, undo: StrokeUndo): void {
  for (let k = undo.indices.length - 1; k >= 0; k--) edits[undo.indices[k]] = undo.previous[k];
}

/** Rewrite entry ids in edits (e.g. after merging entries or re-clustering). */
export function remapEdits(edits: Uint8Array, idMap: Map<number, number | null>): void {
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = v;
  for (const [from, to] of idMap) lut[from + 1] = to === null ? EDIT_NONE : to + 1;
  for (let i = 0; i < edits.length; i++) edits[i] = lut[edits[i]];
}

/** Nearest-neighbour resample of an edit layer to new dimensions. */
export function resampleEdits(edits: Uint8Array, w: number, h: number, nw: number, nh: number): Uint8Array {
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / nh));
    for (let x = 0; x < nw; x++) out[y * nw + x] = edits[sy * w + Math.min(w - 1, Math.floor(((x + 0.5) * w) / nw))];
  }
  return out;
}
