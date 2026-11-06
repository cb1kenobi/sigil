/**
 * The edit-distance half of "did you mean", published on its own as
 * `@ttylabs/sigil/suggest`.
 *
 * It is the rule `parser/suggest.ts` answers `Unknown command "buidl"` with, and
 * the measurements behind its floors are there. It lives here, importing nothing
 * but `fold()`, because the parser's module also reaches i18n and the debug
 * logger, which are Node's: this half has to run anywhere a list of names does,
 * a browser included. The website's 404 page asks it for the nearest page to an
 * address that missed, so the CLI and the site make the same suggestion by the
 * same rule rather than by two copies of it.
 *
 * The abbreviation half (`nearest()`, over `fuzzyMatch()`) stays in the parser.
 */

import { fold } from './fuzzy.js';

/**
 * How many characters of slip a candidate is allowed, as a rate.
 *
 * One per three, with a floor of one, measured against the shorter of the two
 * strings. A **rate** rather than a fitted constant, because what it is a
 * statement about is how often a finger slips: a flat cap of 1 answers 44 of the
 * fifty-typo corpus and misses a double slip in a long word (`insatlll`,
 * `verisno`), while a flat cap of 2 answers 46 and offers something for seven of
 * the thirty-six tokens that should offer nothing -- `hello` for `help`, `q` for
 * `db`, and the empty string for anything. One per three answers 46 by itself and
 * refuses every one of those.
 *
 * Measured on the **shorter** of the two, which is worth saying because applying
 * it to the candidate's length instead is the natural misreading and has been
 * made: an abbreviation of three characters against a candidate of seven is
 * allowed one slip rather than two, because three is what the two have in common
 * to be wrong about.
 *
 * @param shorter - The shorter of the two strings, in code points.
 * @returns The largest distance that still counts as a near miss.
 */
function limit(shorter: number): number {
  return Math.max(1, Math.floor(shorter / 3));
}

/**
 * The Damerau-Levenshtein distance between two strings, case folded.
 *
 * Optimal string alignment: an insertion, a deletion, a substitution or a
 * transposition of two **adjacent** characters each cost one. The transposition
 * is the whole reason this is not plain Levenshtein, and it is not a refinement
 * -- it is most of the feature. A transposition is two edits to Levenshtein, so
 * `verbsoe` is distance 2 from `verbose` there and 1 here, and every floor tight
 * enough to be safe refuses 2: measured, the same corpus and the same floor
 * answer 44 with the transposition priced at one and 17 without it.
 *
 * Over **code points** rather than code units, which is the unit
 * `FuzzyMatch.matched` already records: by code unit a surrogate pair is two
 * edits from nothing and an astral typo is twice as far from its candidate as it
 * should be.
 *
 * Unbounded on purpose. A bound is the obvious optimization and it buys nothing
 * here: a candidate list is a few dozen names of a dozen characters, which is
 * thousands of integer comparisons on a path that is already about to throw.
 *
 * @param a - One string.
 * @param b - The other.
 * @returns The distance, in edits.
 */
export function distance(a: string, b: string): number {
  const x = [...fold(a)];
  const y = [...fold(b)];

  // one row behind, the row before it, and the row being filled. Three rows
  // rather than the whole matrix, because a transposition reaches two back and
  // nothing reaches further
  let twoBack: number[] = [];
  let oneBack: number[] = Array.from({ length: y.length + 1 }, (_, j) => j);

  for (let i = 1; i <= x.length; i++) {
    const row: number[] = [i];

    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let best = Math.min(
        (oneBack[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (oneBack[j - 1] as number) + cost
      );

      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        best = Math.min(best, (twoBack[j - 2] as number) + cost);
      }

      row[j] = best;
    }

    twoBack = oneBack;
    oneBack = row;
  }

  return oneBack[y.length] as number;
}

/** What a candidate is compared as, where that is not what it is typed as. */
export type SuggestKey = (candidate: string) => string;

/**
 * The nearest candidate by edit distance, or nothing where that is ambiguous.
 *
 * Two floors, and both were measured rather than chosen. The **rate** is
 * `limit()`. The other is that a suggestion has to have **something in common**
 * with what was typed: a distance at or past the shorter string's own length
 * means the two share nothing, which for a one-character string means the two
 * characters simply differ. That is the whole of what refuses `-x` for `-v`, and
 * short options are common enough that without it the feature is unusable.
 *
 * An **exact** match is allowed, and is reachable rather than dead: it is `--p`
 * against a declared `-p`, where the names agree and only the spelling differs.
 * A candidate whose own spelling equals what was typed cannot be in the list at
 * all, because the parse would have resolved it instead of failing.
 *
 * **A tie is no answer**, which is the "a wrong suggestion is worse than none"
 * rule applied to ambiguity: two candidates equally near is one right answer and
 * one wrong one, and choosing between them would choose by registration order --
 * which for a directory of command modules is whatever the file system felt
 * like, and which this repository refuses everywhere else.
 *
 * @param typed - What was typed.
 * @param candidates - What it could have been.
 * @param key - What to compare each of them as, applied to both sides.
 * @returns The candidate, as it is typed, or nothing.
 */
export function nearMiss(
  typed: string,
  candidates: readonly string[],
  key: SuggestKey
): string | undefined {
  // folded once here rather than per comparison, so the lengths below and the
  // distance are measured on the same string. The fold is one code point out for
  // one code point in -- see `fold()`, and the brute force over every code point
  // that pins it -- so the folded length *is* the raw length and there is no
  // second reading of it to keep in agreement. There was, before `U+0130` was
  // swapped: folding lengthened there, and the two readings answered differently
  const q = fold(key(typed));
  const qLength = [...q].length;
  let best: string | undefined;
  let bestDistance = Infinity;
  let ties = 0;

  for (const candidate of candidates) {
    const c = fold(key(candidate));
    const cLength = [...c].length;
    const shorter = Math.min(qLength, cLength);

    // a **declared fast path**: an edit distance is at least the difference in
    // length, so a pair this refuses is one the two floors below would refuse
    // anyway, and no answer changes. What it buys is that nothing walks the
    // whole matrix per candidate -- measured, a 100,000-character token against
    // twenty-eight ten-character commands is 78ms without it and 5.9ms with,
    // and an argv token really can be a very long path. What is left is the one
    // fold and the one count of the token itself, which is why it is 5.9 rather
    // than nothing
    if (Math.abs(qLength - cLength) > limit(shorter)) {
      continue;
    }

    const d = distance(q, c);

    if (d >= shorter || d > limit(shorter)) {
      continue;
    }

    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
      ties = 1;
    } else if (d === bestDistance) {
      ties++;
    }
  }

  return ties === 1 ? best : undefined;
}
