/**
 * The positions of one longest strictly increasing subsequence of `values`.
 *
 * What a keyed list asks when it reorders: given where each kept row sits now,
 * in the order the rows are wanted, the rows on a longest increasing run are
 * already in order relative to one another and need not move -- every other row
 * is moved around them, which is the fewest moves there are. Solid and Inferno
 * place their lists the same way.
 *
 * Patience sorting with a binary search, so `O(n log n)`: `tails[k]` is the
 * position of the smallest value that ends an increasing run of length `k + 1`,
 * and `previous` threads each value back to the one before it on its run.
 * Strictly increasing, because the values it is asked about are positions and
 * no two rows share one.
 *
 * @param values - The numbers, in order.
 * @returns The positions in `values` of one longest strictly increasing
 *   subsequence, in ascending order. Empty for an empty input.
 */
export function longestIncreasing(values: readonly number[]): number[] {
  const tails: number[] = [];
  const previous: number[] = Array.from({ length: values.length }, () => -1);

  for (const [at, value] of values.entries()) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[tails[mid]] < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      previous[at] = tails[lo - 1];
    }
    tails[lo] = at;
  }

  const run: number[] = Array.from({ length: tails.length }, () => 0);
  let at = tails.length > 0 ? tails[tails.length - 1] : -1;
  for (let k = tails.length - 1; k >= 0; k--) {
    run[k] = at;
    at = previous[at];
  }
  return run;
}
