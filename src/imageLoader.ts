import type { RasterImage } from './core/types';

/** Long-edge size of the working copy used for processing. */
export const WORKING_MAX = 1500;
/** Long-edge cap for the full-resolution PNG export. */
export const EXPORT_MAX = 8192;

export interface LoadedImage {
  name: string;
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

/** Decode an image blob and produce a downscaled RGBA working copy. */
export async function loadImage(blob: Blob, name: string): Promise<LoadedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error(`Could not decode "${name}" as an image.`);
  }
  const ow = bitmap.width;
  const oh = bitmap.height;
  if (ow < 1 || oh < 1) throw new Error('Image has no pixels.');
  const scale = Math.min(1, WORKING_MAX / Math.max(ow, oh));
  const w = Math.max(1, Math.round(ow * scale));
  const h = Math.max(1, Math.round(oh * scale));

  // Downscale in halving steps for better quality on very large images.
  let src: CanvasImageSource = bitmap;
  let sw = ow;
  let sh = oh;
  while (sw / 2 >= w * 1.0001 && sh / 2 >= h * 1.0001) {
    const nw = Math.max(w, Math.round(sw / 2));
    const nh = Math.max(h, Math.round(sh / 2));
    const step = makeCanvas(nw, nh);
    const sg = step.getContext('2d')!;
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(src, 0, 0, nw, nh);
    src = step;
    sw = nw;
    sh = nh;
  }
  const canvas = makeCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);
  bitmap.close();
  const data = g.getImageData(0, 0, w, h).data;
  return {
    name,
    url: URL.createObjectURL(blob),
    originalWidth: ow,
    originalHeight: oh,
    working: { width: w, height: h, data },
  };
}
