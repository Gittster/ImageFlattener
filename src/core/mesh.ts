import earcut from 'earcut';
import type { Loop } from './trace';

/** An indexed triangle mesh (positions in mm, 3 numbers per vertex). */
export interface Mesh {
  positions: number[];
  triangles: number[];
}

export function emptyMesh(): Mesh {
  return { positions: [], triangles: [] };
}

/**
 * Flatten a loop of cubic segments to a polygon (flat [x, y, ...]).
 * Curves are subdivided so each piece is at most `maxSegment` long (in the
 * loop's units); straight segments stay single.
 */
export function flattenLoop(lp: Loop, maxSegment: number): number[] {
  const out: number[] = [];
  const n = lp.px.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = lp.px[i], y0 = lp.py[i], x3 = lp.px[j], y3 = lp.py[j];
    const c1x = lp.c1x[i], c1y = lp.c1y[i], c2x = lp.c2x[i], c2y = lp.c2y[i];
    out.push(x0, y0);
    const straight = c1x === x0 && c1y === y0 && c2x === x3 && c2y === y3;
    if (straight) continue;
    // Control polygon length bounds the curve length.
    const len = Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x3 - c2x, y3 - c2y);
    const steps = Math.min(32, Math.max(1, Math.ceil(len / maxSegment)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      out.push(a * x0 + b * c1x + c * c2x + d * x3, a * y0 + b * c1y + c * c2y + d * y3);
    }
  }
  return dedupe(out);
}

/**
 * Remove points that lie on the straight line through their neighbours
 * (including zero-width spikes and repeated points).
 * Earcut skips such points when triangulating, so the caps would not share
 * edges with the side walls and the solid would not be closed.
 */
export function removeCollinear(p: number[]): number[] {
  let pts = p.slice();
  let changed = true;
  while (changed && pts.length >= 8) {
    changed = false;
    const n = pts.length / 2;
    const keep: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, c = (i + 1) % n;
      const ax = pts[i * 2] - pts[a * 2], ay = pts[i * 2 + 1] - pts[a * 2 + 1];
      const bx = pts[c * 2] - pts[i * 2], by = pts[c * 2 + 1] - pts[i * 2 + 1];
      const cross = ax * by - ay * bx;
      const scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
      // Collinear: either continuing straight on, or a zero-width spike that
      // goes out and comes straight back (no area either way). Also drops
      // repeated points (zero-length steps).
      if (Math.abs(cross) <= 1e-9 * scale) {
        changed = true;
        continue;
      }
      keep.push(pts[i * 2], pts[i * 2 + 1]);
    }
    if (keep.length < 6) break;
    pts = dedupe(keep);
  }
  return pts;
}

/** Drop consecutive duplicate points (including last == first). */
function dedupe(p: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.length; i += 2) {
    const k = out.length;
    if (k >= 2 && Math.abs(out[k - 2] - p[i]) < 1e-9 && Math.abs(out[k - 1] - p[i + 1]) < 1e-9) continue;
    out.push(p[i], p[i + 1]);
  }
  while (out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < 1e-9 && Math.abs(out[1] - out[out.length - 1]) < 1e-9) {
    out.length -= 2;
  }
  return out;
}

export function polygonArea(p: number[]): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return a / 2;
}

function reversePolygon(p: number[]): number[] {
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
}

function pointInPolygon(p: number[], x: number, y: number): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface PolygonWithHoles {
  /** Outer boundary, counter-clockwise (y up). */
  outer: number[];
  /** Holes, clockwise (y up). */
  holes: number[][];
}

/**
 * Group closed polygons into outer boundaries with their holes. Outer and
 * hole loops have opposite orientation (as produced by `regionLoops`); each
 * hole is attached to the smallest outer boundary that contains it.
 */
export function groupPolygons(polys: number[][]): PolygonWithHoles[] {
  const items = polys
    .filter((p) => p.length >= 6)
    .map((p) => ({ p, area: polygonArea(p) }))
    .filter((it) => Math.abs(it.area) > 1e-9);
  if (items.length === 0) return [];
  // The largest loop is always an outer boundary; outers share its orientation.
  const outerSign = Math.sign(items.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a)).area);
  const outers = items
    .filter((it) => Math.sign(it.area) === outerSign)
    .map((it) => ({ outer: it.area > 0 ? it.p : reversePolygon(it.p), area: Math.abs(it.area), holes: [] as number[][] }))
    .sort((a, b) => a.area - b.area);
  for (const it of items) {
    if (Math.sign(it.area) === outerSign) continue;
    const hole = it.area < 0 ? it.p : reversePolygon(it.p);
    // A hole's vertices lie inside its outer boundary; try a second point in
    // case the first one touches the outer boundary (diagonal pixel contact).
    const owner =
      outers.find((o) => o.area > Math.abs(it.area) && pointInPolygon(o.outer, hole[0], hole[1])) ??
      outers.find((o) => o.area > Math.abs(it.area) && pointInPolygon(o.outer, (hole[0] + hole[2]) / 2, (hole[1] + hole[3]) / 2));
    if (owner) owner.holes.push(hole);
  }
  return outers.map(({ outer, holes }) => ({ outer, holes }));
}

/**
 * Extrude polygons (with holes) into a closed mesh between z0 and z1,
 * appending to `mesh`. Triangles are wound so normals point outward.
 */
export function extrudePolygons(mesh: Mesh, polygons: PolygonWithHoles[], z0: number, z1: number): void {
  const pos = mesh.positions;
  const tri = mesh.triangles;
  for (const poly of polygons) {
    const rings = [poly.outer, ...poly.holes];
    const flat: number[] = [];
    const holeIndices: number[] = [];
    for (let r = 0; r < rings.length; r++) {
      if (r > 0) holeIndices.push(flat.length / 2);
      flat.push(...rings[r]);
    }
    const count = flat.length / 2;
    const bottom = pos.length / 3;
    for (let i = 0; i < count; i++) pos.push(flat[i * 2], flat[i * 2 + 1], z0);
    const top = pos.length / 3;
    for (let i = 0; i < count; i++) pos.push(flat[i * 2], flat[i * 2 + 1], z1);

    // Caps.
    const caps = earcut(flat, holeIndices, 2);
    for (let t = 0; t < caps.length; t += 3) {
      let a = caps[t], b = caps[t + 1], c = caps[t + 2];
      const cross =
        (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) -
        (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
      // Zero-area triangles (collinear points on a ring) are kept: dropping
      // them would leave unmatched edges and break the closed surface.
      if (cross < 0) [b, c] = [c, b]; // make counter-clockwise
      tri.push(top + a, top + b, top + c); // top faces up
      tri.push(bottom + a, bottom + c, bottom + b); // bottom faces down
    }

    // Walls: outer rings are CCW and holes CW, so the right-hand side of
    // every edge is outside the material.
    let start = 0;
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const a = start + i;
        const b = start + ((i + 1) % n);
        tri.push(bottom + a, bottom + b, top + b);
        tri.push(bottom + a, top + b, top + a);
      }
      start += n;
    }
  }
}

/**
 * Where outlines touch at a single point (pixels meeting only at a corner),
 * the same position occurs more than once. Move every such occurrence a
 * tenth of a micron towards its own neighbours so the outlines no longer
 * touch; otherwise the walls at that point would be shared by four faces.
 */
function separatePinches(rings: number[][]): void {
  const count = new Map<string, number>();
  for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    const k = `${r[i]},${r[i + 1]}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const EPS = 1e-4;
  for (const r of rings) {
    const n = r.length / 2;
    const moved: number[] = [];
    for (let i = 0; i < n; i++) {
      if ((count.get(`${r[i * 2]},${r[i * 2 + 1]}`) ?? 0) < 2) continue;
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const mx = (r[a * 2] + r[b * 2]) / 2 - r[i * 2], my = (r[a * 2 + 1] + r[b * 2 + 1]) / 2 - r[i * 2 + 1];
      const l = Math.hypot(mx, my);
      if (l > 1e-12) moved.push(i, (mx / l) * EPS, (my / l) * EPS);
    }
    for (let k = 0; k < moved.length; k += 3) {
      r[moved[k] * 2] += moved[k + 1];
      r[moved[k] * 2 + 1] += moved[k + 2];
    }
  }
}

/**
 * Nudge every point by a tiny, position-derived amount (about 10 nm).
 * Exactly collinear points on *different* rings (common along straight pixel
 * edges) make earcut emit T-junctions, which leave the surface unclosed.
 * Identical points get identical nudges, so shared points stay shared.
 */
function jitter(p: number[]): number[] {
  const out = p.slice();
  for (let i = 0; i < out.length; i += 2) {
    const h = hash2(out[i], out[i + 1]);
    out[i] += ((h & 0xffff) / 0xffff - 0.5) * 2e-5;
    out[i + 1] += ((h >>> 16) / 0xffff - 0.5) * 2e-5;
  }
  return out;
}

function hash2(x: number, y: number): number {
  let h = Math.imul(Math.round(x * 1e6) | 0, 0x9e3779b1) ^ Math.imul(Math.round(y * 1e6) | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * Merge vertices at identical positions and drop triangles that collapse.
 * Earcut merges coincident points (e.g. where two holes touch at a pixel
 * corner), so caps and walls may refer to different copies of the same point;
 * welding makes them share edges again, giving a closed surface.
 */
export function weldMesh(mesh: Mesh): Mesh {
  const index = new Map<string, number>();
  const remap: number[] = [];
  const positions: number[] = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const key = `${p[i]},${p[i + 1]},${p[i + 2]}`;
    let j = index.get(key);
    if (j === undefined) {
      j = positions.length / 3;
      index.set(key, j);
      positions.push(p[i], p[i + 1], p[i + 2]);
    }
    remap.push(j);
  }
  const triangles: number[] = [];
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const a = remap[t[i]], b = remap[t[i + 1]], c = remap[t[i + 2]];
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  return { positions, triangles };
}

/**
 * Convert loops in image pixels (y down) to polygons in mm with y up, so the
 * model is not mirrored when viewed from above.
 */
export function loopsToPolygons(loops: Loop[], mmPerPx: number, imageHeightPx: number, maxSegmentMm = 0.25): PolygonWithHoles[] {
  const polys = loops.map((lp) => {
    const p = flattenLoop(lp, maxSegmentMm / mmPerPx);
    for (let i = 0; i < p.length; i += 2) {
      p[i] = p[i] * mmPerPx;
      p[i + 1] = (imageHeightPx - p[i + 1]) * mmPerPx;
    }
    return removeCollinear(p);
  });
  separatePinches(polys);
  return groupPolygons(polys.map(jitter));
}

/** Signed volume of a closed mesh (positive when normals point outward). */
export function meshVolume(mesh: Mesh): number {
  const p = mesh.positions;
  const t = mesh.triangles;
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}
