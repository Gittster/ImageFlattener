import { describe, expect, it } from 'vitest';
import { hexToRgb, labToRgb, labToRgbFloat, rgbToHex, rgbToLab } from '../src/core/color';

describe('CIELAB conversion', () => {
  it('maps reference colors to known Lab values', () => {
    const white = rgbToLab(255, 255, 255);
    expect(white[0]).toBeCloseTo(100, 2);
    expect(white[1]).toBeCloseTo(0, 2);
    expect(white[2]).toBeCloseTo(0, 2);
    expect(rgbToLab(0, 0, 0)).toEqual([0, 0, 0]);
    const red = rgbToLab(255, 0, 0);
    expect(red[0]).toBeCloseTo(53.24, 1);
    expect(red[1]).toBeCloseTo(80.09, 1);
    expect(red[2]).toBeCloseTo(67.2, 1);
  });

  it('round-trips every color on a 17-step RGB grid', () => {
    let maxErr = 0;
    for (let r = 0; r <= 255; r += 15)
      for (let g = 0; g <= 255; g += 15)
        for (let b = 0; b <= 255; b += 15) {
          const [L, A, B] = rgbToLab(r, g, b);
          const [r2, g2, b2] = labToRgbFloat(L, A, B);
          maxErr = Math.max(maxErr, Math.abs(r - r2), Math.abs(g - g2), Math.abs(b - b2));
          expect(labToRgb(L, A, B)).toEqual([r, g, b]);
        }
    expect(maxErr).toBeLessThan(1e-3);
  });

  it('formats and parses hex', () => {
    expect(rgbToHex([29, 53, 87])).toBe('#1D3557');
    expect(hexToRgb('#1d3557')).toEqual([29, 53, 87]);
  });
});
