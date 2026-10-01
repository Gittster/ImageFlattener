import { VOID, type LabelMap } from './types';

/**
 * Majority (mode) filter over a 3x3 neighbourhood. Smooths jagged edges and
 * removes single-pixel noise. Ties keep the current label.
 */
export function modeFilter(map: LabelMap, iterations: number): LabelMap {
  const { width: w, height: h } = map;
  let src = map.labels;
  const counts = new Uint16Array(256);
  const seen = new Int32Array(9);
  for (let it = 0; it < iterations; it++) {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cur = src[y * w + x];
        let ns = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const l = src[yy * w + xx];
            if (counts[l]++ === 0) seen[ns++] = l;
          }
        }
        let best = cur;
        let bestC = counts[cur];
        for (let j = 0; j < ns; j++) {
          const l = seen[j];
          if (counts[l] > bestC) {
            best = l;
            bestC = counts[l];
          }
          counts[l] = 0;
        }
        dst[y * w + x] = best;
      }
    }
    src = dst;
  }
  return { width: w, height: h, labels: src };
}

export interface Components {
  /** Component id per pixel. */
  id: Int32Array;
  /** Pixel indices grouped by component (see start/size). */
  order: Int32Array;
  start: Int32Array;
  size: Int32Array;
  label: Uint8Array;
  count: number;
}

/** 4-connected components of equal labels. */
export function connectedComponents(map: LabelMap): Components {
  const { width: w, height: h, labels } = map;
  const n = w * h;
  const id = new Int32Array(n).fill(-1);
  const order = new Int32Array(n);
  const starts: number[] = [];
  const sizes: number[] = [];
  const compLabels: number[] = [];
  let head = 0;
  for (let s = 0; s < n; s++) {
    if (id[s] !== -1) continue;
    const c = starts.length;
    const l = labels[s];
    const begin = head;
    id[s] = c;
    order[head++] = s;
    for (let q = begin; q < head; q++) {
      const p = order[q];
      const x = p % w;
      if (x > 0 && id[p - 1] === -1 && labels[p - 1] === l) { id[p - 1] = c; order[head++] = p - 1; }
      if (x < w - 1 && id[p + 1] === -1 && labels[p + 1] === l) { id[p + 1] = c; order[head++] = p + 1; }
      if (p >= w && id[p - w] === -1 && labels[p - w] === l) { id[p - w] = c; order[head++] = p - w; }
      if (p + w < n && id[p + w] === -1 && labels[p + w] === l) { id[p + w] = c; order[head++] = p + w; }
    }
    starts.push(begin);
    sizes.push(head - begin);
    compLabels.push(l);
  }
  return {
    id,
    order,
    start: Int32Array.from(starts),
    size: Int32Array.from(sizes),
    label: Uint8Array.from(compLabels),
    count: starts.length,
  };
}

/**
 * Remove connected regions smaller than `minArea` pixels. Each small region is
 * reassigned to the neighbouring label it shares the longest border with
 * (ties go to the lower label). Regions are processed smallest-first and
 * merged regions are tracked so a speck merged into another speck is
 * re-evaluated with its combined size.
 */
export function despeckle(map: LabelMap, minArea: number): LabelMap {
  const { width: w, height: h } = map;
  if (minArea <= 1) return map;
  const comps = connectedComponents(map);
  const { id, order, start, count } = comps;
  if (count <= 1) return map;
  const n = w * h;
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const size = Int32Array.from(comps.size);
  const label = Uint8Array.from(comps.label);
  const members: number[][] = Array.from({ length: count }, (_, i) => [i]);
  const find = (c: number): number => {
    while (parent[c] !== c) {
      parent[c] = parent[parent[c]];
      c = parent[c];
    }
    return c;
  };

  // Min-heap of [size, comp] for small components.
  const heap: [number, number][] = [];
  const push = (item: [number, number]): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(heap[p], heap[i]) <= 0) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && cmp(heap[l], heap[m]) < 0) m = l;
        if (r < heap.length && cmp(heap[r], heap[m]) < 0) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const cmp = (a: [number, number], b: [number, number]): number => a[0] - b[0] || a[1] - b[1];
  for (let c = 0; c < count; c++) if (size[c] < minArea) push([size[c], c]);

  const border = new Float64Array(256);
  const neighborRoots = new Map<number, number>();
  while (heap.length > 0) {
    const [s, c] = pop();
    if (find(c) !== c || size[c] !== s || s >= minArea) continue;
    border.fill(0);
    neighborRoots.clear();
    for (const m of members[c]) {
      for (let k = start[m], e = start[m] + comps.size[m]; k < e; k++) {
        const p = order[k];
        const x = p % w;
        const nbs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
        for (const q of nbs) {
          if (q < 0 || q >= n) continue;
          const r = find(id[q]);
          if (r === c) continue;
          border[label[r]] += 1;
          neighborRoots.set(r, label[r]);
        }
      }
    }
    let best = -1;
    for (let l = 0; l < 256; l++) if (border[l] > 0 && (best < 0 || border[l] > border[best])) best = l;
    if (best < 0) continue; // isolated (whole image is one region)
    // Merge into every adjacent region that has the chosen label.
    let root = c;
    label[c] = best;
    for (const [r, l] of neighborRoots) {
      if (l !== best) continue;
      const a = find(r);
      const b = find(root);
      if (a === b) continue;
      const [big, small] = members[a].length >= members[b].length ? [a, b] : [b, a];
      parent[small] = big;
      size[big] += size[small];
      for (const m of members[small]) members[big].push(m);
      members[small] = [];
      label[big] = best;
      root = big;
    }
    if (size[root] < minArea) push([size[root], root]);
  }

  const out = new Uint8Array(n);
  for (let p = 0; p < n; p++) out[p] = label[find(id[p])];
  return { width: w, height: h, labels: out };
}

/**
 * Squared Euclidean distance transform (Felzenszwalb & Huttenlocher).
 * `seed[i] = 1` marks pixels at distance 0.
 */
export function edt(seed: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = seed[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const pass = (len: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    pass(h);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    pass(w);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

export interface ThinFeatures {
  /** Number of thin features found. */
  count: number;
  /** 1 where a pixel belongs to a counted thin feature. */
  mask: Uint8Array;
}

/**
 * Find features narrower than `minWidth` pixels: the parts of each color
 * region that a disk of diameter `minWidth` cannot reach (morphological
 * opening residue). Residue pieces smaller than minWidth² are ignored so that
 * ordinary corners don't count.
 */
export function findThinFeatures(map: LabelMap, minWidth: number): ThinFeatures {
  const steps = thinFeatureSteps(map, minWidth);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * Incremental version of findThinFeatures: yields after each color so the
 * caller can interleave other work (or abandon the computation).
 */
export function* thinFeatureSteps(map: LabelMap, minWidth: number): Generator<void, ThinFeatures, void> {
  const { width: w, height: h, labels } = map;
  const mask = new Uint8Array(w * h);
  const r = minWidth / 2;
  if (r <= 0.5) return { count: 0, mask };
  // Bounding boxes of all labels in one pass.
  const x0 = new Int32Array(256).fill(w), y0 = new Int32Array(256).fill(h);
  const x1 = new Int32Array(256).fill(-1), y1 = new Int32Array(256).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (x < x0[l]) x0[l] = x;
      if (x > x1[l]) x1[l] = x;
      if (y < y0[l]) y0[l] = y;
      if (y > y1[l]) y1[l] = y;
    }
  }
  const pad = Math.ceil(r) + 2;
  const residue = new Uint8Array(w * h);
  const thr = (r + 0.5) * (r + 0.5);
  // Pixel centers lie on an integer grid, so allow half a pixel of slack.
  const r2 = (r + 0.5) * (r + 0.5);
  for (let l = 0; l < 256; l++) {
    if (l === VOID || x1[l] < 0) continue;
    const bw = x1[l] - x0[l] + 1 + pad * 2;
    const bh = y1[l] - y0[l] + 1 + pad * 2;
    const outside = new Uint8Array(bw * bh).fill(1);
    for (let y = y0[l]; y <= y1[l]; y++) {
      const row = (y - y0[l] + pad) * bw + pad - x0[l];
      for (let x = x0[l]; x <= x1[l]; x++) if (labels[y * w + x] === l) outside[row + x] = 0;
    }
    const dOut = edt(outside, bw, bh);
    const eroded = new Uint8Array(bw * bh);
    let any = false;
    for (let i = 0; i < eroded.length; i++) {
      if (dOut[i] >= thr) {
        eroded[i] = 1;
        any = true;
      }
    }
    const dEro = any ? edt(eroded, bw, bh) : null;
    for (let y = y0[l]; y <= y1[l]; y++) {
      const row = (y - y0[l] + pad) * bw + pad - x0[l];
      for (let x = x0[l]; x <= x1[l]; x++) {
        const i = row + x;
        if (!outside[i] && (!dEro || dEro[i] > r2)) residue[y * w + x] = 1;
      }
    }
    yield;
  }
  // Group residue pixels into features (4-connected) and keep the big ones.
  const comps = connectedComponents({ width: w, height: h, labels: residue });
  const minArea = minWidth * minWidth;
  let count = 0;
  for (let c = 0; c < comps.count; c++) {
    if (comps.label[c] !== 1 || comps.size[c] < minArea) continue;
    count++;
    for (let k = comps.start[c], e = k + comps.size[c]; k < e; k++) mask[comps.order[k]] = 1;
  }
  return { count, mask };
}
