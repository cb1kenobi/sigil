import type { LayoutNode } from '../../src/layout/index.js';
import type { Declarations } from '../../src/style/index.js';
import { box, text } from './helpers.js';

/**
 * Random trees for the layout engine, and a shrinker to cut a failing one down.
 *
 * A picture test checks the cases somebody thought of. This checks the cases
 * nobody did, against `checkInvariants()` rather than against an oracle -- there
 * is no second flexbox implementation here to disagree with, so what is asserted
 * is what a layout has to keep whatever it was asked for: no negative boxes,
 * children inside their parent, siblings clear of each other, and a child's box
 * filling the hole its parent reserved for it.
 *
 * This lives beside the tests rather than inside one so that a triage script can
 * drive the same generator the suite does. `graph-stress.test.ts` is the same
 * idea for the reactive graph.
 */

/** A seeded generator, so a failure names a seed that reproduces it. */
export function rng(seed: number): () => number {
	let s = seed >>> 0 || 0x9e3779b9;
	return () => {
		// xorshift32, as in the signals stress tests
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x1_0000_0000;
	};
}

/**
 * A tree as plain data.
 *
 * The generator produces these rather than `LayoutNode`s so that a failing tree
 * can be printed, shrunk, and pasted back into a test. A `Style` is fifty-odd
 * resolved properties and says nothing about what was declared; these are the
 * declarations, which is what a regression test wants to be written in.
 */
export interface Spec {
	children: Spec[];
	declarations: Declarations;
	/** Text content, for a leaf that measures rather than placing children. */
	text?: string;
}

/** Builds the tree the engine takes from the tree the generator produced. */
export function build(spec: Spec): LayoutNode {
	if (spec.text !== undefined) {
		return text(spec.text, spec.declarations);
	}
	return box(spec.declarations, ...spec.children.map(build));
}

const DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse'];
const WRAPS = ['nowrap', 'wrap', 'wrap-reverse'];
const JUSTIFY = [
	'flex-start',
	'flex-end',
	'center',
	'space-between',
	'space-around',
	'space-evenly',
];
const ALIGN_ITEMS = ['flex-start', 'flex-end', 'center', 'stretch'];
const ALIGN_SELF = ['auto', 'flex-start', 'flex-end', 'center', 'stretch'];
const ALIGN_CONTENT = [
	'flex-start',
	'flex-end',
	'center',
	'stretch',
	'space-between',
	'space-around',
];
const SIZES = ['0', '1', '2', '3', '5', '8', '13'];
const PERCENTS = ['10%', '25%', '33%', '50%', '75%', '100%'];
const COUNTS = ['0', '1', '2'];
const FACTORS = ['0', '1', '2', '3'];
/**
 * Words with something in them a cell grid has an opinion about: a wide cluster
 * is two columns, a combining mark is none, and the longest word is the
 * automatic minimum that stops an item shrinking.
 */
const WORDS = ['a', 'to', 'the', 'lorem', 'ipsum', 'dolor', '漢字', 'éte', 'x'.repeat(12)];

function pick<T>(random: () => number, items: readonly T[]): T {
	return items[Math.floor(random() * items.length)];
}

function chance(random: () => number, probability: number): boolean {
	return random() < probability;
}

/** A length, drawn from the three kinds the engine reads differently. */
function length(random: () => number): string {
	return chance(random, 0.7) ? pick(random, SIZES) : pick(random, PERCENTS);
}

/** What a node says about itself as an item in its parent's line. */
function itemDeclarations(random: () => number, opts: Options): Declarations {
	const out: Declarations = {};

	if (chance(random, 0.35)) {
		out.width = length(random);
	}
	if (chance(random, 0.35)) {
		out.height = length(random);
	}
	if (chance(random, 0.2)) {
		out['min-width'] = length(random);
	}
	if (chance(random, 0.2)) {
		out['min-height'] = length(random);
	}
	if (chance(random, 0.2)) {
		out['max-width'] = length(random);
	}
	if (chance(random, 0.2)) {
		out['max-height'] = length(random);
	}
	if (chance(random, 0.4)) {
		out['flex-grow'] = pick(random, FACTORS);
	}
	if (chance(random, 0.3)) {
		out['flex-shrink'] = pick(random, FACTORS);
	}
	if (chance(random, 0.2)) {
		out['flex-basis'] = length(random);
	}
	if (chance(random, 0.25)) {
		out['align-self'] = pick(random, ALIGN_SELF);
	}
	if (chance(random, 0.15)) {
		out.order = pick(random, ['-1', '0', '1', '2']);
	}

	for (const edge of ['top', 'right', 'bottom', 'left']) {
		if (chance(random, 0.15)) {
			out[`margin-${edge}`] = chance(random, 0.2)
				? 'auto'
				: chance(random, 0.8)
					? pick(random, COUNTS)
					: pick(random, PERCENTS);
		}
	}

	if (opts.relative && chance(random, 0.15)) {
		// `absolute` and `fixed` are placed against a containing block rather than
		// among their siblings, which is what `unplaced()` excuses -- they are in
		// the corpus because the arithmetic that places them is new, not because
		// the invariants can say much about where they land
		out.position = pick(random, ['relative', 'relative', 'absolute', 'fixed']);
		for (const edge of ['top', 'right', 'bottom', 'left']) {
			if (chance(random, 0.4)) {
				out[edge] = pick(random, ['0', '1', '2', '-1', '25%']);
			}
		}
	}

	if (chance(random, 0.1)) {
		out['z-index'] = pick(random, ['-1', '0', '1', '2']);
	}

	return out;
}

/** What a node says about the line it lays its own children out on. */
function containerDeclarations(random: () => number): Declarations {
	const out: Declarations = {};

	if (chance(random, 0.8)) {
		out['flex-direction'] = pick(random, DIRECTIONS);
	}
	if (chance(random, 0.5)) {
		out['flex-wrap'] = pick(random, WRAPS);
	}
	if (chance(random, 0.5)) {
		out['justify-content'] = pick(random, JUSTIFY);
	}
	if (chance(random, 0.4)) {
		out['align-items'] = pick(random, ALIGN_ITEMS);
	}
	if (chance(random, 0.3)) {
		out['align-content'] = pick(random, ALIGN_CONTENT);
	}
	if (chance(random, 0.3)) {
		out.gap = pick(random, COUNTS);
	}
	if (chance(random, 0.25)) {
		out.padding = pick(random, COUNTS);
	}
	if (chance(random, 0.2)) {
		out.border = 'single';
	}
	if (chance(random, 0.2)) {
		out['box-sizing'] = 'content-box';
	}
	if (chance(random, 0.15)) {
		out.overflow = pick(random, ['hidden', 'scroll', 'auto']);
	}

	return out;
}

export interface Options {
	/** The most children a node may have. */
	breadth: number;
	/** How many levels below the root the generator may go. */
	depth: number;
	/**
	 * Whether to declare `position: relative`.
	 *
	 * An offset box is excused containment and overlap by design, so switching
	 * this off is how a run asks for trees where every box is still checked.
	 */
	relative: boolean;
}

/**
 * A random tree.
 *
 * @param random - The seeded source.
 * @param opts - How big and how wild.
 * @returns The tree, as data.
 */
export function generate(random: () => number, opts: Options): Spec {
	const node = (depth: number, root: boolean): Spec => {
		// a leaf is a box or a text; text is what makes measurement part of the
		// space, and an empty box is what makes a zero-size one part of it
		if (depth <= 0) {
			const leaf: Spec = { children: [], declarations: itemDeclarations(random, opts) };
			if (chance(random, 0.45)) {
				leaf.text = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
					pick(random, WORDS)
				).join(' ');
				if (chance(random, 0.2)) {
					leaf.declarations['white-space'] = pick(random, ['normal', 'nowrap']);
				}
			}
			return leaf;
		}

		const count = 1 + Math.floor(random() * opts.breadth);
		return {
			children: Array.from({ length: count }, () => node(depth - 1, false)),
			declarations: {
				...containerDeclarations(random),
				...(root ? {} : itemDeclarations(random, opts)),
			},
		};
	};

	return node(opts.depth, true);
}

/** Every node in a tree, as the path of child indices that reaches it. */
function paths(spec: Spec, prefix: number[] = []): number[][] {
	const out: number[][] = [prefix];
	for (const [index, child] of spec.children.entries()) {
		out.push(...paths(child, [...prefix, index]));
	}
	return out;
}

/** A copy of `spec` with `fn` applied to the node at `path`. */
function replace(
	spec: Spec,
	path: number[],
	fn: (node: Spec) => Spec | undefined
): Spec | undefined {
	if (path.length === 0) {
		return fn(spec);
	}
	const [index, ...rest] = path;
	const child = replace(spec.children[index], rest, fn);
	const children = [...spec.children];
	if (child === undefined) {
		children.splice(index, 1);
	} else {
		children[index] = child;
	}
	return { ...spec, children };
}

/**
 * Cuts a failing tree down to the smallest one that still fails.
 *
 * A generated tree is forty nodes carrying two hundred declarations, of which
 * three matter. Reporting the whole of it is reporting noise, and the reader
 * then does this by hand.
 *
 * Greedy and repeated to a fixed point: every candidate is strictly smaller, so
 * this ends. Each candidate is re-checked with the same predicate that failed,
 * which is what keeps the result a real repro rather than a guess at one.
 *
 * @param spec - The tree that failed.
 * @param fails - Whether a tree still fails. Called many times, so it should
 * lay out and check and nothing else.
 * @returns The smallest failing tree found.
 */
export function shrink(spec: Spec, fails: (candidate: Spec) => boolean): Spec {
	let best = spec;

	for (let pass = 0; pass < 50; pass++) {
		let improved = false;

		for (const path of paths(best)) {
			// a whole subtree, which is the cut that shrinks a tree fastest
			if (path.length > 0) {
				const without = replace(best, path, () => undefined);
				if (without && fails(without)) {
					best = without;
					improved = true;
					break;
				}
			}

			const node = path.reduce((current, index) => current.children[index], best);

			// this node's children, which keeps the node and drops its subtree
			if (node.children.length > 0) {
				const flattened = replace(best, path, (target) => ({ ...target, children: [] }));
				if (flattened && fails(flattened)) {
					best = flattened;
					improved = true;
					break;
				}
			}

			// one declaration at a time, which is what says which one matters
			for (const key of Object.keys(node.declarations)) {
				const dropped = replace(best, path, (target) => {
					const declarations = { ...target.declarations };
					delete declarations[key];
					return { ...target, declarations };
				});
				if (dropped && fails(dropped)) {
					best = dropped;
					improved = true;
					break;
				}
			}
			if (improved) {
				break;
			}

			// the text, which is a leaf's whole measurement
			if (node.text !== undefined && node.text !== 'x') {
				const shorter = replace(best, path, (target) => ({ ...target, text: 'x' }));
				if (shorter && fails(shorter)) {
					best = shorter;
					improved = true;
					break;
				}
			}
		}

		if (!improved) {
			break;
		}
	}

	return best;
}

/**
 * A tree written as the `box()` and `text()` calls that build it, so a failure
 * prints something that can be pasted into `layout.test.ts` as a regression
 * test.
 *
 * @param spec - The tree.
 * @param indent - How far in to start.
 * @returns The source.
 */
export function source(spec: Spec, indent = ''): string {
	const declarations = Object.entries(spec.declarations)
		.map(([key, value]) => `${/^[a-z]+$/.test(key) ? key : `'${key}'`}: '${value}'`)
		.join(', ');
	const braces = declarations ? `{ ${declarations} }` : '{}';

	if (spec.text !== undefined) {
		return `${indent}text('${spec.text}', ${braces})`;
	}
	if (spec.children.length === 0) {
		return `${indent}box(${braces})`;
	}

	const children = spec.children.map((child) => source(child, `${indent}\t`)).join(',\n');
	return `${indent}box(${braces},\n${children}\n${indent})`;
}
