import { describe, expect, it } from 'vitest';
import { applyGroups, clusterGroups, entriesFromClusters, mergeEntries, resolveColors } from '../src/core/palette';
import { VOID } from '../src/core/types';

describe('palette editing', () => {
  const centroids: [number, number, number][] = [[20, 20, 20], [200, 0, 0], [0, 0, 200], [240, 240, 240]];

  it('merges entries and remaps labels', () => {
    const merged = mergeEntries(entriesFromClusters(centroids), [1, 2], centroids, [10, 30, 10, 5]);
    expect(merged).toHaveLength(3);
    expect(merged[1].clusters).toEqual([1, 2]);
    const groups = clusterGroups(merged, 4);
    expect(groups).toEqual([0, 1, 1, 2]);
    expect(Array.from(applyGroups(Uint8Array.from([0, 1, 2, 3, VOID]), groups))).toEqual([0, 1, 1, 2, VOID]);
  });

  it('overrides change output colors only, and force black/white pins the extremes', () => {
    const entries = entriesFromClusters(centroids);
    entries[1].override = '#00FF00';
    expect(resolveColors(entries, false)).toEqual(['#141414', '#00FF00', '#0000C8', '#F0F0F0']);
    expect(resolveColors(entries, true)).toEqual(['#000000', '#00FF00', '#0000C8', '#FFFFFF']);
    expect(entries[1].clusters).toEqual([1]);
  });
});
