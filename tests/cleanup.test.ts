import { describe, expect, it } from 'vitest';
import { connectedComponents, despeckle, findThinFeatures, modeFilter } from '../src/core/cleanup';
import { VOID, type LabelMap } from '../src/core/types';

/** Build a label map from rows of digits. */
function map(rows: string[]): LabelMap {
  const h = rows.length;
  const w = rows[0].length;
  const labels = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (labels[y * w + x] = Number(c))));
  return { width: w, height: h, labels };
}

function rows(m: LabelMap): string[] {
  const out: string[] = [];
  for (let y = 0; y < m.height; y++) out.push(Array.from(m.labels.subarray(y * m.width, (y + 1) * m.width)).join(''));
  return out;
}

describe('despeckle', () => {
  it('reassigns a small region to the neighbour with the longest shared border', () => {
    // The 2x2 block of 2s touches label 0 along 5 pixel edges... and label 1 along 3.
    const m = map([
      '000000',
      '000000',
      '002211',
      '002211',
      '000111',
      '000111',
    ]);
    const out = despeckle(m, 5);
    expect(rows(out)).toEqual([
      '000000',
      '000000',
      '000011',
      '000011',
      '000111',
      '000111',
    ]);
  });

  it('prefers the longer border even when the other neighbour is larger', () => {
    const m = map([
      '1111111',
      '1111111',
      '1112000',
      '1112000',
      '1112000',
    ]);
    // The 1x3 column of 2s borders label 1 on 4 edges (left + top) and label 0 on 3.
    expect(rows(despeckle(m, 4))[2]).toBe('1111000');
  });

  it('keeps regions at or above the threshold', () => {
    const m = map(['0000', '0220', '0220', '0000']);
    expect(rows(despeckle(m, 4))).toEqual(rows(m));
    expect(rows(despeckle(m, 5))).toEqual(['0000', '0000', '0000', '0000']);
  });

  it('re-evaluates specks that merge into other specks', () => {
    // Single-pixel specks of 3 next to a 2-pixel speck of 2 inside a big 0 region.
    const m = map(['00000', '03220', '00000']);
    const out = despeckle(m, 4);
    expect(rows(out)).toEqual(['00000', '00000', '00000']);
  });

  it('leaves an image consisting of a single region alone', () => {
    const m = map(['11', '11']);
    expect(rows(despeckle(m, 100))).toEqual(['11', '11']);
  });
});

describe('mode filter', () => {
  it('removes isolated pixels', () => {
    const m = map(['00000', '00100', '00000']);
    expect(rows(modeFilter(m, 1))).toEqual(['00000', '00000', '00000']);
  });
});

describe('connected components', () => {
  it('uses 4-connectivity', () => {
    const c = connectedComponents(map(['10', '01']));
    expect(c.count).toBe(4);
  });
});

describe('thin features', () => {
  it('flags thin lines but not thick shapes', () => {
    const w = 120, h = 60;
    const labels = new Uint8Array(w * h).fill(VOID); // transparent background
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (x >= 5 && x < 45 && y >= 5 && y < 55) labels[y * w + x] = 1; // 40x50 block
        if (x >= 60 && x < 110 && y >= 29 && y < 31) labels[y * w + x] = 2; // 2px-wide line
      }
    const res = findThinFeatures({ width: w, height: h, labels }, 6);
    expect(res.count).toBe(1);
    expect(res.mask[30 * w + 80]).toBe(1);
    expect(res.mask[30 * w + 25]).toBe(0);
  });

  it('treats the image edge as a boundary', () => {
    // A 3px strip of color 0 between the image edge and a big block of 1.
    const w = 60, h = 40;
    const labels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 3; x < w; x++) labels[y * w + x] = 1;
    expect(findThinFeatures({ width: w, height: h, labels }, 6).count).toBe(1);
  });
});
