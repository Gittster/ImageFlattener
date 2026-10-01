import type { Loop } from '../src/core/trace';

/** Flatten a loop of cubic segments into a polygon. */
export function flattenLoop(lp: Loop, steps = 8): number[][] {
  const pts: number[][] = [];
  const n = lp.px.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = lp.px[i], y0 = lp.py[i], x3 = lp.px[j], y3 = lp.py[j];
    for (let s = 0; s < steps; s++) {
      const t = s / steps, u = 1 - t;
      pts.push([
        u * u * u * x0 + 3 * u * u * t * lp.c1x[i] + 3 * u * t * t * lp.c2x[i] + t * t * t * x3,
        u * u * u * y0 + 3 * u * u * t * lp.c1y[i] + 3 * u * t * t * lp.c2y[i] + t * t * t * y3,
      ]);
    }
  }
  return pts;
}

/** Winding number of point (x,y) with respect to a set of polygons. */
export function winding(polys: number[][][], x: number, y: number): number {
  let wn = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
      if (ay <= y) {
        if (by > y && cross > 0) wn++;
      } else if (by <= y && cross < 0) wn--;
    }
  }
  return wn;
}

/** True if the point is inside the shape (nonzero rule). */
export function inside(polys: number[][][], x: number, y: number): boolean {
  return winding(polys, x, y) !== 0;
}
