/**
 * Fuzzy matching: a subsequence match with a score, and the runs that highlight
 * it.
 *
 * A pure function of a query and a string, which is the rule the layout engine
 * and the selector engine already keep: this layer is testable with no terminal,
 * no renderer and no reactivity, and it keeps that by not knowing what a command
 * or an element is. `rankBy()` is the same thing over a list.
 *
 * The algorithm is fzf's `FuzzyMatchV1` in miniature -- a forward greedy pass to
 * find where the match ends, a backward pass from there to find the tightest
 * start, and a third pass to produce the indices -- because greedy alone scores
 * the common case wrongly: `ate` against `allocate` matches `a` at 0, `t` at 5
 * and `e` at 7, where `a` at 5 is a consecutive run and is what anybody means. A
 * full dynamic program would be exact and is not worth it at palette scale,
 * where the candidate list is a few dozen commands.
 */

import { graphemes } from '../width/index.js';

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
	return !WORD_RE.test(prev) || (prev === lower(prev) && here !== lower(here));
}

/**
 * One code point, case folded.
 *
 * `toLowerCase()` and not `toLocaleLowerCase()`, for the reason `camelCase()`
 * already records: the locale variant reads the process locale, and in Turkish
 * and Azeri `i` cases to `İ` -- so a query of `i` would stop matching an `I` on
 * a machine set to `tr-TR` and nowhere else. A query is matched against a name
 * somebody chose rather than against prose, and a name has no language.
 *
 * The result may be longer than one code point -- `İ` folds to two -- which is
 * why this is only ever *compared* and never used to index: the indices stay
 * those of the unfolded code point array.
 *
 * **Never the locale variant, and no test can see that.** `toLocaleLowerCase('tr')`
 * maps `I` to a dotless `ı` and `toLocaleUpperCase('tr')` maps `i` to `İ`, so a
 * query of `i` would stop matching an `I` -- which is the trap `camelCase()`
 * already records. What a test cannot reach is the *no-argument* form: measured
 * on node 26 with full ICU, `'I'.toLocaleLowerCase()` is `'i'` even under
 * `LC_ALL=tr_TR.UTF-8` with `Intl` resolving the locale as `tr-TR`, so swapping
 * this call for the no-argument locale form changes no answer anywhere and a
 * sabotage of it survives every test there is. The guard is therefore that this
 * takes **no locale argument**, which is a property of the source rather than of
 * any behaviour, and it is written down here because that is the only place it
 * can be.
 *
 * @param s - One code point.
 * @returns It, folded.
 */
function lower(s: string): string {
	return s.toLowerCase();
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

	const lq = q.map(lower);
	const lc = c.map(lower);

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

/** An item and how well it matched. */
export interface Ranked<T> {
	/** The item. */
	readonly item: T;
	/** Its match. */
	readonly match: FuzzyMatch;
}

/**
 * Keeps the items a query matches, best first.
 *
 * The order is score descending, then the shorter candidate, then the order they
 * were given in. The length tie-break is the usual "shorter is better" and it
 * decides nothing but the order of two equally good matches; what it compares is
 * the string `key` returned, so an item whose candidate carries extra matchable
 * text -- a palette entry's aliases -- loses a tie to one that does not.
 *
 * An empty query returns the list **unsorted**, which is not an optimization: a
 * palette's catalog is already in an order somebody decided -- the nearest
 * context first, then alphabetically -- and every candidate scores zero, so the
 * length tie-break would put `db` ahead of `db migrate` and reorder a list
 * nobody had filtered.
 *
 * @param query - What was typed.
 * @param items - What to rank.
 * @param key - The string to match each item against.
 * @returns The matches, best first.
 */
export function rankBy<T>(
	query: string,
	items: readonly T[],
	key: (item: T) => string
): Ranked<T>[] {
	const ranked: { candidate: string; index: number; item: T; match: FuzzyMatch }[] = [];

	for (const [index, item] of items.entries()) {
		const candidate = key(item);
		const match = fuzzyMatch(query, candidate);
		if (match) {
			ranked.push({ candidate, index, item, match });
		}
	}

	if ([...query].length > 0) {
		// no tie-break past the length: `Array.prototype.sort` is stable, and
		// `index` *is* the source position, so a third comparison on it can only
		// ever agree with the order the sort has already kept. There was one, and a
		// sabotage said so -- replacing it with `0` changed no answer in 38 tests,
		// which is the state this file deletes a guard in rather than keeping
		ranked.sort(
			(a, b) => b.match.score - a.match.score || [...a.candidate].length - [...b.candidate].length
		);
	}

	return ranked.map(({ item, match }) => ({ item, match }));
}

/** A run of text that is either part of the match or is not. */
export interface HighlightRun {
	/** Whether this run matched. */
	readonly on: boolean;
	/** The text. */
	readonly text: string;
}

/**
 * Splits a label into the runs that matched and the runs that did not.
 *
 * Over **grapheme clusters** rather than code points, which is the other half of
 * the unit decision `FuzzyMatch.matched` records: a cluster is marked when any of
 * its code points matched, so a combining mark can never be separated from the
 * base it sits on. It has to be, because a `text` element holding a lone
 * combining mark measures zero columns and the grid refuses it a cell -- the mark
 * would simply not be drawn, and the highlight would have eaten a character.
 *
 * An index past the end is ignored rather than refused, so a label and a match
 * taken from a longer string -- which is what a palette does with the aliases it
 * ranks by and does not show -- highlights the part it can see.
 *
 * @param label - What is shown.
 * @param matched - Code point indices, as `fuzzyMatch()` reports them.
 * @returns The runs, in order, with no empty run among them.
 */
export function highlightRuns(label: string, matched: readonly number[]): HighlightRun[] {
	const hits = new Set(matched);
	const runs: HighlightRun[] = [];
	let point = 0;

	for (const cluster of graphemes(label)) {
		const size = [...cluster].length;
		let on = false;
		for (let k = 0; k < size; k++) {
			if (hits.has(point + k)) {
				on = true;
			}
		}
		point += size;

		const last = runs[runs.length - 1];
		if (last && last.on === on) {
			runs[runs.length - 1] = { on, text: last.text + cluster };
		} else {
			runs.push({ on, text: cluster });
		}
	}

	return runs;
}
