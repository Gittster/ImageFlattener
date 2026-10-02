import { describe, expect, it } from 'vitest';
import { quantize } from '../src/core/quantize';
import { VOID, type RasterImage } from '../src/core/types';
import { mulberry32 } from '../src/core/rng';

function noisyImage(w: number, h: number, seed = 7): RasterImage {
  const rand = mulberry32(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    // Four bands of color plus noise.
    const band = Math.floor((x / w) * 4);
    const base = [[220, 40, 40], [40, 180, 60], [30, 60, 200], [240, 230, 210]][band];
    for (let c = 0; c < 3; c++) data[i * 4 + c] = base[c] + (rand() - 0.5) * 60;
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

function solid(w: number, h: number, rgba: [number, number, number, number]): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

describe('k-means quantization', () => {
  it('is deterministic for a fixed seed', () => {
    const img = noisyImage(80, 40);
    const a = quantize(img, { k: 5, seed: 42 });
    const b = quantize(img, { k: 5, seed: 42 });
    expect(a.centroids).toEqual(b.centroids);
    expect(a.counts).toEqual(b.counts);
    expect(Array.from(a.labels)).toEqual(Array.from(b.labels));
  });

  it('can produce a different clustering with a different seed', () => {
    const img = noisyImage(80, 40);
    const results = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) results.add(JSON.stringify(quantize(img, { k: 6, seed }).centroids));
    expect(results.size).toBeGreaterThan(1);
  });

  it('finds the dominant colors, sorted by pixel count', () => {
    const img = noisyImage(80, 40);
    const q = quantize(img, { k: 4, seed: 1 });
    expect(q.centroids).toHaveLength(4);
    expect(q.counts.reduce((s, c) => s + c, 0)).toBe(80 * 40);
    for (let i = 1; i < q.counts.length; i++) expect(q.counts[i]).toBeLessThanOrEqual(q.counts[i - 1]);
    // Each band maps to a single cluster.
    const bandLabels = [0, 1, 2, 3].map((band) => new Set(Array.from({ length: 40 }, (_, y) => q.labels[y * 80 + band * 20 + 10])));
    for (const s of bandLabels) expect(s.size).toBe(1);
  });

  it('clamps k to the number of distinct colors', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) data.set(i < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
    const q = quantize({ width: 4, height: 4, data }, { k: 12, seed: 1 });
    expect(q.centroids).toHaveLength(2);
    expect(q.counts).toEqual([8, 8]);
  });

  it('merges clusters that are visually indistinguishable', () => {
    // Two near-identical oranges (anti-aliasing rounding) and one blue, with k = 4.
    const data = new Uint8ClampedArray(30 * 4);
    for (let i = 0; i < 30; i++) data.set(i < 10 ? [244, 162, 97, 255] : i < 20 ? [243, 160, 96, 255] : [30, 50, 90, 255], i * 4);
    const q = quantize({ width: 30, height: 1, data }, { k: 4, seed: 1 });
    expect(q.centroids).toHaveLength(2);
    expect(q.counts).toEqual([20, 10]);
  });

  it('handles a 1-pixel image', () => {
    const q = quantize(solid(1, 1, [10, 20, 30, 255]), { k: 4, seed: 1 });
    expect(q.centroids).toEqual([[10, 20, 30]]);
    expect(Array.from(q.labels)).toEqual([0]);
  });

  it('ignores transparent pixels and labels them VOID', () => {
    const data = new Uint8ClampedArray(3 * 1 * 4);
    data.set([255, 255, 255, 0], 0); // fully transparent white: must not become a cluster
    data.set([0, 0, 0, 255], 4);
    data.set([0, 0, 0, 255], 8);
    const q = quantize({ width: 3, height: 1, data }, { k: 4, seed: 1 });
    expect(q.centroids).toEqual([[0, 0, 0]]);
    expect(Array.from(q.labels)).toEqual([VOID, 0, 0]);
  });

  it('returns no clusters for a fully transparent image', () => {
    const q = quantize(solid(5, 5, [0, 0, 0, 0]), { k: 4, seed: 1 });
    expect(q.centroids).toHaveLength(0);
    expect(q.labels.every((l) => l === VOID)).toBe(true);
  });
});
