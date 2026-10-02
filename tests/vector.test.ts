import { describe, expect, it } from 'vitest';
import { buildLayerLoops, buildLayerPaths, layerLabelSets, svgDocument } from '../src/core/svg';
import { loopArea, regionLoops, traceEdges, type Loop } from '../src/core/trace';
import { VOID, type LabelMap } from '../src/core/types';
import { flattenLoop, inside } from './geometry';

/**
 * Test scene: background 0, a ring of 1 around a disc of 2, a rectangle of 3
 * with a transparent hole, and a checkerboard patch (diagonal-only contacts).
 */
function scene(): LabelMap {
  const w = 72, h = 48;
  const labels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d2 = (x - 20) ** 2 + (y - 22) ** 2;
      let l = 0;
      if (d2 < 15 ** 2) l = 1;
      if (d2 < 7 ** 2) l = 2;
      if (x >= 44 && x < 66 && y >= 6 && y < 40) l = 3;
      if (x >= 50 && x < 60 && y >= 16 && y < 28) l = VOID;
      if (x >= 36 && x < 42 && y >= 38 && y < 44 && (x + y) % 2 === 0) l = 2;
      labels[y * w + x] = l;
    }
  return { width: w, height: h, labels };
}

const STACK = [0, 1, 2, 3];

function polys(layers: Loop[][]): number[][][][] {
  return layers.map((loops) => loops.map((l) => flattenLoop(l, 6)));
}

/**
 * A fine grid of sample points at irrational offsets, so no point lies exactly
 * on a (shared) edge where an inside test would be ambiguous.
 */
function samplePoints(m: LabelMap, step = 0.3): [number, number][] {
  const pts: [number, number][] = [];
  for (let y = Math.SQRT2 / 10; y < m.height; y += step)
    for (let x = Math.PI / 30; x < m.width; x += step) pts.push([x, y]);
  return pts;
}

describe('vector layers', () => {
  const m = scene();
  for (const curves of [true, false]) {
    const graph = traceEdges(m, { tolerance: 1, curves });
    const label = (curves ? 'curves' : 'polylines') + ': ';

    it(label + 'cutout shapes do not overlap and leave no gaps', () => {
      const layers = polys(buildLayerLoops(graph, { mode: 'cutout', stack: STACK, bleedPx: 0 }));
      let overlaps = 0;
      let gaps = 0;
      for (const [x, y] of samplePoints(m)) {
        const n = layers.filter((p) => inside(p, x, y)).length;
        if (n > 1) overlaps++;
        // A point not covered by any layer must be in a transparent area (or
        // right at a simplified boundary next to one).
        if (n === 0 && m.labels[Math.floor(y) * m.width + Math.floor(x)] !== VOID) {
          const near = [-1, 0, 1].some((dy) =>
            [-1, 0, 1].some((dx) => {
              const xx = Math.floor(x) + dx, yy = Math.floor(y) + dy;
              return xx < 0 || yy < 0 || xx >= m.width || yy >= m.height || m.labels[yy * m.width + xx] === VOID;
            }),
          );
          if (!near) gaps++;
        }
      }
      expect(overlaps).toBe(0);
      expect(gaps).toBe(0);
    });

    it(label + 'stacked shapes overlap, and painting them bottom-up reproduces the image', () => {
      const layers = polys(buildLayerLoops(graph, { mode: 'stacked', stack: STACK, bleedPx: 0 }));
      let overlapping = 0;
      let wrong = 0;
      let checked = 0;
      for (let y = 0; y < m.height; y++)
        for (let x = 0; x < m.width; x++) {
          const l = m.labels[y * m.width + x];
          const cov = layers.map((p) => inside(p, x + 0.5013, y + 0.4987));
          if (cov.filter(Boolean).length > 1) overlapping++;
          // Only judge pixels whose 3x3 neighbourhood is uniform (simplification
          // may move boundaries by up to the tolerance).
          let uniform = true;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx, yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < m.width && yy < m.height && m.labels[yy * m.width + xx] !== l) uniform = false;
            }
          if (!uniform) continue;
          checked++;
          const top = cov.lastIndexOf(true);
          if (l === VOID ? top !== -1 : STACK[top] !== l) wrong++;
        }
      expect(overlapping).toBeGreaterThan(m.width * m.height * 0.3);
      expect(checked).toBeGreaterThan(1000);
      expect(wrong).toBe(0);
    });
  }

  it('stacked layer sets are cumulative toward the bottom', () => {
    expect(layerLabelSets('stacked', [2, 0, 1]).map((s) => [...s].sort())).toEqual([[0, 1, 2], [0, 1], [1]]);
    expect(layerLabelSets('cutout', [2, 0, 1]).map((s) => [...s])).toEqual([[2], [0], [1]]);
  });

  it('represents holes with opposite winding', () => {
    const graph = traceEdges(m, { tolerance: 1, curves: true });
    const loops = regionLoops(graph, (l) => l === 3);
    expect(loops).toHaveLength(2);
    const areas = loops.map(loopArea).sort((a, b) => Math.abs(b) - Math.abs(a));
    expect(Math.sign(areas[0])).toBe(-Math.sign(areas[1]));
    const p = loops.map((l) => flattenLoop(l));
    expect(inside(p, 46, 10)).toBe(true);
    expect(inside(p, 55, 22)).toBe(false); // in the hole
  });

  it('keeps diagonally touching pixels as separate pieces', () => {
    const cb: LabelMap = { width: 2, height: 2, labels: Uint8Array.from([1, 0, 0, 1]) };
    const graph = traceEdges(cb, { tolerance: 0.1, curves: false });
    expect(regionLoops(graph, (l) => l === 1)).toHaveLength(2);
    expect(regionLoops(graph, (l) => l === 0)).toHaveLength(2);
  });

  it('cutout bleed grows every shape into its neighbours', () => {
    const graph = traceEdges(m, { tolerance: 1, curves: true });
    const plain = buildLayerLoops(graph, { mode: 'cutout', stack: STACK, bleedPx: 0 });
    const bled = buildLayerLoops(graph, { mode: 'cutout', stack: STACK, bleedPx: 0.5 });
    const area = (loops: Loop[]): number => loops.reduce((s, l) => s + loopArea(l), 0);
    for (let i = 0; i < STACK.length; i++) expect(Math.abs(area(bled[i]))).toBeGreaterThan(Math.abs(area(plain[i])));
    // Adjacent shapes now overlap slightly along their shared border.
    const p = polys(bled);
    expect(inside(p[1], 20 + 7, 22) && inside(p[2], 20 + 7, 22)).toBe(true);
  });

  it('traces a 1-pixel image as an exact square', () => {
    const graph = traceEdges({ width: 1, height: 1, labels: Uint8Array.from([0]) }, { tolerance: 2, curves: true });
    expect(buildLayerPaths(graph, { mode: 'cutout', stack: [0], bleedPx: 0 }, 100)).toEqual(['M100 0L0 0L0 100L100 100Z']);
  });
});

describe('corner reconstruction', () => {
  it('keeps the points and inner corners of a pixelated star sharp', () => {
    const w = 200, h = 200;
    const cx = 100, cy = 104;
    const star: [number, number][] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 34 : 88, t = -Math.PI / 2 + (i * Math.PI) / 5;
      star.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
    const inStar = (x: number, y: number): boolean => {
      let c = false;
      for (let i = 0, j = star.length - 1; i < star.length; j = i++) {
        const [xi, yi] = star[i], [xj, yj] = star[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const labels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) labels[y * w + x] = inStar(x + 0.5, y + 0.5) ? 1 : 0;
    const graph = traceEdges({ width: w, height: h, labels }, { tolerance: 1, curves: true });
    const [loop] = regionLoops(graph, (l) => l === 1);
    const anchors = Array.from(loop.px, (x, i) => [x, loop.py[i]]);
    for (const [sx, sy] of star) {
      const nearest = Math.min(...anchors.map(([x, y]) => Math.hypot(x - sx, y - sy)));
      expect(nearest).toBeLessThan(1.5);
    }
  });
});

describe('curve accuracy', () => {
  // Rasterize an analytic shape, trace it, and measure how far the curves stray from the true edge.
  const trace = (inside: (x: number, y: number) => boolean, dist: (x: number, y: number) => number) => {
    const w = 200, h = 200;
    const labels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) labels[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
    const graph = traceEdges({ width: w, height: h, labels }, { tolerance: 1, curves: true });
    let max = 0, sum = 0, n = 0;
    for (const poly of regionLoops(graph, (l) => l === 1).map((l) => flattenLoop(l, 24))) {
      for (const [x, y] of poly) {
        const d = dist(x, y);
        max = Math.max(max, d);
        sum += d * d;
        n++;
      }
    }
    return { max, rms: Math.sqrt(sum / n) };
  };

  it.each([10, 46, 92])('a circle of radius %i px is traced within 0.35 px', (r) => {
    const c = r + 6;
    const e = trace((x, y) => (x - c) ** 2 + (y - c) ** 2 < r * r, (x, y) => Math.abs(Math.hypot(x - c, y - c) - r));
    expect(e.max).toBeLessThan(0.35);
    expect(e.rms).toBeLessThan(0.2);
  });

  it('an ellipse is traced within 0.35 px', () => {
    const f = (x: number, y: number): number => ((x - 70) / 60) ** 2 + ((y - 45) / 30) ** 2 - 1;
    const e = trace(
      (x, y) => f(x, y) < 0,
      (x, y) => Math.abs(f(x, y)) / Math.hypot((2 * (x - 70)) / 3600, (2 * (y - 45)) / 900),
    );
    expect(e.max).toBeLessThan(0.35);
    expect(e.rms).toBeLessThan(0.2);
  });

  it('a closed shape with a single corner (teardrop) keeps its outline', () => {
    // Convex hull of a circle (center C, radius r) and a tip T.
    const C = [100, 120], r = 40, T = [100, 20];
    const L = Math.hypot(C[0] - T[0], C[1] - T[1]);
    const a = Math.acos(r / L); // half-angle at C between CT and a tangent point
    const tangents = [-a, a].map((s) => [C[0] + r * Math.sin(s), C[1] - r * Math.cos(s)]);
    const cross = (o: number[], p: number[], q: number[]): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const inTri = (x: number, y: number): boolean =>
      cross(T, tangents[0], [x, y]) * cross(T, tangents[1], [x, y]) <= 0 && y >= T[1] && y <= tangents[0][1];
    const w = 200, h = 200;
    const labels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const px = x + 0.5, py = y + 0.5;
        labels[y * w + x] = Math.hypot(px - C[0], py - C[1]) < r || inTri(px, py) ? 1 : 0;
      }
    const loops = regionLoops(traceEdges({ width: w, height: h, labels }, { tolerance: 1, curves: true }), (l) => l === 1);
    expect(loops).toHaveLength(1);
    const exact = Math.PI * r * r - r * r * a + r * Math.sqrt(L * L - r * r);
    expect(Math.abs(loopArea(loops[0])) / exact).toBeCloseTo(1, 2);
    // The tip survives as an anchor.
    const tip = [...loops[0].px.keys()].some((i) => Math.hypot(loops[0].px[i] - T[0], loops[0].py[i] - T[1]) < 1.5);
    expect(tip).toBe(true);
  });
});

describe('SVG document', () => {
  it('uses mm units, a matching viewBox, and one group per color in stack order', () => {
    const svg = svgDocument({
      widthMm: 120,
      heightMm: 80,
      layers: [
        { index: 1, color: '#1d3557', d: 'M0 0L1 0L1 1Z' },
        { index: 2, color: '#E63946', d: 'M0 0L2 0L2 2Z' },
      ],
      background: '#ffffff',
    });
    expect(svg).toContain('width="120mm" height="80mm" viewBox="0 0 120 80"');
    expect(svg.indexOf('id="color-1-#1D3557"')).toBeLessThan(svg.indexOf('id="color-2-#E63946"'));
    expect(svg).toContain('fill="#1D3557"');
    expect(svg).toContain('<rect id="background"');
    expect(svg).not.toMatch(/stroke="(?!none)/);
  });
});
