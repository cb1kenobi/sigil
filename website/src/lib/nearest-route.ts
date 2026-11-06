/**
 * "Did you mean" for an address: the nearest page to the one that missed.
 *
 * **A port of the CLI's rule, not a second one.** `nearMiss()` and `distance()`
 * in `packages/sigil/src/parser/suggest.ts` are what turn `buidl` into "did you
 * mean build", and the 404 page says the same thing about a path. Those two are
 * not exported from any published subpath of `@ttylabs/sigil` -- `suggest.ts` is
 * deliberately in no barrel -- so this is the rule written out again, with the
 * same bound and the same tie-breaking:
 *
 * - **Damerau-Levenshtein**, so a transposition (`/reference/biuld`) is one slip.
 * - **A rate, not a constant**: one slip per three characters of the shorter
 *   string, with a floor of one. A fixed cap is too loose for `/a` and too tight
 *   for `/docs/getting-startd`.
 * - **Something in common**: a distance as large as the shorter string means the
 *   two share nothing, however short they are.
 * - **A tie is no answer.** A wrong suggestion sends the reader somewhere, and
 *   two equally near pages are one right answer and one wrong one. Choosing
 *   between them would choose by the order the sitemap lists them in.
 *
 * What is left out is the other half of `nearest()`, the abbreviation match
 * (`fuzzyMatch()`, a subsequence that has to start at the front). It is for a
 * command somebody shortened rather than one somebody mistyped, this runs in the
 * browser where it would pull the whole component bundle for it, and the ticket
 * asks for a bounded edit distance. A truncated address (`/docs/getting`) gets no
 * suggestion, which is the safe way to be wrong.
 *
 * Compared as lower case with the leading slash taken off both sides, the way
 * `suggest.ts` strips an option's dashes: `/` is in every path, so counting it
 * would make every pair look one character more alike.
 */

/** The leading slash off, case folded: what two addresses are compared as. */
function key(path: string): string {
  return path.replace(/^\/+/u, '').toLowerCase();
}

/** One slip per three characters of the shorter string, and at least one. */
function limit(shorter: number): number {
  return Math.max(1, Math.floor(shorter / 3));
}

/**
 * The Damerau-Levenshtein distance between two strings (optimal string
 * alignment): an insertion, a deletion, a substitution or a swap of two adjacent
 * characters each cost one. Over code points, so an astral character is one edit.
 *
 * @param a - One string.
 * @param b - The other.
 * @returns The distance, in edits.
 */
export function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];

  // three rows rather than the matrix: a transposition reaches two back
  let twoBack: number[] = [];
  let oneBack: number[] = Array.from({ length: y.length + 1 }, (_, j) => j);

  for (let i = 1; i <= x.length; i++) {
    const row: number[] = [i];

    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let best = Math.min(oneBack[j]! + 1, row[j - 1]! + 1, oneBack[j - 1]! + cost);

      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        best = Math.min(best, twoBack[j - 2]! + cost);
      }

      row[j] = best;
    }

    twoBack = oneBack;
    oneBack = row;
  }

  return oneBack[y.length]!;
}

/**
 * The page the reader most likely meant, or nothing worth saying.
 *
 * @param typed - The path that missed.
 * @param routes - The paths that exist, distinct.
 * @returns One of `routes`, as it is spelt there. Nothing when none is close or when two are
 *   equally close. Only the case differs for `/Reference`, which is the page it names.
 */
export function nearestRoute(typed: string, routes: readonly string[]): string | undefined {
  const q = key(typed);
  const qLength = [...q].length;
  let best: string | undefined;
  let bestDistance = Infinity;
  let ties = 0;

  for (const route of routes) {
    const c = key(route);
    const cLength = [...c].length;
    const shorter = Math.min(qLength, cLength);

    // an edit distance is at least the difference in length, so a pair this
    // refuses is one the floors below would refuse: what it saves is the matrix,
    // for an address that can be as long as the reader likes
    if (Math.abs(qLength - cLength) > limit(shorter)) {
      continue;
    }

    const d = distance(q, c);

    if (d >= shorter || d > limit(shorter)) {
      continue;
    }

    if (d < bestDistance) {
      bestDistance = d;
      best = route;
      ties = 1;
    } else if (d === bestDistance) {
      ties++;
    }
  }

  return ties === 1 ? best : undefined;
}
