import { loopsToPathData, offsetLoop, regionLoops, type EdgeGraph, type Loop } from './trace';

export type ExportMode = 'stacked' | 'cutout';

export interface LayerOptions {
  mode: ExportMode;
  /** Palette entry indices, bottom of the stack first. */
  stack: number[];
  /** Cutout bleed in pixels (ignored for stacked). */
  bleedPx: number;
}

/**
 * Labels that make up each layer of the stack (same order as `stack`).
 *
 * - cutout: each layer is exactly its own color's region.
 * - stacked: each layer is its own region plus the regions of every color
 *   stacked on top of it, i.e. each layer continues underneath the layers
 *   above it. The bottom layer is the full silhouette, and painting the layers
 *   bottom-to-top reproduces the flattened image.
 */
export function layerLabelSets(mode: ExportMode, stack: number[]): Set<number>[] {
  return stack.map((label, i) => new Set(mode === 'cutout' ? [label] : stack.slice(i)));
}

export function buildLayerLoops(graph: EdgeGraph, opts: LayerOptions): Loop[][] {
  return layerLabelSets(opts.mode, opts.stack).map((set) => {
    const loops = regionLoops(graph, (l) => set.has(l));
    return opts.mode === 'cutout' && opts.bleedPx > 0 ? loops.map((lp) => offsetLoop(lp, opts.bleedPx)) : loops;
  });
}

export function buildLayerPaths(graph: EdgeGraph, opts: LayerOptions, scale: number): string[] {
  return buildLayerLoops(graph, opts).map((loops) => loopsToPathData(loops, scale, graph.curves));
}

export interface SvgLayer {
  /** 1-based position in the stack (1 = bottom). */
  index: number;
  /** #RRGGBB */
  color: string;
  d: string;
}

export interface SvgDocOptions {
  widthMm: number;
  heightMm: number;
  layers: SvgLayer[];
  /** Optional background rectangle color. */
  background?: string | null;
  title?: string;
}

const num = (v: number): string => String(Math.round(v * 1000) / 1000);
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function layerId(layer: SvgLayer): string {
  return `color-${layer.index}-${layer.color.toUpperCase()}`;
}

/**
 * A complete SVG document in real-world units: width/height in mm and a
 * matching viewBox (1 user unit = 1 mm), so it imports at the correct scale.
 */
export function svgDocument(opts: SvgDocOptions): string {
  const w = num(opts.widthMm);
  const h = num(opts.heightMm);
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ` +
      `width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
  ];
  if (opts.title) out.push(`<title>${esc(opts.title)}</title>`);
  if (opts.background) {
    out.push(`<rect id="background" x="0" y="0" width="${w}" height="${h}" fill="${opts.background.toUpperCase()}"/>`);
  }
  for (const layer of opts.layers) {
    const color = layer.color.toUpperCase();
    out.push(
      `<g id="${layerId(layer)}" inkscape:groupmode="layer" inkscape:label="${layer.index} ${color}" fill="${color}" stroke="none">`,
    );
    if (layer.d) out.push(`<path fill-rule="nonzero" d="${layer.d}"/>`);
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n') + '\n';
}
