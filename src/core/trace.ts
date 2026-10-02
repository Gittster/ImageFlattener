import { fitCubics } from './fitcurve';
import { VOID, type LabelMap } from './types';

/**
 * Topology-preserving vectorization of a label map.
 *
 * The boundaries between differently-labelled pixels are traced along the
 * pixel-edge ("crack") grid and split into *edges*: maximal chains between
 * junction vertices where three or more boundary cracks meet. Every edge
 * separates exactly two labels (left/right). Each edge is simplified and
 * smoothed exactly once, and every region's outline is assembled from those
 * shared edges, so neighbouring regions agree on their common border: cutout
 * shapes tile with no gaps or overlaps, and the outline of any union of
 * labels (used for stacked layers) is built from the same geometry.
 *
 * Coordinates are in working-image pixels; (0,0) is the top-left corner of
 * the image. The area outside the image counts as VOID.
 */

export interface TraceOptions {
  /** Douglas-Peucker tolerance in pixels. */
  tolerance: number;
  /** Fit smooth cubic curves (true) or keep straight polylines (false). */
  curves: boolean;
  /** Turning angle (degrees) above which a vertex is kept as a sharp corner. */
  cornerAngle?: number;
}

/**
 * A boundary edge. Geometry is a chain of cubic segments:
 * seg = [x0, y0, (c1x, c1y, c2x, c2y, x1, y1)*]. For straight segments the
 * control points coincide with the end points.
 */
export interface Edge {
  /** Label on the left of the forward direction (screen coordinates, y down). */
  left: number;
  right: number;
  closed: boolean;
  /** Start/end vertex ids (y * (w + 1) + x); -1 for closed edges. */
  v0: number;
  v1: number;
  /** Unit direction of the first / last crack, as [dx, dy]. */
  d0: [number, number];
  d1: [number, number];
  seg: Float64Array;
}

export interface EdgeGraph {
  width: number;
  height: number;
  edges: Edge[];
  curves: boolean;
}

// Crack directions: 0 = east, 1 = south, 2 = west, 3 = north.
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

export function traceEdges(map: LabelMap, opts: TraceOptions): EdgeGraph {
  const { width: w, height: h, labels } = map;
  const L = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? VOID : labels[y * w + x]);
  const W1 = w + 1;
  const nH = w * (h + 1); // horizontal cracks: (x,y)-(x+1,y)
  const nV = W1 * h; // vertical cracks: (x,y)-(x,y+1)
  const isBoundary = new Uint8Array(nH + nV);
  for (let y = 0; y <= h; y++)
    for (let x = 0; x < w; x++) if (L(x, y - 1) !== L(x, y)) isBoundary[y * w + x] = 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x <= w; x++) if (L(x - 1, y) !== L(x, y)) isBoundary[nH + y * W1 + x] = 1;

  // The crack leaving vertex (x,y) in direction d, or -1.
  const crackAt = (x: number, y: number, d: number): number => {
    switch (d) {
      case 0: return x < w ? y * w + x : -1;
      case 2: return x > 0 ? y * w + x - 1 : -1;
      case 1: return y < h ? nH + y * W1 + x : -1;
      default: return y > 0 ? nH + (y - 1) * W1 + x : -1;
    }
  };
  const degree = (x: number, y: number): number => {
    let n = 0;
    for (let d = 0; d < 4; d++) {
      const c = crackAt(x, y, d);
      if (c >= 0 && isBoundary[c]) n++;
    }
    return n;
  };
  // Labels left/right of moving from (x,y) in direction d.
  const sides = (x: number, y: number, d: number): [number, number] => {
    switch (d) {
      case 0: return [L(x, y - 1), L(x, y)];
      case 2: return [L(x - 1, y), L(x - 1, y - 1)];
      case 1: return [L(x, y), L(x - 1, y)];
      default: return [L(x - 1, y - 1), L(x, y - 1)];
    }
  };

  const visited = new Uint8Array(nH + nV);
  const edges: Edge[] = [];
  const cornerCos = Math.cos(((opts.cornerAngle ?? 60) * Math.PI) / 180);

  const isImageCorner = (x: number, y: number): boolean => (x === 0 || x === w) && (y === 0 || y === h);

  // Walk from (x,y) in direction d until a junction (or back to start for cycles).
  const walk = (sx: number, sy: number, sd: number, closed: boolean): void => {
    const [left, right] = sides(sx, sy, sd);
    const dirs: number[] = [];
    let x = sx, y = sy, d = sd;
    for (;;) {
      visited[crackAt(x, y, d)] = 1;
      dirs.push(d);
      x += DX[d];
      y += DY[d];
      if (closed ? x === sx && y === sy : degree(x, y) !== 2) break;
      // Continue along the other boundary crack (never straight back).
      let next = -1;
      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((d + 2) & 3)) continue;
        const nc = crackAt(x, y, nd);
        if (nc >= 0 && isBoundary[nc]) {
          next = nd;
          break;
        }
      }
      d = next;
    }
    const n = dirs.length;
    // Length of the straight run each crack belongs to.
    const run = new Int32Array(n);
    for (let i = 0; i < n; ) {
      let j = i;
      while (j < n && dirs[j] === dirs[i]) j++;
      for (let k = i; k < j; k++) run[k] = j - i;
      i = j;
    }
    if (closed && n > 1 && dirs[0] === dirs[n - 1] && run[0] < n) {
      const total = run[0] + run[n - 1];
      for (let k = 0; k < n && dirs[k] === dirs[0]; k++) run[k] = total;
      for (let k = n - 1; k >= 0 && dirs[k] === dirs[0]; k--) run[k] = total;
    }
    // Points: crack midpoints (turns 1-pixel staircases into diagonals), plus
    // real corner vertices between two long runs and at image corners.
    // Corner vertices are locked: simplification never removes them.
    const pts: number[] = [];
    const locked: boolean[] = [];
    if (!closed) {
      pts.push(sx, sy);
      locked.push(true);
    }
    let vx = sx, vy = sy;
    for (let i = 0; i < n; i++) {
      const di = dirs[i];
      pts.push(vx + DX[di] * 0.5, vy + DY[di] * 0.5);
      locked.push(false);
      vx += DX[di];
      vy += DY[di];
      const j = i + 1 < n ? i + 1 : closed ? 0 : -1;
      if (j >= 0 && dirs[j] !== di && ((run[i] >= 2 && run[j] >= 2) || isImageCorner(vx, vy))) {
        pts.push(vx, vy);
        locked.push(true);
      }
    }
    if (!closed) {
      pts.push(x, y);
      locked.push(true);
    }
    const lastD = dirs[n - 1];
    edges.push({
      left,
      right,
      closed,
      v0: closed ? -1 : sy * W1 + sx,
      v1: closed ? -1 : y * W1 + x,
      d0: [DX[sd], DY[sd]],
      d1: [DX[lastD], DY[lastD]],
      seg: buildSegments(pts, locked, closed, opts.tolerance, opts.curves, cornerCos),
    });
  };

  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      if (degree(x, y) <= 2) continue;
      for (let d = 0; d < 4; d++) {
        const c = crackAt(x, y, d);
        if (c >= 0 && isBoundary[c] && !visited[c]) walk(x, y, d, false);
      }
    }
  }
  // Remaining boundary cracks form junction-free closed cycles.
  for (let c = 0; c < nH + nV; c++) {
    if (!isBoundary[c] || visited[c]) continue;
    if (c < nH) walk(c % w, Math.floor(c / w), 0, true);
    else walk((c - nH) % W1, Math.floor((c - nH) / W1), 1, true);
  }
  return { width: w, height: h, edges, curves: opts.curves };
}

// ------------------------------------------------------- simplification ---

/** Douglas-Peucker on a flat [x,y,...] array; keeps first and last point. */
export function douglasPeucker(pts: number[], tol: number): number[] {
  const n = pts.length / 2;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    const bx = pts[b * 2], by = pts[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      let d2: number;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        const cross = px * dy - py * dx;
        d2 = (cross * cross) / len2;
      }
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

/** Douglas-Peucker applied separately between consecutive locked points. */
function simplifyLocked(pts: number[], locked: boolean[], tol: number): { pts: number[]; locked: boolean[] } {
  const n = locked.length;
  const outPts: number[] = [pts[0], pts[1]];
  const outLocked: boolean[] = [locked[0]];
  let a = 0;
  for (let b = 1; b < n; b++) {
    if (!locked[b] && b !== n - 1) continue;
    const part = douglasPeucker(pts.slice(a * 2, b * 2 + 2), tol);
    for (let i = 2; i < part.length; i += 2) {
      outPts.push(part[i], part[i + 1]);
      outLocked.push(i === part.length - 2 ? locked[b] : false);
    }
    a = b;
  }
  return { pts: outPts, locked: outLocked };
}

function simplifyClosed(pts: number[], locked: boolean[], tol: number): { pts: number[]; locked: boolean[] } {
  const n = locked.length;
  const first = locked.indexOf(true);
  if (first >= 0) {
    // Rotate so the ring starts at a locked point, close it, simplify, reopen.
    const rp: number[] = [];
    const rl: boolean[] = [];
    for (let k = 0; k <= n; k++) {
      const i = (first + k) % n;
      rp.push(pts[i * 2], pts[i * 2 + 1]);
      rl.push(locked[i]);
    }
    const r = simplifyLocked(rp, rl, tol);
    return { pts: r.pts.slice(0, -2), locked: r.locked.slice(0, -1) };
  }
  return { pts: simplifyRing(pts, tol), locked: [] };
}

function simplifyRing(pts: number[], tol: number): number[] {
  // Treat as an open path that starts and ends at pts[0].
  const ring = pts.concat(pts[0], pts[1]);
  let s = douglasPeucker(ring, tol);
  s = s.slice(0, s.length - 2);
  if (s.length < 6) {
    // Too few points to enclose area: keep the points farthest apart.
    const n = pts.length / 2;
    let far = 0, best = -1;
    for (let i = 1; i < n; i++) {
      const d = (pts[i * 2] - pts[0]) ** 2 + (pts[i * 2 + 1] - pts[1]) ** 2;
      if (d > best) {
        best = d;
        far = i;
      }
    }
    const a = Math.round(far / 2);
    const b = Math.round((far + n) / 2) % n;
    const idx = [...new Set([0, a, far, b])].filter((i) => i < n).sort((p, q) => p - q);
    s = idx.flatMap((i) => [pts[i * 2], pts[i * 2 + 1]]);
  }
  return s;
}

/**
 * Rebuild sharp corners that pixelation and simplification cut off. A corner
 * on the pixel grid usually comes out of simplification as a short segment
 * (a flat tip or a notch) between two long ones. When the two long segments
 * turn by more than the corner angle, the short segment is replaced by the
 * point where the long segments' lines intersect, which is marked as a sharp
 * corner. The end points of open chains (shared junctions) never move.
 */
export function sharpenCorners(
  s: { pts: number[]; locked: boolean[]; i0?: number[]; i1?: number[] },
  closed: boolean,
  cornerCos: number,
  maxShort: number,
): { pts: number[]; locked: boolean[]; i0: number[]; i1: number[]; sharp: boolean[] } {
  const pts = s.pts.slice();
  const locked = Array.from({ length: pts.length / 2 }, (_, i) => !!s.locked[i]);
  // Range of original (dense) point indices each vertex stands for.
  const i0 = s.i0 ? s.i0.slice() : locked.map(() => -1);
  const i1 = s.i1 ? s.i1.slice() : locked.map(() => -1);
  const sharp = locked.map(() => false);
  const len = (i: number, j: number): number => Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
  let changed = true;
  while (changed) {
    changed = false;
    const n = pts.length / 2;
    if (n < (closed ? 5 : 4)) break;
    for (let a = closed ? 0 : 1; a < (closed ? n : n - 2); a++) {
      const b = (a + 1) % n;
      const pa = (a - 1 + n) % n;
      const nb = (b + 1) % n;
      const short = len(a, b);
      if (short > maxShort) continue;
      const l1 = len(pa, a);
      const l2 = len(b, nb);
      // Both neighbours must be clearly longer, so small shapes keep their form.
      // (On curves all segments have similar lengths, so they are left alone.)
      if (l1 < 2.5 * short || l2 < 2.5 * short || l1 < maxShort || l2 < maxShort) continue;
      const d1x = (pts[a * 2] - pts[pa * 2]) / l1, d1y = (pts[a * 2 + 1] - pts[pa * 2 + 1]) / l1;
      const d2x = (pts[nb * 2] - pts[b * 2]) / l2, d2y = (pts[nb * 2 + 1] - pts[b * 2 + 1]) / l2;
      if (d1x * d2x + d1y * d2y >= cornerCos) continue; // not a sharp enough turn
      const det = d1x * d2y - d1y * d2x;
      if (Math.abs(det) < 1e-9) continue; // parallel: a step, not a corner
      // Intersect a + t*d1 with b + u*d2.
      const wx = pts[b * 2] - pts[a * 2], wy = pts[b * 2 + 1] - pts[a * 2 + 1];
      const t = (wx * d2y - wy * d2x) / det;
      const u = (wx * d1y - wy * d1x) / det;
      // The corner must lie ahead of `a` and behind `b`, and not too far away.
      if (t < -1e-9 || u > 1e-9 || t > 4 * maxShort || -u > 4 * maxShort) continue;
      const x = pts[a * 2] + t * d1x, y = pts[a * 2 + 1] + t * d1y;
      pts[a * 2] = x;
      pts[a * 2 + 1] = y;
      locked[a] = true;
      sharp[a] = true;
      i1[a] = i1[b];
      pts.splice(b * 2, 2);
      locked.splice(b, 1);
      i0.splice(b, 1);
      i1.splice(b, 1);
      sharp.splice(b, 1);
      changed = true;
      break;
    }
  }
  return { pts, locked, i0, i1, sharp };
}

/**
 * Turn a point chain into cubic segments. Open chains keep their end points
 * fixed (they are shared junctions) and use one-sided tangents there.
 */
function buildSegments(
  pts: number[],
  locked: boolean[],
  closed: boolean,
  tol: number,
  curves: boolean,
  cornerCos: number,
): Float64Array {
  const base = closed ? simplifyClosed(pts, locked, tol) : simplifyLocked(pts, locked, tol);
  const idx = denseIndices(base.pts, pts, closed);
  const v = sharpenCorners({ pts: base.pts, locked: base.locked, i0: idx, i1: idx.slice() }, closed, cornerCos, 2 + 4 * tol);
  return curves ? fittedSegments(pts, closed, v, tol, cornerCos) : straightSegments(v.pts, closed);
}

/** Index in the dense point list of each simplified vertex (they are exact copies). */
function denseIndices(simple: number[], dense: number[], closed: boolean): number[] {
  const n = dense.length / 2;
  const where = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${dense[i * 2]},${dense[i * 2 + 1]}`;
    const list = where.get(key);
    if (list) list.push(i);
    else where.set(key, [i]);
  }
  const out: number[] = [];
  let prev = -1;
  for (let k = 0; k < simple.length / 2; k++) {
    const list = where.get(`${simple[k * 2]},${simple[k * 2 + 1]}`) ?? [0];
    // Vertices appear in walking order: take the next occurrence after the previous one.
    let best = list[0];
    if (prev >= 0) {
      let bestD = Infinity;
      for (const i of list) {
        const d = closed ? (i - prev + n) % n : i - prev;
        if (d > 0 && d < bestD) (bestD = d), (best = i);
      }
    }
    out.push(best);
    prev = best;
  }
  return out;
}

function straightSegments(p: number[], closed: boolean): Float64Array {
  const n = p.length / 2;
  const segCount = closed ? n : n - 1;
  const out = new Float64Array(2 + segCount * 6);
  out[0] = p[0];
  out[1] = p[1];
  for (let s = 0; s < segCount; s++) {
    const j = (s + 1) % n;
    const o = 2 + s * 6;
    out[o] = p[s * 2];
    out[o + 1] = p[s * 2 + 1];
    out[o + 2] = out[o + 4] = p[j * 2];
    out[o + 3] = out[o + 5] = p[j * 2 + 1];
  }
  return out;
}

/** Arc-length window (px) over which a corner's turning angle is measured. */
const CORNER_WINDOW = 3;
/** Binomial smoothing passes over the staircase points before fitting. */
const SMOOTH_PASSES = 6;
/** Minimum turn over that window for a polygon corner to be kept sharp. */
const WINDOW_CORNER_COS = Math.cos((40 * Math.PI) / 180);

/**
 * Smooth curves through the dense boundary points. Corners come from the
 * simplified/sharpened vertices, but a vertex only counts as a corner if the
 * boundary really turns sharply over a few pixels on each side (so small round
 * dots don't become polygons). Between corners, the staircase points are
 * lightly smoothed and fitted with least-squares cubic Béziers.
 */
function fittedSegments(
  dense: number[],
  closed: boolean,
  v: { pts: number[]; i0: number[]; i1: number[]; sharp: boolean[] },
  tol: number,
  cornerCos: number,
): Float64Array {
  const n = dense.length / 2;
  const D: [number, number][] = Array.from({ length: n }, (_, i) => [dense[i * 2], dense[i * 2 + 1]]);
  const m = v.pts.length / 2;
  const at = (i: number): number => (closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
  const step = closed ? (i: number, d: number): number => (i + d + n) % n : (i: number, d: number): number => i + d;

  // A point about CORNER_WINDOW px away from dense index `from`, walking in direction `dir`.
  const reach = (from: number, dir: 1 | -1): [number, number] => {
    let i = from, dist = 0;
    for (let k = 0; k < n; k++) {
      const j = step(i, dir);
      if (!closed && (j < 0 || j >= n)) break;
      dist += Math.hypot(D[j][0] - D[i][0], D[j][1] - D[i][1]);
      i = j;
      if (dist >= CORNER_WINDOW) break;
    }
    return D[i];
  };
  const isCorner: boolean[] = [];
  for (let k = 0; k < m; k++) {
    if (!closed && (k === 0 || k === m - 1)) {
      isCorner.push(true);
      continue;
    }
    if (v.sharp[k]) {
      // Rebuilt from two long edges meeting at a sharp angle.
      isCorner.push(true);
      continue;
    }
    // The simplified polygon turns sharply here; confirm the boundary itself
    // turns by at least WINDOW_CORNER_DEG over a few pixels on each side.
    const kp = (k - 1 + m) % m, kn = (k + 1) % m;
    const sx = v.pts[k * 2] - v.pts[kp * 2], sy = v.pts[k * 2 + 1] - v.pts[kp * 2 + 1];
    const tx = v.pts[kn * 2] - v.pts[k * 2], ty = v.pts[kn * 2 + 1] - v.pts[k * 2 + 1];
    const ls = Math.hypot(sx, sy), lt = Math.hypot(tx, ty);
    if (!(ls > 1e-9 && lt > 1e-9 && (sx * tx + sy * ty) / (ls * lt) < cornerCos)) {
      isCorner.push(false);
      continue;
    }
    const c: [number, number] = [v.pts[k * 2], v.pts[k * 2 + 1]];
    const p = reach(v.i0[k], -1);
    const q = reach(v.i1[k], 1);
    const ax = c[0] - p[0], ay = c[1] - p[1], bx = q[0] - c[0], by = q[1] - c[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    isCorner.push(la > 1e-9 && lb > 1e-9 && (ax * bx + ay * by) / (la * lb) < WINDOW_CORNER_COS);
  }

  // Light smoothing of the staircase, with corners (and open ends) pinned.
  const pinned = new Uint8Array(n);
  if (!closed) pinned[0] = pinned[n - 1] = 1;
  for (let k = 0; k < m; k++) {
    if (!isCorner[k]) continue;
    for (let i = v.i0[k], guard = 0; guard <= n; i = step(i, 1), guard++) {
      pinned[at(i)] = 1;
      if (at(i) === at(v.i1[k])) break;
    }
  }
  // Binomial smoothing of the staircase (corners pinned).
  let S = D.map((p) => [p[0], p[1]] as [number, number]);
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = S.map((p) => [p[0], p[1]] as [number, number]);
    for (let i = 0; i < n; i++) {
      if (pinned[i] || (!closed && (i === 0 || i === n - 1))) continue;
      const a = S[at(i - 1)], b = S[at(i + 1)];
      next[i] = [0.25 * a[0] + 0.5 * S[i][0] + 0.25 * b[0], 0.25 * a[1] + 0.5 * S[i][1] + 0.25 * b[1]];
    }
    S = next;
  }

  // Fit error in px. Loose enough not to follow anti-aliasing noise (edge
  // pixels of real images jitter by ~0.5 px), tight enough to stay within
  // ~0.35 px of clean analytic curves (see tests/vector.test.ts).
  const err = Math.max(0.15, 0.35 * tol);
  const segs: number[] = [];
  const corners = [...Array(m).keys()].filter((k) => isCorner[k]);

  if (corners.length === 0) {
    // Closed curve without corners: fit two halves between opposite points,
    // with the same (centered) tangent on both sides of each join.
    const s0 = at(v.i0[0]);
    const s1 = at(s0 + Math.floor(n / 2));
    // Tangent from a least-squares line through the points within ~4 px.
    const tangentAt = (i: number): [number, number] => {
      const pts: [number, number][] = [S[i]];
      for (const dir of [-1, 1]) {
        let j = i, dist = 0;
        for (let k = 0; k < n / 4 && dist < 4; k++) {
          const nj = at(j + dir);
          dist += Math.hypot(S[nj][0] - S[j][0], S[nj][1] - S[j][1]);
          j = nj;
          pts.push(S[j]);
        }
      }
      const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const p of pts) {
        sxx += (p[0] - mx) ** 2;
        sxy += (p[0] - mx) * (p[1] - my);
        syy += (p[1] - my) ** 2;
      }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      let t: [number, number] = [Math.cos(ang), Math.sin(ang)];
      // Orient along the walking direction.
      const fwd = S[at(i + 1)], back = S[at(i - 1)];
      if (t[0] * (fwd[0] - back[0]) + t[1] * (fwd[1] - back[1]) < 0) t = [-t[0], -t[1]];
      return t;
    };
    const t0 = tangentAt(s0), t1 = tangentAt(s1);
    const half = (from: number, to: number, tf: [number, number], tt: [number, number]): void => {
      const data: [number, number][] = [];
      for (let i = from, guard = 0; guard <= n; i = at(i + 1), guard++) {
        data.push(S[i]);
        if (i === to) break;
      }
      if (data.length < 2) return;
      fitCubics(data, tf, [-tt[0], -tt[1]], err, segs);
    };
    half(s0, s1, t0, t1);
    half(s1, s0, t1, t0);
    return Float64Array.from([S[s0][0], S[s0][1], ...segs]);
  }

  const spanCount = closed ? corners.length : corners.length - 1;
  for (let c = 0; c < spanCount; c++) {
    const ka = corners[c], kb = corners[(c + 1) % corners.length];
    const A: [number, number] = [v.pts[ka * 2], v.pts[ka * 2 + 1]];
    const B: [number, number] = [v.pts[kb * 2], v.pts[kb * 2 + 1]];
    const data: [number, number][] = [A];
    for (let i = step(v.i1[ka], 1), guard = 0; guard < n; i = step(i, 1), guard++) {
      if (!closed && (i < 0 || i >= n)) break;
      if (at(i) === at(v.i0[kb])) break;
      data.push(S[at(i)]);
    }
    data.push(B);
    // Points right next to a corner are the pixel-rounded tip, not the edge.
    const clean = data.filter(
      (p, k) => k === 0 || k === data.length - 1 || (Math.hypot(p[0] - A[0], p[1] - A[1]) > 1.25 && Math.hypot(p[0] - B[0], p[1] - B[1]) > 1.25),
    );
    fitSpan(clean, err, segs);
  }
  return Float64Array.from([v.pts[corners[0] * 2], v.pts[corners[0] * 2 + 1], ...segs]);
}

/**
 * Spans within this distance (px) of their chord are drawn as straight lines.
 * Covers the pixel staircase plus anti-aliasing noise of real straight edges.
 */
const STRAIGHT_PX = 0.85;
/** ...as long as they don't bow away from it by more than this (px). */
const STRAIGHT_SAG_PX = 0.2;

/** Solve a 3x3 linear system (row-major) by Cramer's rule; zeros if singular. */
function solve3(m: number[], r: number[]): [number, number, number] {
  const det = (a: number[]): number =>
    a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return [0, 0, 0];
  const col = (k: number): number[] => m.map((v, i) => (i % 3 === k ? r[Math.floor(i / 3)] : v));
  return [det(col(0)) / d, det(col(1)) / d, det(col(2)) / d];
}

const normalizeV = (a: [number, number]): [number, number] => {
  const l = Math.hypot(a[0], a[1]);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0];
};

/**
 * Fit one span between two corners: a straight segment if it is straight, else
 * cubics. `tA`/`tB` override the end tangents (pointing into the span).
 */
function fitSpan(data: [number, number][], err: number, out: number[], tA?: [number, number], tB?: [number, number]): void {
  const A = data[0], B = data[data.length - 1];
  const chord = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const straight = (): void => void out.push(A[0], A[1], B[0], B[1], B[0], B[1]);
  if (data.length <= 2) return straight();
  // A span whose ends (nearly) meet, e.g. a closed loop with a single corner,
  // has no usable chord: split it at the point farthest from its ends, with a
  // shared tangent there.
  let far = 0, farD = 0;
  for (let i = 1; i < data.length - 1; i++) {
    const d = Math.min(Math.hypot(data[i][0] - A[0], data[i][1] - A[1]), Math.hypot(data[i][0] - B[0], data[i][1] - B[1]));
    if (d > farD) [far, farD] = [i, d];
  }
  if (chord < 1e-9 || chord < 0.5 * farD) {
    if (farD < 1e-9) return straight();
    const r = Math.max(1, Math.min(4, far, data.length - 1 - far));
    const t = normalizeV([data[far + r][0] - data[far - r][0], data[far + r][1] - data[far - r][1]]);
    fitSpan(data.slice(0, far + 1), err, out, tA, [-t[0], -t[1]]);
    fitSpan(data.slice(far), err, out, t, tB);
    return;
  }
  // Straight if every point is within the error of the chord.
  // Signed deviation d from the chord as a function of position s (0..1)
  // along it, fitted with d ~ a + b*s + c*s*(1-s). The bow term c measures a
  // real bulge (sagitta c/4); offset/tilt and pixel noise don't contribute.
  let maxDev = 0;
  const M = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const R = [0, 0, 0];
  for (let i = 1; i < data.length - 1; i++) {
    const rx = data[i][0] - A[0], ry = data[i][1] - A[1];
    const d = (rx * (B[1] - A[1]) - ry * (B[0] - A[0])) / chord;
    const t = (rx * (B[0] - A[0]) + ry * (B[1] - A[1])) / (chord * chord);
    if (Math.abs(d) > maxDev) maxDev = Math.abs(d);
    const f = [1, t, t * (1 - t)];
    for (let r = 0; r < 3; r++) {
      R[r] += f[r] * d;
      for (let c = 0; c < 3; c++) M[r * 3 + c] += f[r] * f[c];
    }
  }
  const sag = Math.abs(solve3(M, R)[2]) / 4;
  // Pixel staircases ripple by up to about half a pixel around a straight edge,
  // so anything within that of the chord is a straight line.
  // A noisy straight edge scatters around its chord (mean ~0); a curve bulges
  // to one side, so it is only straightened if it is within the fit error.
  if (maxDev <= err || (maxDev <= STRAIGHT_PX && sag <= STRAIGHT_SAG_PX)) return straight();
  // End tangents from the data a few pixels into the span, past the pixel
  // rounding right at the corner.
  const reachLen = Math.min(5, chord * 0.3);
  const dirFrom = (from: [number, number], pts: [number, number][]): [number, number] => {
    for (const p of pts) if (Math.hypot(p[0] - from[0], p[1] - from[1]) >= reachLen) return normalizeV([p[0] - from[0], p[1] - from[1]]);
    return normalizeV([pts[pts.length - 1][0] - from[0], pts[pts.length - 1][1] - from[1]]);
  };
  const t1 = tA ?? dirFrom(A, data.slice(1));
  const t2 = tB ?? dirFrom(B, data.slice(0, -1).reverse());
  fitCubics(data, t1, t2, err, out);
}

/** Reverse a segment chain (same curve, opposite direction). */
export function reverseSegments(seg: Float64Array): Float64Array {
  const m = (seg.length - 2) / 6;
  const out = new Float64Array(seg.length);
  const last = seg.length - 2;
  out[0] = seg[last];
  out[1] = seg[last + 1];
  for (let s = 0; s < m; s++) {
    const src = 2 + (m - 1 - s) * 6; // original segment, traversed backwards
    const startX = src === 2 ? seg[0] : seg[src - 2];
    const startY = src === 2 ? seg[1] : seg[src - 1];
    const o = 2 + s * 6;
    out[o] = seg[src + 2];
    out[o + 1] = seg[src + 3];
    out[o + 2] = seg[src];
    out[o + 3] = seg[src + 1];
    out[o + 4] = startX;
    out[o + 5] = startY;
  }
  return out;
}

// ------------------------------------------------------- loop assembly ----

/**
 * A closed loop as parallel arrays: anchors P[i] and the two control points
 * of the segment from P[i] to P[i+1] (wrapping).
 */
export interface Loop {
  px: Float64Array;
  py: Float64Array;
  c1x: Float64Array;
  c1y: Float64Array;
  c2x: Float64Array;
  c2y: Float64Array;
}

interface Oriented {
  edge: Edge;
  forward: boolean;
}

function orientedSeg(o: Oriented): Float64Array {
  return o.forward ? o.edge.seg : reverseSegments(o.edge.seg);
}

/**
 * Outline loops of the union of all pixels whose label is in `inSet`. Loops
 * keep the region on their left (screen coordinates); holes therefore run in
 * the opposite rotational direction to outer boundaries, so the result renders
 * correctly with fill-rule nonzero (and evenodd).
 */
export function regionLoops(graph: EdgeGraph, inSet: (label: number) => boolean): Loop[] {
  const loops: Loop[] = [];
  const open: Oriented[] = [];
  for (const e of graph.edges) {
    const a = inSet(e.left), b = inSet(e.right);
    if (a === b) continue;
    const o: Oriented = { edge: e, forward: a };
    if (e.closed) loops.push(chainToLoop([orientedSeg(o)]));
    else open.push(o);
  }
  const startV = (o: Oriented): number => (o.forward ? o.edge.v0 : o.edge.v1);
  const endV = (o: Oriented): number => (o.forward ? o.edge.v1 : o.edge.v0);
  const dirIn = (o: Oriented): [number, number] => (o.forward ? o.edge.d1 : [-o.edge.d0[0], -o.edge.d0[1]]);
  const dirOut = (o: Oriented): [number, number] => (o.forward ? o.edge.d0 : [-o.edge.d1[0], -o.edge.d1[1]]);
  const byStart = new Map<number, number[]>();
  open.forEach((o, i) => {
    const v = startV(o);
    const list = byStart.get(v);
    if (list) list.push(i);
    else byStart.set(v, [i]);
  });
  const used = new Uint8Array(open.length);
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    const chain: Float64Array[] = [];
    let cur = i;
    for (;;) {
      used[cur] = 1;
      chain.push(orientedSeg(open[cur]));
      const v = endV(open[cur]);
      const cands = (byStart.get(v) ?? []).filter((j) => !used[j] || j === i);
      if (cands.length === 0 || (cands.includes(i) && cands.length === 1)) break;
      let next = cands[0];
      if (cands.length > 1) {
        // Saddle: prefer the sharpest turn toward the region (left), which
        // keeps diagonally-touching pixels as separate pieces (4-connectivity).
        const [dx, dy] = dirIn(open[cur]);
        const rank = (j: number): number => {
          const [ox, oy] = dirOut(open[j]);
          if (ox === dy && oy === -dx) return 0; // left turn
          if (ox === dx && oy === dy) return 1; // straight
          return 2; // right turn
        };
        next = cands.slice().sort((p, q) => rank(p) - rank(q))[0];
      }
      if (next === i) break;
      cur = next;
    }
    loops.push(chainToLoop(chain));
  }
  return loops;
}

function chainToLoop(chain: Float64Array[]): Loop {
  const px: number[] = [], py: number[] = [], c1x: number[] = [], c1y: number[] = [], c2x: number[] = [], c2y: number[] = [];
  for (const seg of chain) {
    let x = seg[0], y = seg[1];
    for (let o = 2; o < seg.length; o += 6) {
      px.push(x);
      py.push(y);
      c1x.push(seg[o]);
      c1y.push(seg[o + 1]);
      c2x.push(seg[o + 2]);
      c2y.push(seg[o + 3]);
      x = seg[o + 4];
      y = seg[o + 5];
    }
  }
  return {
    px: Float64Array.from(px),
    py: Float64Array.from(py),
    c1x: Float64Array.from(c1x),
    c1y: Float64Array.from(c1y),
    c2x: Float64Array.from(c2x),
    c2y: Float64Array.from(c2y),
  };
}

/** Split cubics (de Casteljau, at t = 0.5) until none turns more than `maxTurnDeg`. */
export function refineLoop(loop: Loop, maxTurnDeg: number): Loop {
  const cosMax = Math.cos((maxTurnDeg * Math.PI) / 180);
  const out = { px: [] as number[], py: [] as number[], c1x: [] as number[], c1y: [] as number[], c2x: [] as number[], c2y: [] as number[] };
  const turnOk = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): boolean => {
    // Angle between the start and end tangents of the cubic.
    let ax = x1 - x0, ay = y1 - y0;
    if (Math.hypot(ax, ay) < 1e-9) (ax = x2 - x0), (ay = y2 - y0);
    let bx = x3 - x2, by = y3 - y2;
    if (Math.hypot(bx, by) < 1e-9) (bx = x3 - x1), (by = y3 - y1);
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    return la < 1e-9 || lb < 1e-9 || (ax * bx + ay * by) / (la * lb) >= cosMax;
  };
  const push = (c: number[], depth: number): void => {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = c;
    if (depth >= 6 || turnOk(x0, y0, x1, y1, x2, y2, x3, y3)) {
      out.px.push(x0);
      out.py.push(y0);
      out.c1x.push(x1);
      out.c1y.push(y1);
      out.c2x.push(x2);
      out.c2y.push(y2);
      return;
    }
    const mx01 = (x0 + x1) / 2, my01 = (y0 + y1) / 2, mx12 = (x1 + x2) / 2, my12 = (y1 + y2) / 2, mx23 = (x2 + x3) / 2, my23 = (y2 + y3) / 2;
    const ax = (mx01 + mx12) / 2, ay = (my01 + my12) / 2, bx = (mx12 + mx23) / 2, by = (my12 + my23) / 2;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    push([x0, y0, mx01, my01, ax, ay, mx, my], depth + 1);
    push([mx, my, bx, by, mx23, my23, x3, y3], depth + 1);
  };
  const n = loop.px.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    push([loop.px[i], loop.py[i], loop.c1x[i], loop.c1y[i], loop.c2x[i], loop.c2y[i], loop.px[j], loop.py[j]], 0);
  }
  return {
    px: Float64Array.from(out.px),
    py: Float64Array.from(out.py),
    c1x: Float64Array.from(out.c1x),
    c1y: Float64Array.from(out.c1y),
    c2x: Float64Array.from(out.c2x),
    c2y: Float64Array.from(out.c2y),
  };
}

/**
 * Grow a loop outward (to the right of travel) by `d` pixels. Each anchor
 * moves along its miter normal and drags its adjacent control points along,
 * which approximates a true offset curve well for small distances.
 */
export function offsetLoop(loopIn: Loop, d: number): Loop {
  // Moving anchors and handles only approximates an offset curve well when
  // each cubic bends gently, so split strongly bending cubics first.
  const loop = d === 0 ? loopIn : refineLoop(loopIn, 30);
  const n = loop.px.length;
  const out: Loop = {
    px: loop.px.slice(),
    py: loop.py.slice(),
    c1x: loop.c1x.slice(),
    c1y: loop.c1y.slice(),
    c2x: loop.c2x.slice(),
    c2y: loop.c2y.slice(),
  };
  if (d === 0 || n === 0) return out;
  const unit = (x: number, y: number): [number, number] => {
    const l = Math.hypot(x, y);
    return l > 1e-12 ? [x / l, y / l] : [0, 0];
  };
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const next = (i + 1) % n;
    const ax = loop.px[i], ay = loop.py[i];
    // Incoming tangent (from previous segment's 2nd control point, or anchor).
    let [ix, iy] = unit(ax - loop.c2x[prev], ay - loop.c2y[prev]);
    if (ix === 0 && iy === 0) [ix, iy] = unit(ax - loop.px[prev], ay - loop.py[prev]);
    let [ox, oy] = unit(loop.c1x[i] - ax, loop.c1y[i] - ay);
    if (ox === 0 && oy === 0) [ox, oy] = unit(loop.px[next] - ax, loop.py[next] - ay);
    // Right-hand normals (outward, region is on the left).
    const n1x = -iy, n1y = ix, n2x = -oy, n2y = ox;
    let [mx, my] = unit(n1x + n2x, n1y + n2y);
    if (mx === 0 && my === 0) [mx, my] = [n1x, n1y];
    const cos = Math.max(mx * n1x + my * n1y, 0.35); // miter limit
    const sx = (mx * d) / cos, sy = (my * d) / cos;
    out.px[i] += sx;
    out.py[i] += sy;
    out.c1x[i] += sx;
    out.c1y[i] += sy;
    out.c2x[prev] += sx;
    out.c2y[prev] += sy;
  }
  return out;
}

const fmt = (v: number): string => {
  const s = v.toFixed(3);
  return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
};

/** SVG path data for loops, scaled by `scale`. */
export function loopsToPathData(loops: Loop[], scale: number, curves: boolean): string {
  const parts: string[] = [];
  for (const lp of loops) {
    const n = lp.px.length;
    if (n === 0) continue;
    let s = `M${fmt(lp.px[0] * scale)} ${fmt(lp.py[0] * scale)}`;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = fmt(lp.px[j] * scale), ey = fmt(lp.py[j] * scale);
      if (j === 0 && !curves) break; // Z closes the last straight segment
      const straight =
        lp.c1x[i] === lp.px[i] && lp.c1y[i] === lp.py[i] && lp.c2x[i] === lp.px[j] && lp.c2y[i] === lp.py[j];
      if (!curves || straight) {
        if (j !== 0) s += `L${ex} ${ey}`;
      } else {
        s += `C${fmt(lp.c1x[i] * scale)} ${fmt(lp.c1y[i] * scale)} ${fmt(lp.c2x[i] * scale)} ${fmt(lp.c2y[i] * scale)} ${ex} ${ey}`;
      }
    }
    parts.push(s + 'Z');
  }
  return parts.join('');
}

/** Signed area enclosed by a loop, including its curves (flattened). */
export function loopArea(loop: Loop): number {
  let a = 0;
  const n = loop.px.length;
  const STEPS = 16;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let px = loop.px[i], py = loop.py[i];
    for (let s = 1; s <= STEPS; s++) {
      const t = s / STEPS, u = 1 - t;
      const x = u * u * u * loop.px[i] + 3 * u * u * t * loop.c1x[i] + 3 * u * t * t * loop.c2x[i] + t * t * t * loop.px[j];
      const y = u * u * u * loop.py[i] + 3 * u * u * t * loop.c1y[i] + 3 * u * t * t * loop.c2y[i] + t * t * t * loop.py[j];
      a += px * y - x * py;
      px = x;
      py = y;
    }
  }
  return a / 2;
}
