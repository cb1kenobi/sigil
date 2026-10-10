/**
 * Ranking a list by a fuzzy match, and the runs that highlight one.
 *
 * `fuzzyMatch()` itself moved to `src/util/fuzzy.ts` when the parser became its
 * second caller -- see that module for why -- and is re-exported here so that
 * `@ttylabs/sigil/components` answers for exactly what it always did. What is
 * left is the two functions that are about a *list* and about *drawing*, which
 * is the half a palette needs and a parse error does not: `highlightRuns()` is
 * the only thing here that reaches for `graphemes()`.
 */

import { fuzzyMatch, type FuzzyMatch } from '../util/fuzzy.js';
import { graphemes } from '../width/index.js';

export { fuzzyMatch, type FuzzyMatch };

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
