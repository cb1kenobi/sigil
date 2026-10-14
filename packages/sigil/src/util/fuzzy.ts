/**
 * Fuzzy matching: a subsequence match with a score.
 *
 * A pure function of a query and a string, which is the rule the layout engine
 * and the selector engine already keep: this layer is testable with no terminal,
 * no renderer and no reactivity, and it keeps that by not knowing what a command
 * or an element is.
 *
 * It lives in `src/util/` rather than beside `rankBy()` and `highlightRuns()`
 * because there are two callers now and the second is the **parser**: SIG-143
 * ranks an abbreviation against a command registry, and `src/parser/` may not
 * import `src/components/` -- the dependency already runs the other way, since
 * `src/help/` imports `OptionRegistry` as a value. That is the move `seeded()`
 * and `Random` already made to `src/util/random.ts`, for the same reason and in
 * the same words. `@ttylabs/sigil/components` re-exports it, so the public API
 * is exactly what it was.
 *
 * The algorithm is fzf's `FuzzyMatchV1` in miniature -- a forward greedy pass to
 * find where the match ends, a backward pass from there to find the tightest
 * start, and a third pass to produce the indices -- because greedy alone scores
 * the common case wrongly: `ate` against `allocate` matches `a` at 0, `t` at 5
 * and `e` at 7, where `a` at 5 is a consecutive run and is what anybody means. A
 * full dynamic program would be exact and is not worth it at palette scale,
 * where the candidate list is a few dozen commands.
 *
 * **What it is blind to is a transposition**, which is the measurement SIG-143
 * records at length: `buidl` is not a subsequence of `build`, so this answers
 * nothing at all for the commonest typo there is. A subsequence match is the
 * right tool for an *abbreviation* and the wrong one for a *near miss*, which is
 * why `src/parser/suggest.ts` has an edit distance beside it rather than instead
 * of it.
 */

/** What a matched character is worth. */
const MATCH = 16;

/** On top of `MATCH`, for a character directly after the previous match. */
const CONSECUTIVE = 8;

/**
 * On top of `MATCH`, for a character at the start of a word.
 *
 * A word starts after anything that is not a letter or a number -- a space, a
 * dash, a slash, a dot -- and at a lower-to-upper transition, so `migrate` in
 * `db migrate` and `Db` in `runDb` are both boundaries.
 */
const BOUNDARY = 8;

/** On top of `MATCH`, for a character at the very start of the candidate. */
const PREFIX = 12;

/** A letter or a number: what a word is made of, for the boundary bonus. */
const WORD_RE = /[\p{L}\p{N}]/u;

/** One character's answer to "is this the start of a word". */
function startsWord(prev: string, here: string): boolean {
  // not a word character before it -- a space, a dash, a dot, a slash -- or a
  // lower-to-upper transition, which is the camelCase boundary. Both halves
  // matter: `migrate` in `db migrate` is the first and `Db` in `runDb` is the
  // second, and a palette's labels carry both
  return !WORD_RE.test(prev) || (prev === fold(prev) && here !== fold(here));
}

/**
 * A string, case folded for comparison.
 *
 * `toLowerCase()` and never `toLocaleLowerCase()`. The locale variant reads the
 * process locale, and in Turkish and Azeri `I` cases to a dotless `\u0131` -- so
 * a query of `i` would stop matching an `I` on a machine set to `tr-TR` and
 * nowhere else, which is the trap `camelCase()` already records. A query is
 * matched against a name somebody chose rather than against prose, and a name has
 * no language.
 *
 * **Never the locale variant, and no test can see that.** Measured on node 26
 * with full ICU, `'I'.toLocaleLowerCase()` is `'i'` even under
 * `LC_ALL=tr_TR.UTF-8` with `Intl` resolving the locale as `tr-TR`, so swapping
 * this call for the no-argument locale form changes no answer anywhere and a
 * sabotage of it survives every test there is. The guard is therefore that this
 * takes **no locale argument**, which is a property of the source rather than of
 * any behaviour, and it is written down here because that is the only place it
 * can be.
 *
 * **It is one code point out for one code point in, and that took the swap.**
 * `fuzzyMatch()` walks two arrays of code points and compares their elements, so
 * a folded value that is *two* code points equals no element of the haystack and
 * the forward pass fails outright. `U+0130` is that value: JavaScript gives the
 * **full** case mapping from SpecialCasing.txt, `U+0069 U+0307`, where a matcher
 * wants the **simple** one from UnicodeData.txt, which is `U+0069` and is the
 * first code point of the full mapping -- the Turkic locale mapping agrees, which
 * is the corroboration available from inside the process. Measured: of all
 * 1,114,112 code points **exactly one** has a lowercase mapping longer than
 * itself, and that is it -- 102 have a lengthening *uppercase* mapping, which is
 * why the asymmetry is easy to misjudge. So it is swapped for `i` before the
 * fold, after which `toLowerCase()` is one-to-one for every code point there is.
 * Brute-forced over all of them in `fuzzy.test.ts`, so a later Unicode version
 * that adds a second one fails rather than going quiet.
 *
 * Normalizing is **not** the fix, which is worth recording because it is the
 * obvious guess: there is no precomposed "i with dot above", so all four of NFC,
 * NFD, NFKC and NFKD leave the folded `U+0069 U+0307` exactly as it is. Measured.
 *
 * What this does **not** do is touch a mark the author wrote -- it removes one
 * that **case folding introduced**, which is the line that keeps a decomposed `e`
 * plus a combining acute distinct from a composed `U+00E9`; `nearest()` in
 * `src/parser/suggest.ts` is where that distinction is load bearing. A dotless
 * `U+0131` stays distinct from `i` for the same reason: that is the non-Turkic
 * answer, and the locale rule above is what forbids the other one.
 *
 * The swap costs nothing: twenty folds of a 100,000-character string are 0.13ms
 * with it and 0.15ms without, because `replaceAll` over a string that does not
 * contain it is one scan.
 *
 * @param s - A string, or one code point.
 * @returns It, folded.
 */
export function fold(s: string): string {
  return s.replaceAll('\u0130', 'i').toLowerCase();
}

export interface FuzzyMatch {
  /**
   * Where each query character landed, ascending.
   *
   * Indices into the candidate's **code points** -- `[...candidate]` -- rather
   * than into its code units or its grapheme clusters. Code points are the unit
   * every fuzzy matcher uses and the one that cannot match half a surrogate
   * pair; clusters would be the wrong unit for matching, because a query of `e`
   * would then not match a decomposed `é`. What that costs is that an index may
   * name a combining mark rather than the base it sits on, which is what
   * `highlightRuns()` is for.
   */
  readonly matched: readonly number[];
  /** How good the match is. Higher is better; never negative, never `NaN`. */
  readonly score: number;
}

/**
 * Matches a query against a candidate as a subsequence, and scores it.
 *
 * Case insensitive, per code point. The query is taken exactly as it was typed
 * and is never trimmed or split: a space in it matches a space in the candidate,
 * so `db mig` finds `db migrate` and a query of one space ranks everything with
 * a space in it. Tokenizing would be a second grammar for a reader to hold, and
 * "the whole query is a subsequence" is the version nobody has to be told.
 *
 * An empty query matches everything with a score of nothing to say -- zero, and
 * no indices -- which is what makes an empty palette query the catalog rather
 * than a ranking of it.
 *
 * @param query - What was typed.
 * @param candidate - What to match it against.
 * @returns The match, or `undefined` when the query is not a subsequence.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | undefined {
  const q = [...query];

  // an empty query is every candidate's match, with nothing to rank by.
  //
  // A **fast path** rather than a claim, which a sabotage established: with it
  // gone, the three passes below run over an empty query, find nothing to do,
  // and answer `{ matched: [], score: 0 }` anyway. It is here because that is
  // the one answer worth being able to read off the top of the function
  if (q.length === 0) {
    return { matched: [], score: 0 };
  }

  const c = [...candidate];

  if (q.length > c.length) {
    // a **fast path**, declared: a subsequence cannot be longer than what it is
    // drawn from, so the forward pass below runs off the end and answers
    // `undefined` on its own. What it buys is not folding a long query against
    // a short candidate, which for a palette is most of the list once two
    // characters have been typed
    return undefined;
  }

  const lq = q.map(fold);
  const lc = c.map(fold);

  // forward: where does the match end at the earliest
  let end = -1;
  let at = 0;
  for (const needle of lq) {
    while (at < lc.length && lc[at] !== needle) {
      at++;
    }
    if (at >= lc.length) {
      return undefined;
    }
    end = at;
    at++;
  }

  // backward from there: where does the match start at the latest. This is the
  // whole of what greedy gets wrong -- it finds the *first* subsequence rather
  // than the tightest one -- and running the same loop in reverse from a known
  // end is what fixes it for a character of cost
  let begin = end;
  at = end;
  for (let i = lq.length - 1; i >= 0; i--) {
    const needle = lq[i] as string;
    while (at >= 0 && lc[at] !== needle) {
      at--;
    }
    begin = at;
    at--;
  }

  // forward again, inside the span the two passes agreed on, to say where each
  // query character landed.
  //
  // The inner `while` needs no bound and must not be given one: the backward
  // pass placed every query character at an index inside `[begin, end]`, so a
  // forward greedy starting at `begin` finds each one at or before where the
  // backward pass put it, and the last of those is `end`. A guard here could
  // never fire, which this repository deletes rather than keeps
  const matched: number[] = [];
  at = begin;
  for (const needle of lq) {
    while (lc[at] !== needle) {
      at++;
    }
    matched.push(at);
    at++;
  }

  let score = 0;
  for (const [i, idx] of matched.entries()) {
    score += MATCH;

    if (idx === 0) {
      score += PREFIX;
    } else if (startsWord(c[idx - 1] as string, c[idx] as string)) {
      score += BOUNDARY;
    }

    if (i > 0 && matched[i - 1] === idx - 1) {
      score += CONSECUTIVE;
    }
  }

  return { matched, score };
}
