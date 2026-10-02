import { emptyMesh, extrudePolygons, loopsToPolygons } from './mesh';
import { buildLayerLoops, type ExportMode } from './svg';
import type { ThreeMfPart } from './threemf';
import type { EdgeGraph } from './trace';

export interface HeightOptions {
  /** Thickness of the bottom layer in stacked mode (mm). */
  baseMm: number;
  /** Extra thickness for each further layer in stacked mode (mm). */
  stepMm: number;
  /** Thickness of every part in cutout mode (mm). */
  cutoutMm: number;
}

/**
 * Z range [bottom, top] of each layer (stack order, bottom first).
 *
 * - stacked: layer i occupies the band between the tops of layers i-1 and i,
 *   so parts never overlap and every color is visible from above where it
 *   is the topmost color (HueForge-style height bands).
 * - cutout: all parts are flush, from 0 to the cutout thickness.
 */
export function layerZRanges(mode: ExportMode, count: number, h: HeightOptions): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    if (mode === 'cutout') out.push([0, h.cutoutMm]);
    else out.push([i === 0 ? 0 : h.baseMm + (i - 1) * h.stepMm, h.baseMm + i * h.stepMm]);
  }
  return out;
}

export interface Model3dOptions extends HeightOptions {
  mode: ExportMode;
  /** Palette entry indices, bottom first. */
  stack: number[];
  /** Output color per stack position (#RRGGBB). */
  colors: string[];
  /** Part name per stack position. */
  names: string[];
  mmPerPx: number;
}

/** One extruded part per stack position, in mm with y up. */
export function buildParts(graph: EdgeGraph, opts: Model3dOptions): ThreeMfPart[] {
  const layers = buildLayerLoops(graph, { mode: opts.mode, stack: opts.stack, bleedPx: 0 });
  const z = layerZRanges(opts.mode, opts.stack.length, opts);
  return layers.map((loops, i) => {
    const mesh = emptyMesh();
    extrudePolygons(mesh, loopsToPolygons(loops, opts.mmPerPx, graph.height), z[i][0], z[i][1]);
    return { name: opts.names[i], color: opts.colors[i], mesh };
  });
}
