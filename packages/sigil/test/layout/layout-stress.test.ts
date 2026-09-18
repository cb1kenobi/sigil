import { layout } from '../../src/layout/index.js';
import { checkInvariants } from './helpers.js';
import { build, generate, type Options, rng, shrink, source, type Spec } from './random.js';
import { describe, expect, it } from 'vitest';

/**
 * The layout engine against its own invariants, over trees nobody wrote.
 *
 * The picture tests check the cases somebody thought of, and they cannot see the
 * failure that matters most: `render()` paints later nodes over earlier ones, so
 * two boxes in one place look exactly like one box. `checkInvariants()` sees it,
 * and a generator is what puts trees in front of it -- a wrapping row of text
 * placed its second line on top of its first for as long as this engine has
 * existed, through a hundred and nine hand-written tests, because no two of them
 * happened to put a text that wraps on a line that wraps.
 *
 * There is no oracle here and there cannot be: a second flexbox implementation is
 * the dependency this package exists to do without. So what is asserted is what a
 * layout has to keep whatever it was asked for -- no negative boxes, siblings
 * clear of each other, and a child's box filling the hole its parent reserved.
 *
 * **Containment is not among them, and that is a finding rather than an
 * oversight.** A child escaping its parent's content box is overflow, which CSS
 * produces on purpose and which this corpus produces constantly: a word longer
 * than the room is an automatic minimum that cannot shrink, a declared height in
 * a shorter parent has no axis to flex on, and a `min-width` beside a sibling's
 * is a pair of constraints with no solution. Measured rather than argued -- 41,038
 * of 42,000 random layouts escape something, and every one that was shrunk and
 * read by hand was legitimate. The invariant is real where a tree was written to
 * fit, which is where `layout.test.ts` asserts it, and `checkInvariants()` keeps
 * its `overflow` option for exactly that split.
 *
 * A zero-area box is deliberately *not* excused, though nothing can be painted on
 * top of one. `apart` is false against a degenerate rectangle whatever sits where
 * it is, which reads like a hole in the check and is in fact its sharpest edge:
 * four of the five defects found here arrived as a zero-area box reported inside
 * a sibling, and loosening the rule to match the intuition would have hidden all
 * four. Once the engine was fixed the strict rule fired zero times in 70,000
 * layouts.
 */

/** The sizes every generated tree is laid out at, degenerate ones included. */
const SIZES: [number, number][] = [
	[0, 0],
	[1, 1],
	[3, 2],
	[7, 4],
	[13, 6],
	[40, 12],
	[80, 24],
];

const SHAPE: Options = { breadth: 4, depth: 3, relative: true };

/**
 * Trees per seed.
 *
 * Five seeds at two hundred trees is seven thousand layouts in about a second
 * and a half, which is what a suite that runs on every save can pay. A hunt runs
 * wider by hand: three hundred seeds at a hundred trees is 210,000 layouts and
 * takes fifty seconds, which is the sweep the defect above was found and then
 * cleared by.
 */
const TREES = 200;

interface Failure {
	height: number;
	message: string;
	width: number;
}

/** Lays a tree out and reports what it broke, if anything. */
function check(spec: Spec, width: number, height: number): string | undefined {
	try {
		// overflow allowed, for the reason at the top: an escape is legitimate
		// across this corpus, and a check that fails on what the engine is
		// supposed to do is a check somebody deletes
		checkInvariants(layout(build(spec), { height, width }), { overflow: true });
		return undefined;
	} catch (error) {
		return (error as Error).message;
	}
}

/**
 * What a failure prints: the seed that produced it, the size it was laid out at,
 * what broke, and the smallest tree that still breaks it, written as the source
 * that builds it.
 *
 * Shrunk on the way out rather than reported as it was found, because a
 * generated tree is forty nodes carrying two hundred declarations of which three
 * matter -- and whoever reads this would otherwise cut it down by hand before
 * they could even name the bug.
 *
 * @param seed - The seed that produced the tree.
 * @param spec - The tree that failed.
 * @param failure - What broke, and at what size.
 * @returns The report.
 */
function report(seed: number, spec: Spec, failure: Failure): string {
	const smallest = shrink(
		spec,
		(candidate) => check(candidate, failure.width, failure.height) !== undefined
	);

	return [
		`seed ${seed}, at ${failure.width}x${failure.height}: ` +
			`${check(smallest, failure.width, failure.height) ?? failure.message}`,
		'',
		source(smallest),
		'',
	].join('\n');
}

describe('the layout engine, over random trees', () => {
	for (const seed of [1, 2, 3, 12345, 987654321]) {
		it(`should hold the invariants (seed ${seed})`, () => {
			const random = rng(seed);
			let found: { failure: Failure; spec: Spec } | undefined;

			for (let tree = 0; tree < TREES && !found; tree++) {
				const spec = generate(random, SHAPE);
				for (const [width, height] of SIZES) {
					const message = check(spec, width, height);
					if (message !== undefined) {
						found = { failure: { height, message, width }, spec };
						break;
					}
				}
			}

			if (found) {
				throw new Error(report(seed, found.spec, found.failure));
			}
		});
	}

	it('should generate trees that reach the properties it means to', () => {
		const random = rng(42);
		const seen = new Set<string>();

		for (let tree = 0; tree < TREES; tree++) {
			const walk = (spec: Spec): void => {
				if (spec.text !== undefined) {
					seen.add('text');
				}
				for (const [key, value] of Object.entries(spec.declarations)) {
					seen.add(key);
					if (value.endsWith('%')) {
						seen.add('percent');
					}
					if (value === 'auto') {
						seen.add('auto margin');
					}
				}
				for (const child of spec.children) {
					walk(child);
				}
			};
			walk(generate(random, SHAPE));
		}

		// a fuzzer that never reaches what its ticket names is not testing what its
		// name says, so the corpus is asserted rather than assumed -- the same
		// reason `graph-stress.test.ts` counts the short-circuits it exists to
		// exercise. A property dropped from the generator by accident would
		// otherwise cost nothing and be noticed by nobody
		for (const property of [
			'align-content',
			'align-self',
			'auto margin',
			'border',
			'flex-basis',
			'flex-direction',
			'flex-grow',
			'flex-shrink',
			'flex-wrap',
			'gap',
			'justify-content',
			'max-width',
			'min-height',
			'min-width',
			'order',
			'padding',
			'percent',
			'position',
			'text',
		]) {
			expect(seen.has(property), `generated no ${property}`).toBe(true);
		}
	});
});
