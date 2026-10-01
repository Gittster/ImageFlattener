// sRGB <-> CIELAB (D65 reference white) conversions.

export type RGB = [number, number, number];
export type Lab = [number, number, number];

const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function srgbToLinear(c: number): number {
  const ci = Math.round(c);
  if (ci === c && ci >= 0 && ci <= 255) return SRGB_TO_LINEAR[ci];
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return v * 255;
}

const f = (t: number): number => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const finv = (t: number): number => {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
};

/** sRGB (0-255 per channel, may be fractional) to CIELAB. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / XN;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / YN;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / ZN;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIELAB to sRGB (0-255, unclamped floats). */
export function labToRgbFloat(L: number, a: number, bb: number): RGB {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const x = finv(fx) * XN;
  const y = (L > KAPPA * EPS ? fy * fy * fy : L / KAPPA) * YN;
  const z = finv(fz) * ZN;
  const lr = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const lg = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const lb = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}

/** CIELAB to sRGB, rounded and clamped to 0-255 integers. */
export function labToRgb(L: number, a: number, b: number): RGB {
  const [r, g, bl] = labToRgbFloat(L, a, b);
  return [clamp255(r), clamp255(g), clamp255(bl)];
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Perceptual lightness (CIELAB L*) of an sRGB color. */
export function lightness([r, g, b]: RGB): number {
  return rgbToLab(r, g, b)[0];
}
