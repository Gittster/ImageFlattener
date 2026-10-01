import type { RasterImage } from './types';

/**
 * Gaussian blur (separable) of the RGB channels, weighted by alpha so that
 * transparent pixels don't bleed color into their neighbours. Alpha itself is
 * left untouched so the transparency mask stays crisp.
 */
export function blurImage(img: RasterImage, sigma: number): RasterImage {
  if (!(sigma > 0)) return img;
  const { width: w, height: h, data } = img;
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = new Float64Array(radius * 2 + 1);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  const n = w * h;
  // Premultiplied channels + weight.
  const src = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    src[i * 4] = data[i * 4] * a;
    src[i * 4 + 1] = data[i * 4 + 1] * a;
    src[i * 4 + 2] = data[i * 4 + 2] * a;
    src[i * 4 + 3] = a;
  }
  const tmp = new Float32Array(n * 4);
  // Horizontal pass (clamped edges).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
        const kw = kernel[k + radius];
        const j = (row + xx) * 4;
        r += src[j] * kw;
        g += src[j + 1] * kw;
        b += src[j + 2] * kw;
        a += src[j + 3] * kw;
      }
      const o = (row + x) * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }
  const out = new Uint8ClampedArray(data.length);
  // Vertical pass.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
        const kw = kernel[k + radius];
        const j = (yy * w + x) * 4;
        r += tmp[j] * kw;
        g += tmp[j + 1] * kw;
        b += tmp[j + 2] * kw;
        a += tmp[j + 3] * kw;
      }
      const o = (y * w + x) * 4;
      if (a > 1e-6) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
      } else {
        out[o] = data[o];
        out[o + 1] = data[o + 1];
        out[o + 2] = data[o + 2];
      }
      out[o + 3] = data[o + 3];
    }
  }
  return { width: w, height: h, data: out };
}
