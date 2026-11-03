let segmenter: Intl.Segmenter | undefined;

/**
 * Splits a string into grapheme clusters with `Intl.Segmenter`, whatever is in
 * it.
 *
 * This is the full path under `graphemes()` and `stringWidth()`, kept out of the
 * published `width` entry: callers want `graphemes()`, which takes plain ASCII
 * without one. It is a module of its own so that the suite can hold that
 * shortcut to the answers this gives.
 *
 * The segmenter is built the first time something is segmented rather than when
 * the module loads, because building the first one in a process is what loads
 * ICU -- and a process that only ever measures plain ASCII never needs it.
 *
 * @param str - The string to split.
 * @returns The clusters, in order.
 */
export function segment(str: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const clusters: string[] = [];
  for (const part of segmenter.segment(str)) {
    clusters.push(part.segment);
  }
  return clusters;
}
