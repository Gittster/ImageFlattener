import { describe, expect, it } from 'vitest';
import { emptyMesh, extrudePolygons, groupPolygons, meshVolume, type Mesh } from '../src/core/mesh';
import { buildParts, layerZRanges } from '../src/core/model3d';
import { buildThreeMf } from '../src/core/threemf';
import { traceEdges } from '../src/core/trace';
import { VOID, type LabelMap } from '../src/core/types';

/** Every directed edge must appear exactly once and its reverse exactly once. */
function isClosedManifold(mesh: Mesh): boolean {
  const edges = new Map<string, number>();
  const t = mesh.triangles;
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const key = `${t[i + k]},${t[i + ((k + 1) % 3)]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split(',');
    if (count !== 1 || edges.get(`${b},${a}`) !== 1) return false;
  }
  return true;
}

function scene(): LabelMap {
  // Background 0 with a ring of 1 (has a hole filled by 2) and a block of 3
  // containing a transparent hole.
  const w = 60, h = 40;
  const labels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d2 = (x - 18) ** 2 + (y - 20) ** 2;
      let l = 0;
      if (d2 < 13 ** 2) l = 1;
      if (d2 < 6 ** 2) l = 2;
      if (x >= 36 && x < 56 && y >= 6 && y < 34) l = 3;
      if (x >= 42 && x < 50 && y >= 14 && y < 26) l = VOID;
      labels[y * w + x] = l;
    }
  return { width: w, height: h, labels };
}

describe('extrusion', () => {
  it('extrudes a square with a hole into a closed, outward-facing solid', () => {
    const mesh = emptyMesh();
    const outer = [0, 0, 10, 0, 10, 10, 0, 10];
    const hole = [3, 3, 3, 7, 7, 7, 7, 3];
    extrudePolygons(mesh, groupPolygons([outer, hole]), 0, 2);
    expect(isClosedManifold(mesh)).toBe(true);
    expect(meshVolume(mesh)).toBeCloseTo((100 - 16) * 2, 6);
  });

  it('accepts either input orientation', () => {
    const mesh = emptyMesh();
    extrudePolygons(mesh, groupPolygons([[0, 0, 0, 5, 5, 5, 5, 0]]), 1, 3);
    expect(meshVolume(mesh)).toBeCloseTo(50, 6);
  });
});

describe('3D layers', () => {
  const m = scene();
  const graph = traceEdges(m, { tolerance: 1, curves: true });
  const base = { baseMm: 0.6, stepMm: 0.4, cutoutMm: 1.5, mmPerPx: 0.5 };

  it('computes HueForge-style height bands for stacked mode', () => {
    expect(layerZRanges('stacked', 3, base)).toEqual([[0, 0.6], [0.6, 1], [1, 1.4]].map(([a, b]) => [a, expect.closeTo(b, 9)]));
    expect(layerZRanges('cutout', 2, base)).toEqual([[0, 1.5], [0, 1.5]]);
  });

  for (const mode of ['stacked', 'cutout'] as const) {
    it(`${mode}: every part is a closed solid with positive volume`, () => {
      const parts = buildParts(graph, { ...base, mode, stack: [0, 1, 2, 3], colors: ['#111111', '#222222', '#333333', '#444444'], names: ['a', 'b', 'c', 'd'] });
      expect(parts).toHaveLength(4);
      for (const p of parts) {
        expect(isClosedManifold(p.mesh)).toBe(true);
        expect(meshVolume(p.mesh)).toBeGreaterThan(0);
      }
    });
  }

  it('cutout part volumes add up to the opaque image area times thickness', () => {
    const parts = buildParts(graph, { ...base, mode: 'cutout', stack: [0, 1, 2, 3], colors: ['#000000', '#000000', '#000000', '#000000'], names: ['', '', '', ''] });
    const opaque = m.labels.filter((l) => l !== VOID).length;
    const total = parts.reduce((s, p) => s + meshVolume(p.mesh), 0);
    expect(total).toBeCloseTo(opaque * 0.25 * 1.5, 0); // 0.25 mm² per pixel
  });

  it('stacked bands do not overlap in Z', () => {
    const parts = buildParts(graph, { ...base, mode: 'stacked', stack: [0, 1, 2, 3], colors: ['#000000', '#000000', '#000000', '#000000'], names: ['', '', '', ''] });
    const z = parts.map((p) => {
      const zs = p.mesh.positions.filter((_, i) => i % 3 === 2);
      return [Math.min(...zs), Math.max(...zs)];
    });
    for (let i = 1; i < z.length; i++) expect(z[i][0]).toBeCloseTo(z[i - 1][1], 9);
  });
});

describe('orientation and backing', () => {
  // Color 0 on the left half, color 1 on the right half, transparent corner.
  const w = 20, h = 10;
  const labels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) labels[y * w + x] = x < 10 ? 0 : 1;
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) labels[y * w + x] = VOID; // transparent 3x3 corner
  const graph = traceEdges({ width: w, height: h, labels }, { tolerance: 0.5, curves: false });
  const opts = { baseMm: 0.6, stepMm: 0.3, cutoutMm: 1, mmPerPx: 1, stack: [0, 1], colors: ['#000000', '#FFFFFF'], names: ['a', 'b'] };
  const bounds = (m: Mesh): { x: [number, number]; z: [number, number] } => {
    const xs = m.positions.filter((_, i) => i % 3 === 0);
    const zs = m.positions.filter((_, i) => i % 3 === 2);
    return { x: [Math.min(...xs), Math.max(...xs)], z: [Math.min(...zs), Math.max(...zs)] };
  };

  it('face up with backing: backing on the plate, image on top', () => {
    const parts = buildParts(graph, { ...opts, mode: 'cutout', backingMm: 0.5, backingColor: '#ff0000' });
    expect(parts.map((p) => p.name)).toEqual(['Backing #FF0000', 'a', 'b']);
    expect(bounds(parts[0].mesh).z).toEqual([0, 0.5]);
    expect(bounds(parts[1].mesh).z).toEqual([0.5, 1.5]);
    // The backing covers the whole silhouette (both colors), minus the transparent corner.
    expect(meshVolume(parts[0].mesh)).toBeCloseTo((w * h - 9) * 0.5, 6);
    for (const p of parts) expect(isClosedManifold(p.mesh) && meshVolume(p.mesh) > 0).toBe(true);
  });

  it('face down: image flat on the plate, mirrored, backing on top', () => {
    const parts = buildParts(graph, { ...opts, mode: 'cutout', orientation: 'down', backingMm: 0.5 });
    const [backing, left, right] = parts.map((p) => bounds(p.mesh));
    expect(left.z).toEqual([0, 1]);
    expect(right.z).toEqual([0, 1]);
    expect(backing.z).toEqual([1, 1.5]);
    // Color 0 (left half of the image) ends up on the right after turning over.
    expect(left.x[0]).toBeCloseTo(10, 6);
    expect(right.x[1]).toBeCloseTo(10, 6);
    // Rotation, not a mirror: meshes stay outward-facing.
    for (const p of parts) expect(isClosedManifold(p.mesh) && meshVolume(p.mesh) > 0).toBe(true);
  });

  it('ignores face down for stacked mode (its top is not flat)', () => {
    const up = buildParts(graph, { ...opts, mode: 'stacked' });
    const down = buildParts(graph, { ...opts, mode: 'stacked', orientation: 'down' });
    expect(down.map((p) => p.mesh.positions)).toEqual(up.map((p) => p.mesh.positions));
  });
});

describe('3MF package', () => {
  it('declares a color group and one colored part per layer inside a single object', () => {
    const square = emptyMesh();
    extrudePolygons(square, groupPolygons([[0, 0, 10, 0, 10, 10, 0, 10]]), 0, 1);
    const files = buildThreeMf({
      objectName: 'test & co',
      parts: [
        { name: '1 #112233', color: '#112233', mesh: square },
        { name: '2 #AABBCC', color: '#aabbcc', mesh: square },
      ],
    });
    const model = files['3D/3dmodel.model'];
    expect(model).toContain('xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"');
    expect(model).toContain('<m:colorgroup id="1">');
    expect(model).toContain('<m:color color="#112233FF"/>');
    expect(model).toContain('<m:color color="#AABBCCFF"/>');
    expect(model).toContain('<object id="2" type="model" name="1 #112233" pid="1" pindex="0">');
    expect(model).toContain('<object id="3" type="model" name="2 #AABBCC" pid="1" pindex="1">');
    expect(model).toMatch(/<object id="4" type="model" name="test &amp; co">\s*<components>\s*<component objectid="2"\/>\s*<component objectid="3"\/>/);
    expect(model).toContain('<item objectid="4"');
    // Must not claim to be a Bambu Studio project (that would skip color import).
    expect(model).not.toContain('BambuStudio');
    expect(files['Metadata/model_settings.config']).toContain('<part id="3" subtype="normal_part">');
    expect(files['_rels/.rels']).toContain('/3D/3dmodel.model');
  });
});
