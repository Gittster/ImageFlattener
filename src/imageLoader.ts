import type { RasterImage } from './core/types';

/** Long-edge size of the working copy used for processing. */
export const WORKING_MAX = 1500;
/** Long-edge cap for the full-resolution PNG export. */
export const EXPORT_MAX = 8192;

export interface LoadedImage {
  name: string;
  /** The original file (kept for saving projects). */
  blob: Blob;
  /** Object URL of the original file, for display. */
  url: string;
  originalWidth: number;
  originalHeight: number;
  working: RasterImage;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Long edge (px) at which SVG files are rasterized; also their "original" size for PNG export. */
export const SVG_RASTER_SIZE = 3000;

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** Vector source: draw directly at the target size (it rasterizes crisply). */
  vector: boolean;
  close: () => void;
}

function reason(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err ?? '');
  return m && m !== '[object Event]' ? ` (${m})` : '';
}

/** Decode through an <img> element: works for SVG and for files createImageBitmap rejects. */
async function decodeWithImg(blob: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, vector: false, close: () => URL.revokeObjectURL(url) };
}

const UNIT_PX: Record<string, number> = { '': 1, px: 1, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pt: 96 / 72, pc: 16 };

function lengthPx(v: string | null): number | null {
  const m = v ? /^\s*([\d.]+(?:e[-+]?\d+)?)\s*(px|mm|cm|in|pt|pc)?\s*$/i.exec(v) : null;
  if (!m) return null;
  const n = parseFloat(m[1]) * UNIT_PX[(m[2] ?? '').toLowerCase()];
  return n > 0 && isFinite(n) ? n : null;
}

/**
 * SVGs often have no pixel size (only a viewBox, or sizes in mm/%), and
 * createImageBitmap can't decode them. Give the root an explicit pixel size
 * with the right aspect ratio, then rasterize it through an <img>.
 */
async function decodeSvg(blob: Blob): Promise<Decoded> {
  const text = await blob.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (doc.getElementsByTagName('parsererror').length || root.localName !== 'svg') throw new Error('not a valid SVG file');
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  const hasViewBox = vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0;
  const wpx = lengthPx(root.getAttribute('width'));
  const hpx = lengthPx(root.getAttribute('height'));
  let aw: number, ah: number;
  if (hasViewBox) [aw, ah] = [vb[2], vb[3]];
  else if (wpx && hpx) [aw, ah] = [wpx, hpx];
  else [aw, ah] = [300, 150]; // CSS default replaced-element size
  if (!hasViewBox) root.setAttribute('viewBox', `0 0 ${wpx ?? aw} ${hpx ?? ah}`);
  const scale = SVG_RASTER_SIZE / Math.max(aw, ah);
  const width = Math.max(1, Math.round(aw * scale));
  const height = Math.max(1, Math.round(ah * scale));
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.setAttribute('preserveAspectRatio', root.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet');
  const sized = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' });
  const d = await decodeWithImg(sized);
  return { ...d, width, height, vector: true };
}

async function decode(blob: Blob, name: string): Promise<Decoded> {
  const isSvg = blob.type === 'image/svg+xml' || /\.svgz?$/i.test(name);
  try {
    if (isSvg) return await decodeSvg(blob);
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, width: bmp.width, height: bmp.height, vector: false, close: () => bmp.close() };
    } catch {
      // Some files (e.g. very large or unusual PNGs) fail here but decode fine via <img>.
      return await decodeWithImg(blob);
    }
  } catch (err) {
    throw new Error(`Could not decode "${name}" as an image${reason(err)}. Supported: PNG, JPEG, WebP, GIF, BMP, AVIF and SVG.`);
  }
}

/** Decode an image blob and produce a downscaled RGBA working copy. */
export async function loadImage(blob: Blob, name: string): Promise<LoadedImage> {
  const img = await decode(blob, name);
  const ow = img.width;
  const oh = img.height;
  if (ow < 1 || oh < 1) {
    img.close();
    throw new Error(`"${name}" has no pixels.`);
  }
  const scale = Math.min(1, WORKING_MAX / Math.max(ow, oh));
  const w = Math.max(1, Math.round(ow * scale));
  const h = Math.max(1, Math.round(oh * scale));

  let src: CanvasImageSource = img.source;
  let sw = ow;
  let sh = oh;
  if (!img.vector) {
    // Downscale in halving steps for quality; the first step goes straight to
    // at most 4x the target so huge images never need a huge canvas.
    const first = Math.min(1, (4 * w) / sw);
    let nw = Math.max(w, Math.round(sw * first));
    let nh = Math.max(h, Math.round(sh * first));
    while (sw / 2 >= w * 1.0001 && sh / 2 >= h * 1.0001) {
      if (!(nw < sw)) {
        nw = Math.max(w, Math.round(sw / 2));
        nh = Math.max(h, Math.round(sh / 2));
      }
      const step = makeCanvas(nw, nh);
      const sg = step.getContext('2d')!;
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(src, 0, 0, nw, nh);
      src = step;
      sw = nw;
      sh = nh;
      nw = sw; // next iterations halve
    }
  }
  const canvas = makeCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  img.close();
  const data = g.getImageData(0, 0, w, h).data;
  return {
    name,
    blob,
    url: URL.createObjectURL(blob),
    originalWidth: ow,
    originalHeight: oh,
    working: { width: w, height: h, data },
  };
}
