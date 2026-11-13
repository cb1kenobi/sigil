import { longestIncreasing } from '../../src/util/longest-increasing.js';
import { seeded } from '../../src/util/random.js';
import { describe, expect, it } from 'vitest';

/** The length the slow way, so the fast one is checked against something else. */
function lengthByTable(values: readonly number[]): number {
  const best = values.map(() => 1);
  for (let i = 0; i < values.length; i++) {
    for (let j = 0; j < i; j++) {
      if (values[j] < values[i]) {
        best[i] = Math.max(best[i], best[j] + 1);
      }
    }
  }
  return Math.max(0, ...best);
}

/** Whether `run` names positions of `values` that ascend and whose values strictly do. */
function isIncreasingRun(values: readonly number[], run: readonly number[]): boolean {
  return run.every(
    (at, k) =>
      at >= 0 &&
      at < values.length &&
      (k === 0 || (run[k - 1] < at && values[run[k - 1]] < values[at]))
  );
}

describe('longestIncreasing()', () => {
  it('should answer nothing for nothing', () => {
    expect(longestIncreasing([])).toEqual([]);
  });

  it('should take the whole of a list already in order', () => {
    expect(longestIncreasing([0, 1, 2, 3])).toEqual([0, 1, 2, 3]);
  });

  it('should take one entry of a list in reverse', () => {
    expect(longestIncreasing([3, 2, 1, 0])).toHaveLength(1);
  });

  it('should leave out only the entry that moved', () => {
    // the first row taken to the end: what stays is every row but that one
    expect(longestIncreasing([1, 2, 3, 4, 0])).toEqual([0, 1, 2, 3]);
    // the two ends swapped: what stays is everything between them
    expect(longestIncreasing([4, 1, 2, 3, 0])).toEqual([1, 2, 3]);
  });

  it('should be strictly increasing, so an equal value does not extend a run', () => {
    expect(longestIncreasing([1, 1, 1])).toHaveLength(1);
    expect(longestIncreasing([0, 2, 2, 3])).toHaveLength(3);
  });

  it('should find a run as long as the quadratic table does, over shuffled positions', () => {
    const random = seeded(345);
    for (let round = 0; round < 200; round++) {
      const n = Math.floor(random() * 40);
      const values = Array.from({ length: n }, (_, at) => at);
      for (let at = n - 1; at > 0; at--) {
        const other = Math.floor(random() * (at + 1));
        [values[at], values[other]] = [values[other], values[at]];
      }
      const run = longestIncreasing(values);
      expect(isIncreasingRun(values, run)).toBe(true);
      expect(run).toHaveLength(lengthByTable(values));
    }
  });
});
