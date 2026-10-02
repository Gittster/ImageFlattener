import { describe, expect, it } from 'vitest';
import { applyEdits, EDIT_NONE, EDIT_VOID, hasEdits, paintSegment, remapEdits, resampleEdits, undoStroke, type StrokeUndo } from '../src/core/edits';
import { VOID } from '../src/core/types';
import { buildProject, readProject } from '../src/project';

describe('brush edits', () => {
  it('paints a round brush along a segment and undoes it exactly', () => {
    const w = 20, h = 10;
    const edits = new Uint8Array(w * h);
    edits[0] = 7;
    const undo: StrokeUndo = { indices: [], previous: [] };
    paintSegment(edits, w, h, 2, 5, 17, 5, 4, 3, undo, new Set());
    expect(edits[5 * w + 10]).toBe(3); // on the line
    expect(edits[0 * w + 10]).toBe(EDIT_NONE); // outside the 4 px brush
    expect(edits[0]).toBe(7);
    expect(new Set(undo.indices).size).toBe(undo.indices.length); // each pixel recorded once
    undoStroke(edits, undo);
    expect(hasEdits(edits)).toBe(true);
    expect([...edits].filter((v) => v !== EDIT_NONE)).toEqual([7]);
  });

  it('applies edits over the computed labels via the id -> index map', () => {
    const map = { width: 3, height: 1, labels: Uint8Array.from([0, 1, 2]) };
    // entry id 5 is now at index 2; id 9 no longer exists
    const idToIndex = new Array(255).fill(-1);
    idToIndex[5] = 2;
    const edits = Uint8Array.from([6, EDIT_VOID, 10]);
    expect(Array.from(applyEdits(map, edits, idToIndex).labels)).toEqual([2, VOID, 2]);
    expect(Array.from(map.labels)).toEqual([0, 1, 2]); // input untouched
  });

  it('remaps entry ids (merges / re-clustering) and resamples', () => {
    const edits = Uint8Array.from([1, 2, 3, EDIT_VOID]);
    remapEdits(edits, new Map<number, number | null>([[1, 0], [2, null]]));
    expect(Array.from(edits)).toEqual([1, 1, EDIT_NONE, EDIT_VOID]);
    expect(Array.from(resampleEdits(Uint8Array.from([1, 2, 3, 4]), 2, 2, 4, 2))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe('project files', () => {
  it('round-trips settings, palette, image bytes and edits', async () => {
    const image = new Blob([Uint8Array.from([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' });
    const edits = new Uint8Array(12);
    edits[3] = 4;
    const blob = await buildProject(
      {
        image: { name: 'cat.png', workingWidth: 4, workingHeight: 3 },
        settings: { colors: 6, mode: 'cutout' },
        palette: { clusterCount: 2, entries: [{ id: 0, clusters: [0, 1], base: [1, 2, 3], override: '#FF0000', filament: null }], stackIds: [0] },
      },
      image,
      { data: edits, width: 4, height: 3 },
    );
    const p = await readProject(blob);
    expect(p.doc.settings).toEqual({ colors: 6, mode: 'cutout' });
    expect(p.doc.image.name).toBe('cat.png');
    expect(p.doc.palette?.entries[0].override).toBe('#FF0000');
    expect(Array.from(new Uint8Array(await p.image.arrayBuffer()))).toEqual([137, 80, 78, 71, 1, 2, 3]);
    expect(p.image.type).toBe('image/png');
    expect(Array.from(p.edits!)).toEqual(Array.from(edits));
  });

  it('rejects files that are not projects', async () => {
    await expect(readProject(new Blob(['hello']))).rejects.toThrow(/not an Image Flattener project/);
  });
});
