/**
 * Least-squares cubic Bézier fitting of a point sequence with given end
 * tangents, splitting recursively where the error is too large.
 * After P. J. Schneider, "An Algorithm for Automatically Fitting Digitized
 * Curves", Graphics Gems (1990).
 */

type Pt = [number, number];

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, s: number): Pt => [a[0] * s, a[1] * s];
const dot = (a: Pt, b: Pt): number => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt): number => Math.hypot(a[0], a[1]);
export const normalize = (a: Pt): Pt => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0];
};

function bezierPoint(b: Pt[], t: number): Pt {
  const u = 1 - t;
  const a = u * u * u, c = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * b[0][0] + c * b[1][0] + d * b[2][0] + e * b[3][0], a * b[0][1] + c * b[1][1] + d * b[2][1] + e * b[3][1]];
}

/** Fit the points with one or more cubics; appends [c1x, c1y, c2x, c2y, x, y] per cubic to `out`. */
export function fitCubics(points: Pt[], tHat1: Pt, tHat2: Pt, error: number, out: number[]): void {
  if (points.length < 2) return;
  fit(points, 0, points.length - 1, normalize(tHat1), normalize(tHat2), error * error, out, 0);
}

function emit(out: number[], b: Pt[]): void {
  out.push(b[1][0], b[1][1], b[2][0], b[2][1], b[3][0], b[3][1]);
}

function fit(d: Pt[], first: number, last: number, t1: Pt, t2: Pt, err2: number, out: number[], depth: number): void {
  const p0 = d[first], p3 = d[last];
  const segLen = len(sub(p3, p0));
  if (last - first === 1 || segLen < 1e-9) {
    const dist = segLen / 3;
    emit(out, [p0, add(p0, mul(t1, dist)), add(p3, mul(t2, dist)), p3]);
    return;
  }
  let u = chordParams(d, first, last);
  let bez = generate(d, first, last, u, t1, t2);
  let [maxErr, split] = maxError(d, first, last, bez, u);
  if (maxErr < err2) return emit(out, bez);
  if (maxErr < err2 * 16) {
    for (let it = 0; it < 6; it++) {
      u = reparameterize(d, first, last, u, bez);
      bez = generate(d, first, last, u, t1, t2);
      [maxErr, split] = maxError(d, first, last, bez, u);
      if (maxErr < err2) return emit(out, bez);
    }
  }
  if (depth > 40) return emit(out, bez); // safety
  // Split at the worst point with a shared (G1-continuous) tangent.
  let center = normalize(sub(d[split - 1], d[split + 1]));
  if (center[0] === 0 && center[1] === 0) center = normalize(sub(d[split - 1], d[split]));
  fit(d, first, split, t1, center, err2, out, depth + 1);
  fit(d, split, last, mul(center, -1), t2, err2, out, depth + 1);
}

function chordParams(d: Pt[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + len(sub(d[i], d[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

/** Least-squares Bézier with fixed end points and end tangent directions. */
function generate(d: Pt[], first: number, last: number, u: number[], t1: Pt, t2: Pt): Pt[] {
  const p0 = d[first], p3 = d[last];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], s = 1 - t;
    const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    const a1 = mul(t1, b1), a2 = mul(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(d[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const segLen = len(sub(p3, p0));
  let alpha1 = 0, alpha2 = 0;
  if (Math.abs(det) > 1e-12) {
    alpha1 = (x0 * c11 - x1 * c01) / det;
    alpha2 = (c00 * x1 - c01 * x0) / det;
  }
  // Degenerate or wild solutions fall back to the classic heuristic.
  const eps = 1e-6 * segLen;
  if (!(alpha1 > eps && alpha2 > eps) || alpha1 > 3 * segLen || alpha2 > 3 * segLen) alpha1 = alpha2 = segLen / 3;
  return [p0, add(p0, mul(t1, alpha1)), add(p3, mul(t2, alpha2)), p3];
}

function maxError(d: Pt[], first: number, last: number, bez: Pt[], u: number[]): [number, number] {
  let max = 0;
  let split = Math.floor((first + last) / 2);
  for (let i = first + 1; i < last; i++) {
    const p = bezierPoint(bez, u[i - first]);
    const e = (p[0] - d[i][0]) ** 2 + (p[1] - d[i][1]) ** 2;
    if (e >= max) {
      max = e;
      split = i;
    }
  }
  return [max, split];
}

/** One Newton-Raphson step per point towards the closest point on the curve. */
function reparameterize(d: Pt[], first: number, _last: number, u: number[], b: Pt[]): number[] {
  const q1: Pt[] = [mul(sub(b[1], b[0]), 3), mul(sub(b[2], b[1]), 3), mul(sub(b[3], b[2]), 3)];
  const q2: Pt[] = [mul(sub(q1[1], q1[0]), 2), mul(sub(q1[2], q1[1]), 2)];
  return u.map((t, k) => {
    const p = d[first + k];
    const s = 1 - t;
    const q = bezierPoint(b, t);
    const d1: Pt = add(add(mul(q1[0], s * s), mul(q1[1], 2 * s * t)), mul(q1[2], t * t));
    const d2: Pt = add(mul(q2[0], s), mul(q2[1], t));
    const diff = sub(q, p);
    const num = dot(diff, d1);
    const den = dot(d1, d1) + dot(diff, d2);
    if (Math.abs(den) < 1e-12) return t;
    const nt = t - num / den;
    return Math.min(1, Math.max(0, nt));
  });
}
