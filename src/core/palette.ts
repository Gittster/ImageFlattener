import { labToRgb, rgbToHex, rgbToLab, type RGB } from './color';
import { VOID } from './types';

export interface PaletteEntry {
  /** Stable id within the current clustering result. */
  id: number;
  /** Indices of the k-means clusters merged into this entry. */
  clusters: number[];
  /** Cluster color (weighted mean of member clusters). */
  base: RGB;
  /** User override (output color only), as #RRGGBB. */
  override: string | null;
}

export function entriesFromClusters(centroids: RGB[]): PaletteEntry[] {
  return centroids.map((c, i) => ({ id: i, clusters: [i], base: c, override: null }));
}

/** Map from cluster index to palette entry index. */
export function clusterGroups(entries: PaletteEntry[], clusterCount: number): number[] {
  const groups = new Array<number>(clusterCount).fill(0);
  entries.forEach((e, idx) => e.clusters.forEach((c) => (groups[c] = idx)));
  return groups;
}

/**
 * Merge entries (by index) into the first one. The merged base color is the
 * pixel-weighted CIELAB mean of the member clusters.
 */
export function mergeEntries(
  entries: PaletteEntry[],
  indices: number[],
  centroids: RGB[],
  clusterCounts: number[],
): PaletteEntry[] {
  const sel = [...new Set(indices)].filter((i) => i >= 0 && i < entries.length).sort((a, b) => a - b);
  if (sel.length < 2) return entries;
  const target = entries[sel[0]];
  const clusters = sel.flatMap((i) => entries[i].clusters);
  let L = 0, A = 0, B = 0, W = 0;
  for (const c of clusters) {
    const w = Math.max(clusterCounts[c] ?? 0, 1e-9);
    const [l, a, b] = rgbToLab(...centroids[c]);
    L += l * w;
    A += a * w;
    B += b * w;
    W += w;
  }
  const merged: PaletteEntry = {
    id: target.id,
    clusters,
    base: labToRgb(L / W, A / W, B / W),
    override: target.override,
  };
  return entries.flatMap((e, i) => (i === sel[0] ? [merged] : sel.includes(i) ? [] : [e]));
}

/**
 * Resolve the output color of each entry: user override wins, then the
 * optional black/white pinning of the darkest/lightest entry, then the cluster color.
 */
export function resolveColors(entries: PaletteEntry[], forceBW: boolean): string[] {
  const out = entries.map((e) => e.override ?? rgbToHex(e.base));
  if (forceBW && entries.length >= 1) {
    const L = entries.map((e) => rgbToLab(...e.base)[0]);
    let dark = 0, light = 0;
    L.forEach((v, i) => {
      if (v < L[dark]) dark = i;
      if (v > L[light]) light = i;
    });
    if (entries.length === 1) {
      // A single color: pin to whichever extreme it is closer to.
      if (!entries[0].override) out[0] = L[0] < 50 ? '#000000' : '#FFFFFF';
      return out;
    }
    if (!entries[dark].override) out[dark] = '#000000';
    if (!entries[light].override) out[light] = '#FFFFFF';
  }
  return out;
}

/** Remap cluster labels to palette entry labels (VOID is preserved). */
export function applyGroups(labels: Uint8Array, groups: number[]): Uint8Array {
  const lut = new Uint8Array(256).fill(VOID);
  groups.forEach((g, c) => (lut[c] = g));
  const out = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) out[i] = lut[labels[i]];
  return out;
}

export function countLabels(labels: Uint8Array, k: number): number[] {
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l < k) counts[l]++;
  }
  return counts;
}
