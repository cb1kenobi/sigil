/**
 * The largest of a list of numbers, for a list of any length.
 *
 * `Math.max(...values)` puts every element on the call stack as an argument, so
 * past somewhere around a hundred thousand of them -- the figure moves with the
 * Node version, the platform and how deep the call already is -- it throws
 * `RangeError: Maximum call stack size exceeded` instead of answering. That is
 * a limit on the *caller's data*: a line chart of a long series, a table of many
 * rows, a box with many children. So anywhere the list is as long as somebody's
 * data, it is measured with this rather than spread. See "No spread of a
 * data-sized array" in `src/components/AGENTS.md`.
 *
 * The answer is `Math.max(floor, ...values)` exactly, because it is that same
 * function asked one element at a time, and `Math.max` is associative and
 * commutative over every number including the odd ones: a `NaN` anywhere is
 * `NaN`, `-0` against `0` is `0`, and nothing at all is the `floor`, which
 * defaults to `-Infinity` because that is what `Math.max()` of nothing is.
 *
 * Published from `@ttylabs/sigil/width`, where measuring is, and a component
 * imports it from there beside `stringWidth()` -- so an ejected copy reaches it
 * through a subpath it already imports. What is not a component imports this
 * module, so the layout engine does not take the width module on to ask it.
 *
 * @param values - The numbers.
 * @param floor - What is answered when nothing is larger. Defaults to `-Infinity`.
 * @returns The largest.
 */
export function maxOf(values: Iterable<number>, floor: number = -Infinity): number {
  let max = floor;
  for (const value of values) {
    max = Math.max(max, value);
  }
  return max;
}

/**
 * The smallest of a list of numbers, for a list of any length: `maxOf()` the
 * other way up, and exactly `Math.min(ceiling, ...values)`.
 *
 * @param values - The numbers.
 * @param ceiling - What is answered when nothing is smaller. Defaults to `Infinity`.
 * @returns The smallest.
 */
export function minOf(values: Iterable<number>, ceiling: number = Infinity): number {
  let min = ceiling;
  for (const value of values) {
    min = Math.min(min, value);
  }
  return min;
}
