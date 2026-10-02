import { emptyMesh, extrudePolygons, loopsToPolygons, weldMesh, type Mesh } from './mesh';
import { buildLayerLoops, type ExportMode } from './svg';
import type { ThreeMfPart } from './threemf';
import { regionLoops, type EdgeGraph } from './trace';

export interface HeightOptions {
  /** Thickness of the bottom layer in stacked mode (mm). */
  baseMm: number;
  /** Extra thickness for each further layer in stacked mode (mm). */
  stepMm: number;
  /** Thickness of every color part in cutout mode (mm). */
  cutoutMm: number;
}

/**
 * Z range [bottom, top] of each color layer (stack order, bottom first),
 * measured from the face of the image layers (before any backing offset).
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

export type Orientation = 'up' | 'down';

export interface Model3dOptions extends HeightOptions {
  mode: ExportMode;
  /** Palette entry indices, bottom first. */
  stack: number[];
  /** Output color per stack position (#RRGGBB). */
  colors: string[];
  /** Part name per stack position. */
  names: string[];
  mmPerPx: number;
  /**
   * 'up': image on top, as seen from above. 'down': the model is turned over
   * (rotated 180° about the Y axis) so the image face lies flat on the build
   * plate; this needs a flat face, so it is only allowed for cutout mode.
   */
  orientation?: Orientation;
  /** Solid backing behind the image (silhouette of all colors); 0 = none. */
  backingMm?: number;
  /** #RRGGBB of the backing part. */
  backingColor?: string;
}

export function canFaceDown(mode: ExportMode): boolean {
  return mode === 'cutout';
}

/** Total model thickness in mm. */
export function modelThickness(o: Pick<Model3dOptions, 'mode' | 'baseMm' | 'stepMm' | 'cutoutMm' | 'backingMm'>, count: number): number {
  const z = layerZRanges(o.mode, count, o);
  return (count ? z[count - 1][1] : 0) + (o.backingMm ?? 0);
}

function translateZ(mesh: Mesh, dz: number): void {
  for (let i = 2; i < mesh.positions.length; i += 3) mesh.positions[i] += dz;
}

/** Rotate 180° about the Y axis within [0, width] × [0, height]. */
function turnOver(mesh: Mesh, width: number, height: number): void {
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = width - p[i];
    p[i + 2] = height - p[i + 2];
  }
}

/**
 * One extruded part per stack position (plus an optional backing part),
 * in mm with y up.
 */
export function buildParts(graph: EdgeGraph, opts: Model3dOptions): ThreeMfPart[] {
  const layers = buildLayerLoops(graph, { mode: opts.mode, stack: opts.stack, bleedPx: 0 });
  const z = layerZRanges(opts.mode, opts.stack.length, opts);
  const backing = Math.max(0, opts.backingMm ?? 0);
  const faceDown = opts.orientation === 'down' && canFaceDown(opts.mode);

  const parts: ThreeMfPart[] = layers.map((loops, i) => {
    const mesh = emptyMesh();
    extrudePolygons(mesh, loopsToPolygons(loops, opts.mmPerPx, graph.height), z[i][0], z[i][1]);
    // Built face up: the backing goes underneath and the image sits on top.
    // Face-down models are turned over at the end, putting the image on the plate.
    if (backing > 0) translateZ(mesh, backing);
    return { name: opts.names[i], color: opts.colors[i], mesh };
  });

  if (backing > 0 && opts.stack.length > 0) {
    const inSet = new Set(opts.stack);
    const silhouette = regionLoops(graph, (l) => inSet.has(l));
    const mesh = emptyMesh();
    extrudePolygons(mesh, loopsToPolygons(silhouette, opts.mmPerPx, graph.height), 0, backing);
    const color = (opts.backingColor ?? '#FFFFFF').toUpperCase();
    // Backing first: it is the bottom part when face up.
    parts.unshift({ name: `Backing ${color}`, color, mesh });
  }

  if (faceDown) {
    const width = graph.width * opts.mmPerPx;
    const total = modelThickness(opts, opts.stack.length);
    for (const p of parts) turnOver(p.mesh, width, total);
  }
  // Weld duplicate vertices so every part is a closed, watertight surface.
  return parts.map((p) => ({ ...p, mesh: weldMesh(p.mesh) }));
}
