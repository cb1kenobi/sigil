import { nearMiss } from '@ttylabs/sigil/suggest';

/**
 * "Did you mean" for an address: the nearest page to the one that missed.
 *
 * The CLI's own rule, not a second one. `nearMiss()` is what turns `sigil buidl`
 * into "did you mean build", published as `@ttylabs/sigil/suggest` so that it
 * runs in the browser (the parser module around it reaches Node-only modules).
 * Its floors, measured in `packages/sigil/src/parser/suggest.ts`, carry over:
 *
 * - **Damerau-Levenshtein**, so a transposition (`/reference/biuld`) is one slip.
 * - **A rate, not a constant**: one slip per three characters of the shorter
 *   string, with a floor of one.
 * - **Something in common**: a distance as large as the shorter string means the
 *   two share nothing.
 * - **A tie is no answer**, because a wrong suggestion sends the reader somewhere
 *   and two equally near pages are one right answer and one wrong one.
 *
 * The abbreviation half of the CLI's suggestion is not used: it is for a command
 * somebody shortened, and the ticket asks for a bounded edit distance. A
 * truncated address (`/docs/getting`) gets no suggestion, which is the safe way
 * to be wrong.
 */

/**
 * What two addresses are compared as: the leading slash off, the way the parser
 * takes an option's dashes off. `/` is in every path, so counting it would make
 * every pair look one character more alike. `nearMiss()` folds case itself.
 */
function key(path: string): string {
  return path.replace(/^\/+/u, '');
}

/**
 * The page the reader most likely meant, or nothing worth saying.
 *
 * @param typed - The path that missed.
 * @param routes - The paths that exist, distinct.
 * @returns One of `routes`, as it is spelt there. Nothing when none is close or when two are
 *   equally close.
 */
export function nearestRoute(typed: string, routes: readonly string[]): string | undefined {
  return nearMiss(typed, routes, key);
}
