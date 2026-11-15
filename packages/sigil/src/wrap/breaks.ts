/** The characters `wrap()` breaks a line at, and the one place that says which. */
const BREAK_SPACES = ' \t';

/**
 * Where a text falls into words: a line break, or a run of the break spaces.
 *
 * A **space** followed by a combining mark or a joiner is not a break: it is one
 * grapheme cluster with what follows, and `wrap()` reads a cluster whose text is
 * not exactly a space as part of the word. A tab is, because a control character
 * is a cluster of its own whatever follows it. So the run may not end on a space
 * that is followed by one of those, which leaves a run of spaces ending in such a
 * cluster breaking before its last space and keeping that one with the mark.
 */
const WORD_BREAK = new RegExp(`\\r?\\n|[${BREAK_SPACES}]+(?<! (?=[\\p{M}\\u200c\\u200d]))`, 'u');

/**
 * Whether a cluster is where a line may break: U+0020 and a tab, and no other
 * blank.
 *
 * A non-breaking, figure, narrow no-break or ideographic space is an ordinary
 * character here, part of the word beside it -- which is the point of the ones
 * that say they do not break. It is asked in one place so that `wrap()` and
 * whatever wraps cells of its own, which a decrypt has to, cannot come to
 * disagree about which blanks those are.
 *
 * @param text - A cluster's text.
 * @returns Whether `wrap()` breaks at it.
 */
export function isBreakSpace(text: string): boolean {
  return text.length === 1 && BREAK_SPACES.includes(text);
}

/**
 * A text's words, as `wrap()` finds them: split at a line break and at a run of
 * the break spaces, with nothing empty left over.
 *
 * What the element layer asks in place of splitting on `\s` -- which also splits
 * at a no-break space, so a word `wrap()` keeps whole comes out as two. It is
 * built from the same characters as `isBreakSpace()`, so there is one statement
 * of which they are. **Not exported from `@ttylabs/sigil/wrap`:** its callers are
 * inside this package, and what that subpath exports is frozen at 1.0.
 *
 * @param text - The text to split.
 * @returns The words, in order.
 */
export function words(text: string): string[] {
  return text.split(WORD_BREAK).filter((word) => word !== '');
}
