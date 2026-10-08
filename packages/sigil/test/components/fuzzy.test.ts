import { fuzzyMatch, highlightRuns, rankBy } from '../../src/components/fuzzy.js';
import { describe, expect, it } from 'vitest';

/** The labels a query keeps, best first. */
function order(query: string, labels: string[]): string[] {
	return rankBy(query, labels, (label) => label).map(({ item }) => item);
}

/** Where a query landed, or `undefined` when it did not. */
function hit(query: string, candidate: string): number[] | undefined {
	return fuzzyMatch(query, candidate)?.matched as number[] | undefined;
}

/** How well a query matched, or `undefined` when it did not. */
function score(query: string, candidate: string): number | undefined {
	return fuzzyMatch(query, candidate)?.score;
}

describe('fuzzyMatch()', () => {
	it('should match a subsequence and say where it landed', () => {
		expect(hit('dbm', 'db migrate')).toEqual([0, 1, 3]);
	});

	it('should match case insensitively in both directions', () => {
		expect(hit('DB', 'db migrate')).toEqual([0, 1]);
		expect(hit('db', 'DB migrate')).toEqual([0, 1]);
	});

	it('should fold the one pair a locale would disagree about', () => {
		// `i` and `I` are the pair `tr-TR` cases differently, so they are the pair
		// worth pinning -- and this does *not* assert that the fold ignores the
		// process locale, which is what it used to be named for and what no test
		// can see: measured, `'I'.toLocaleLowerCase()` is `'i'` even under
		// `LC_ALL=tr_TR.UTF-8`, so only the explicit-argument form differs and a
		// sabotage swapping the call survives. `lower()`'s own doc is where that
		// guard is recorded, because the source is the only place it exists
		expect(hit('i', 'Install')).toEqual([0]);
		expect(hit('I', 'install')).toEqual([0]);
	});

	it('should refuse a query that is not a subsequence', () => {
		expect(hit('zz', 'db migrate')).toBeUndefined();
		// the right characters in the wrong order
		expect(hit('md', 'db migrate')).toBeUndefined();
	});

	it('should refuse a query longer than the candidate', () => {
		expect(hit('migrate', 'mig')).toBeUndefined();
		expect(hit('x', '')).toBeUndefined();
	});

	it('should match everything with an empty query, including an empty candidate', () => {
		expect(fuzzyMatch('', 'db migrate')).toEqual({ matched: [], score: 0 });
		expect(fuzzyMatch('', '')).toEqual({ matched: [], score: 0 });
	});

	it('should tighten the span, which greedy alone gets wrong', () => {
		// the whole reason there are three passes. A forward greedy finds `a` at 0,
		// `t` at 5 and `e` at 7 -- a correct subsequence and the wrong one, because
		// `ate` is sitting right there at the end as a consecutive run
		expect(hit('ate', 'allocate')).toEqual([5, 6, 7]);
		expect(score('ate', 'allocate')).toBeGreaterThan(
			// what the untightened reading would have come to: a prefix hit and two
			// isolated matches
			16 + 12 + 16 + 16
		);
	});

	it('should prefer a prefix to a word boundary to neither', () => {
		// the three bonuses, ordered. Each candidate holds the query exactly once,
		// so what is being compared is only where
		expect(score('m', 'migrate')).toBeGreaterThan(score('m', 'db migrate') as number);
		expect(score('m', 'db migrate')).toBeGreaterThan(score('m', 'dbmigrate') as number);
	});

	it('should read a lower-to-upper transition as a word boundary', () => {
		expect(score('rd', 'runDb')).toBeGreaterThan(score('rd', 'rundb') as number);
	});

	it('should reward a consecutive run', () => {
		// `ab` consecutive against `ab` split by one character, with neither at a
		// boundary and neither at the start
		expect(score('ab', 'xabx')).toBeGreaterThan(score('ab', 'xaxbx') as number);
	});

	it('should never report a negative or non-finite score', () => {
		for (const [query, candidate] of [
			['', ''],
			['', 'x'],
			['x', 'x'],
			['a-b', 'a-b'],
			['  ', '  '],
			['\u{1f600}', '\u{1f600}'],
		]) {
			const match = fuzzyMatch(query as string, candidate as string);
			expect(match, `${query} / ${candidate}`).toBeDefined();
			expect(Number.isFinite(match?.score)).toBe(true);
			expect(match?.score).toBeGreaterThanOrEqual(0);
		}
	});

	it('should treat a space in the query as a character rather than a split', () => {
		expect(hit('db mig', 'db migrate')).toEqual([0, 1, 2, 3, 4, 5]);
		// no tokenizing, so a query of one space matches anything with a space in
		// it and nothing else
		expect(hit(' ', 'db migrate')).toEqual([2]);
		expect(hit(' ', 'migrate')).toBeUndefined();
	});

	it('should match by code point, so an astral character is one character', () => {
		expect(hit('\u{1f600}', 'a\u{1f600}b')).toEqual([1]);
		// and a lone surrogate matches nothing, because there is no lone surrogate
		// in the code point array to match
		expect(hit('\ud83d', 'a\u{1f600}b')).toBeUndefined();
	});
});

describe('the ranking', () => {
	/**
	 * The table the ticket asked for: a query, the candidates, and the order.
	 *
	 * Every row is an ordering rather than a score, because the scores are an
	 * implementation of the ordering and the ordering is the claim. The two rows
	 * that look like ties are not: `db` and `deploy` both score a prefix hit on
	 * one character, and the shorter one wins, which is the length tie-break.
	 */
	const TABLE: [query: string, candidates: string[], expected: string[]][] = [
		['d', ['build', 'deploy', 'db'], ['db', 'deploy', 'build']],
		['mig', ['imaging', 'db migrate', 'migrate'], ['migrate', 'db migrate', 'imaging']],
		// `dumb` holds d, b and m but not in that order, and `db seed` has no `m`
		// at all, so the ranking is the filter as well as the order
		['dbm', ['db migrate', 'dumb', 'db seed'], ['db migrate']],
		['', ['zebra', 'apple'], ['zebra', 'apple']],
		['x', ['build', 'deploy'], []],
		['build', ['build'], ['build']],
		// a boundary hit beats a buried one, and a prefix beats both
		['s', ['db seed', 'install', 'start'], ['start', 'db seed', 'install']],
		// an exact match outranks a longer candidate that holds it as a prefix
		['db', ['db', 'db migrate', 'adb'], ['db', 'db migrate', 'adb']],
		// the query is not reordered: `md` is not a subsequence of anything here
		['md', ['db migrate', 'command'], ['command']],
	];

	it.each(TABLE)('should rank %o over %o as %o', (query, candidates, expected) => {
		expect(order(query, candidates)).toEqual(expected);
	});

	it('should leave an empty query in the order it was given', () => {
		// not an optimization: every candidate scores zero, so the length
		// tie-break would reorder a list nobody had filtered -- and a palette's
		// catalog is already in an order somebody decided
		expect(order('', ['db migrate', 'db', 'a'])).toEqual(['db migrate', 'db', 'a']);
	});

	it('should keep the order it was given where the scores and the lengths tie', () => {
		// what this pins is the *sort's* stability rather than a tie-break of our
		// own: there was a third comparison on the source index and a sabotage
		// said it could not change an answer, because `index` is that position and
		// a stable sort has already kept it. So this is the property, and it fails
		// if the sort is ever replaced with one that is not stable
		expect(order('a', ['ax', 'ay', 'az'])).toEqual(['ax', 'ay', 'az']);
	});

	it('should rank a list of one', () => {
		expect(order('m', ['migrate'])).toEqual(['migrate']);
		expect(order('z', ['migrate'])).toEqual([]);
	});

	it('should rank an empty list', () => {
		expect(order('m', [])).toEqual([]);
		expect(order('', [])).toEqual([]);
	});

	it('should hand back the match beside the item', () => {
		const [first] = rankBy('mig', ['db migrate'], (label) => label);
		expect(first?.item).toBe('db migrate');
		expect(first?.match.matched).toEqual([3, 4, 5]);
	});

	it('should match against what the key returns rather than against the item', () => {
		// which is what lets a palette rank an alias it does not show
		const items = [{ label: 'db migrate', search: 'db migrate m up' }];
		expect(rankBy('up', items, (it) => it.search)).toHaveLength(1);
		expect(rankBy('up', items, (it) => it.label)).toHaveLength(0);
	});
});

describe('highlightRuns()', () => {
	it('should split a label into matched and unmatched runs', () => {
		expect(highlightRuns('db migrate', [0, 1, 3])).toEqual([
			{ on: true, text: 'db' },
			{ on: false, text: ' ' },
			{ on: true, text: 'm' },
			{ on: false, text: 'igrate' },
		]);
	});

	it('should answer one unmatched run when nothing matched', () => {
		expect(highlightRuns('db', [])).toEqual([{ on: false, text: 'db' }]);
	});

	it('should answer nothing for an empty label', () => {
		expect(highlightRuns('', [])).toEqual([]);
		expect(highlightRuns('', [0])).toEqual([]);
	});

	it('should ignore an index past the end', () => {
		// which is how a palette highlights a label out of a match taken against
		// the label *and* its aliases: a hit in the alias tail highlights nothing
		expect(highlightRuns('db', [0, 7])).toEqual([
			{ on: true, text: 'd' },
			{ on: false, text: 'b' },
		]);
	});

	it('should ignore an unsorted or repeated index', () => {
		expect(highlightRuns('abc', [2, 0, 0])).toEqual([
			{ on: true, text: 'a' },
			{ on: false, text: 'b' },
			{ on: true, text: 'c' },
		]);
	});

	it('should keep a combining mark with the base it sits on', () => {
		// the reason the runs are clusters and the indices are code points: a lone
		// combining mark in a `text` of its own measures zero columns and the grid
		// refuses it a cell, so splitting the cluster would lose the character
		const label = 'café';
		expect(highlightRuns(label, [3])).toEqual([
			{ on: false, text: 'caf' },
			{ on: true, text: 'é' },
		]);
		// and marking the mark marks the whole cluster, which is the same answer
		expect(highlightRuns(label, [4])).toEqual([
			{ on: false, text: 'caf' },
			{ on: true, text: 'é' },
		]);
	});

	it('should count code points, not code units, past an astral character', () => {
		// the index unit decision, and the one input that can see it: an index
		// *after* a surrogate pair. Counting code units drifts the cursor by one
		// per astral character, so index 1 would be read as inside the emoji and
		// the `a` would come out unhighlighted
		expect(highlightRuns('\u{1f600}ab', [1])).toEqual([
			{ on: false, text: '\u{1f600}' },
			{ on: true, text: 'a' },
			{ on: false, text: 'b' },
		]);

		// and end to end, so the two cannot come apart: what `fuzzyMatch()` reports
		// is what this is handed
		const match = fuzzyMatch('a', '\u{1f600}ab');
		expect(match?.matched).toEqual([1]);
		expect(highlightRuns('\u{1f600}ab', match?.matched ?? [])).toEqual([
			{ on: false, text: '\u{1f600}' },
			{ on: true, text: 'a' },
			{ on: false, text: 'b' },
		]);
	});

	it('should keep an astral character whole', () => {
		expect(highlightRuns('a\u{1f600}b', [1])).toEqual([
			{ on: false, text: 'a' },
			{ on: true, text: '\u{1f600}' },
			{ on: false, text: 'b' },
		]);
	});

	it('should put back exactly what it was given', () => {
		for (const label of ['', 'db migrate', 'café', 'a\u{1f600}b', '\u{1f1fa}\u{1f1f8}x']) {
			for (const matched of [[], [0], [0, 1], [1, 3], [0, 1, 2, 3, 4, 5]]) {
				expect(
					highlightRuns(label, matched)
						.map(({ text }) => text)
						.join(''),
					`${label} / ${matched.join(',')}`
				).toBe(label);
			}
		}
	});

	it('should answer the runs for whatever a match reports', () => {
		// the pair, end to end: what `fuzzyMatch()` says and what the component
		// would draw cannot come apart, because one is the other's input
		const match = fuzzyMatch('mig', 'db migrate');
		expect(highlightRuns('db migrate', match?.matched ?? [])).toEqual([
			{ on: false, text: 'db ' },
			{ on: true, text: 'mig' },
			{ on: false, text: 'rate' },
		]);
	});
});
