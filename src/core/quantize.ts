import { labToRgb, rgbToLab, type RGB } from './color';
import { mulberry32 } from './rng';
import { VOID, type RasterImage } from './types';

/** Pixels with alpha below this are treated as transparent (VOID). */
export const ALPHA_THRESHOLD = 128;

/** Above this many distinct colors, colors are binned to 6 bits per channel. */
const MAX_EXACT_COLORS = 65536;

export interface QuantizeOptions {
  /** Requested number of colors. Clamped to the number of distinct colors. */
  k: number;
  seed: number;
  maxIterations?: number;
}

export interface QuantizeResult {
  width: number;
  height: number;
  /** Per-pixel cluster index, or VOID for transparent pixels. */
  labels: Uint8Array;
  /** Cluster centers in sRGB, sorted by pixel count (descending). */
  centroids: RGB[];
  /** Cluster centers in CIELAB (same order as centroids). */
  centroidsLab: [number, number, number][];
  /** Pixel count per cluster. */
  counts: number[];
}

interface Histogram {
  /** Lab coordinates, 3 per entry. */
  lab: Float64Array;
  weight: Float64Array;
  /** Per-pixel histogram entry index, -1 for transparent. */
  pixelBin: Int32Array;
}

function buildHistogram(img: RasterImage): Histogram {
  const { data } = img;
  const n = img.width * img.height;
  const pixelBin = new Int32Array(n);

  const tryBuild = (shift: number): { keys: number[]; sums: Float64Array; counts: Float64Array } | null => {
    const index = new Map<number, number>();
    const keys: number[] = [];
    let sums = new Float64Array(1024 * 3);
    let counts = new Float64Array(1024);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (data[o + 3] < ALPHA_THRESHOLD) {
        pixelBin[i] = -1;
        continue;
      }
      const r = data[o], g = data[o + 1], b = data[o + 2];
      const key = ((r >> shift) << 16) | ((g >> shift) << 8) | (b >> shift);
      let idx = index.get(key);
      if (idx === undefined) {
        idx = keys.length;
        if (shift === 0 && idx >= MAX_EXACT_COLORS) return null;
        index.set(key, idx);
        keys.push(key);
        if (idx >= counts.length) {
          const nc = new Float64Array(counts.length * 2);
          nc.set(counts);
          counts = nc;
          const ns = new Float64Array(sums.length * 2);
          ns.set(sums);
          sums = ns;
        }
      }
      pixelBin[i] = idx;
      counts[idx] += 1;
      sums[idx * 3] += r;
      sums[idx * 3 + 1] += g;
      sums[idx * 3 + 2] += b;
    }
    return { keys, sums, counts };
  };

  const built = tryBuild(0) ?? tryBuild(2)!;
  const m = built.keys.length;
  const lab = new Float64Array(m * 3);
  const weight = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const c = built.counts[i];
    const [L, A, B] = rgbToLab(built.sums[i * 3] / c, built.sums[i * 3 + 1] / c, built.sums[i * 3 + 2] / c);
    lab[i * 3] = L;
    lab[i * 3 + 1] = A;
    lab[i * 3 + 2] = B;
    weight[i] = c;
  }
  return { lab, weight, pixelBin };
}

function dist2(lab: Float64Array, i: number, c: Float64Array, j: number): number {
  const dl = lab[i * 3] - c[j * 3];
  const da = lab[i * 3 + 1] - c[j * 3 + 1];
  const db = lab[i * 3 + 2] - c[j * 3 + 2];
  return dl * dl + da * da + db * db;
}

/**
 * Weighted k-means in CIELAB with k-means++ initialisation. Deterministic for a
 * given (points, k, seed).
 */
export function kmeansLab(
  lab: Float64Array,
  weight: Float64Array,
  kRequested: number,
  seed: number,
  maxIterations = 40,
): { centers: Float64Array; assign: Int32Array; k: number } {
  const m = weight.length;
  const rand = mulberry32(seed);
  let k = Math.max(0, Math.min(kRequested, m));
  const centers = new Float64Array(Math.max(k, 1) * 3);
  const assign = new Int32Array(m);
  if (k === 0) return { centers: new Float64Array(0), assign, k: 0 };

  // k-means++ seeding (weighted by pixel count).
  const d2 = new Float64Array(m).fill(Infinity);
  const pickWeighted = (scores: Float64Array, total: number): number => {
    let r = rand() * total;
    for (let i = 0; i < m; i++) {
      r -= scores[i];
      if (r <= 0 && scores[i] > 0) return i;
    }
    for (let i = m - 1; i >= 0; i--) if (scores[i] > 0) return i;
    return 0;
  };
  let totalW = 0;
  for (let i = 0; i < m; i++) totalW += weight[i];
  let first = pickWeighted(weight, totalW);
  centers[0] = lab[first * 3];
  centers[1] = lab[first * 3 + 1];
  centers[2] = lab[first * 3 + 2];
  const scores = new Float64Array(m);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < m; i++) {
      const d = dist2(lab, i, centers, c - 1);
      if (d < d2[i]) d2[i] = d;
      scores[i] = d2[i] * weight[i];
      total += scores[i];
    }
    if (!(total > 0)) {
      // Fewer distinct points than requested clusters.
      k = c;
      break;
    }
    first = pickWeighted(scores, total);
    centers[c * 3] = lab[first * 3];
    centers[c * 3 + 1] = lab[first * 3 + 1];
    centers[c * 3 + 2] = lab[first * 3 + 2];
  }

  // Lloyd iterations.
  const sums = new Float64Array(k * 3);
  const wsum = new Float64Array(k);
  assign.fill(-1);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = 0;
    for (let i = 0; i < m; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(lab, i, centers, c);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        changed++;
      }
    }
    if (changed === 0) break;
    sums.fill(0);
    wsum.fill(0);
    for (let i = 0; i < m; i++) {
      const c = assign[i];
      const w = weight[i];
      sums[c * 3] += lab[i * 3] * w;
      sums[c * 3 + 1] += lab[i * 3 + 1] * w;
      sums[c * 3 + 2] += lab[i * 3 + 2] * w;
      wsum[c] += w;
    }
    for (let c = 0; c < k; c++) {
      if (wsum[c] > 0) {
        centers[c * 3] = sums[c * 3] / wsum[c];
        centers[c * 3 + 1] = sums[c * 3 + 1] / wsum[c];
        centers[c * 3 + 2] = sums[c * 3 + 2] / wsum[c];
      } else {
        // Empty cluster: move it to the point farthest from its center.
        let far = 0;
        let farD = -1;
        for (let i = 0; i < m; i++) {
          const d = dist2(lab, i, centers, assign[i]) * weight[i];
          if (d > farD) {
            farD = d;
            far = i;
          }
        }
        centers[c * 3] = lab[far * 3];
        centers[c * 3 + 1] = lab[far * 3 + 1];
        centers[c * 3 + 2] = lab[far * 3 + 2];
      }
    }
  }
  return { centers: centers.subarray(0, k * 3), assign, k };
}

/** Quantize an image to at most `k` colors. Transparent pixels get the VOID label. */
export function quantize(img: RasterImage, opts: QuantizeOptions): QuantizeResult {
  const { width, height } = img;
  const hist = buildHistogram(img);
  const { centers, assign, k } = kmeansLab(hist.lab, hist.weight, Math.min(opts.k, 254), opts.seed, opts.maxIterations);

  // Count pixels per cluster and drop empty clusters.
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < assign.length; i++) counts[assign[i]] += hist.weight[i];
  const order = [...Array(k).keys()].filter((c) => counts[c] > 0).sort((a, b) => counts[b] - counts[a] || a - b);
  const remap = new Int32Array(k).fill(-1);
  order.forEach((c, i) => (remap[c] = i));

  const n = width * height;
  const labels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = hist.pixelBin[i];
    labels[i] = b < 0 ? VOID : remap[assign[b]];
  }
  const centroidsLab = order.map((c) => [centers[c * 3], centers[c * 3 + 1], centers[c * 3 + 2]] as [number, number, number]);
  return {
    width,
    height,
    labels,
    centroids: centroidsLab.map(([L, a, b]) => labToRgb(L, a, b)),
    centroidsLab,
    counts: order.map((c) => counts[c]),
  };
}
