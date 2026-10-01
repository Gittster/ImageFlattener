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
    const pts: number[] = [];
    if (!closed) pts.push(sx, sy);
    let vx = sx, vy = sy;
    for (let i = 0; i < n; i++) {
      const di = dirs[i];
      pts.push(vx + DX[di] * 0.5, vy + DY[di] * 0.5);
      vx += DX[di];
      vy += DY[di];
      const j = i + 1 < n ? i + 1 : closed ? 0 : -1;
      if (j >= 0 && dirs[j] !== di && ((run[i] >= 2 && run[j] >= 2) || isImageCorner(vx, vy))) pts.push(vx, vy);
    }
    if (!closed) pts.push(x, y);
    const lastD = dirs[n - 1];
    edges.push({
      left,
      right,
      closed,
      v0: closed ? -1 : sy * W1 + sx,
      v1: closed ? -1 : y * W1 + x,
      d0: [DX[sd], DY[sd]],
      d1: [DX[lastD], DY[lastD]],
      seg: buildSegments(pts, closed, opts.tolerance, opts.curves, cornerCos),
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

function simplifyClosed(pts: number[], tol: number): number[] {
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
 * Turn a point chain into cubic segments. Open chains keep their end points
 * fixed (they are shared junctions) and use one-sided tangents there.
 */
function buildSegments(pts: number[], closed: boolean, tol: number, curves: boolean, cornerCos: number): Float64Array {
  const p = closed ? simplifyClosed(pts, tol) : douglasPeucker(pts, tol);
  const n = p.length / 2;
  const segCount = closed ? n : n - 1;
  const out = new Float64Array(2 + segCount * 6);
  out[0] = p[0];
  out[1] = p[1];
  const X = (i: number): number => p[((i % n + n) % n) * 2];
  const Y = (i: number): number => p[((i % n + n) % n) * 2 + 1];
  // Unit tangent at vertex i (or null for a corner).
  const tangents: ([number, number] | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (!curves || (!closed && (i === 0 || i === n - 1))) {
      tangents.push(null);
      continue;
    }
    const ix = X(i) - X(i - 1), iy = Y(i) - Y(i - 1);
    const ox = X(i + 1) - X(i), oy = Y(i + 1) - Y(i);
    const il = Math.hypot(ix, iy), ol = Math.hypot(ox, oy);
    if (il === 0 || ol === 0 || (ix * ox + iy * oy) / (il * ol) < cornerCos) {
      tangents.push(null);
      continue;
    }
    const tx = ix / il + ox / ol, ty = iy / il + oy / ol;
    const tl = Math.hypot(tx, ty);
    tangents.push(tl === 0 ? null : [tx / tl, ty / tl]);
  }
  // Handle length at a vertex is limited by the shorter of its two segments,
  // so a smooth vertex next to a tiny segment can't bulge a long straight side.
  const segLen = (i: number): number => Math.hypot(X(i + 1) - X(i), Y(i + 1) - Y(i));
  for (let s = 0; s < segCount; s++) {
    const ax = X(s), ay = Y(s), bx = X(s + 1), by = Y(s + 1);
    const len = segLen(s);
    const ta = tangents[s];
    const tb = tangents[(s + 1) % n];
    const ha = ta ? Math.min(len, segLen(s - 1)) / 3 : 0;
    const hb = tb ? Math.min(len, segLen(s + 1)) / 3 : 0;
    const o = 2 + s * 6;
    out[o] = ta ? ax + ta[0] * ha : ax;
    out[o + 1] = ta ? ay + ta[1] * ha : ay;
    out[o + 2] = tb ? bx - tb[0] * hb : bx;
    out[o + 3] = tb ? by - tb[1] * hb : by;
    out[o + 4] = bx;
    out[o + 5] = by;
  }
  return out;
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

/**
 * Grow a loop outward (to the right of travel) by `d` pixels. Each anchor
 * moves along its miter normal and drags its adjacent control points along,
 * which approximates a true offset curve well for small distances.
 */
export function offsetLoop(loop: Loop, d: number): Loop {
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

/** Signed area of a loop's control polygon approximation (shoelace on anchors). */
export function loopArea(loop: Loop): number {
  let a = 0;
  const n = loop.px.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += loop.px[i] * loop.py[j] - loop.px[j] * loop.py[i];
  }
  return a / 2;
}
