/**
 * Style invalidation: what a signal change actually restyles.
 *
 * A signal changes; something has to decide how little work that implies.
 *
 * | What changed | What has to re-run |
 * | -- | -- |
 * | a prop on one element | that element's paint |
 * | `color` via the sheet | that element's paint |
 * | `width` via the sheet | that subtree's layout, then paint |
 * | a class on one element | restyle it, and anything a selector relates to it |
 * | a child added or removed | its siblings too, sideways |
 * | the terminal resized | everything, media queries included |
 *
 * ```js
 * const restyler = new Restyler(cascade);
 * restyler.update(root);           // the first frame: everything
 * restyler.touchProps(button);     // a prop write
 * restyler.update(root);           // one element repainted, nothing restyled
 * ```
 *
 * **Start naive, expect naive to win permanently, and measure before believing
 * otherwise.** Browsers answer class invalidation with invalidation sets --
 * precompute, per rule, which elements a change to a given class could possibly
 * affect -- because they have ten thousand elements and ten thousand rules. A
 * terminal UI is on the order of two hundred and one hundred, which is a full
 * re-match of about twenty thousand cheap comparisons, well under a millisecond,
 * at most once per frame. `test/style/invalidate.test.ts` measures it rather
 * than asserting it.
 *
 * What must not happen is an architecture where the optimization could not be
 * added if the measurement surprises us. The seam is `#restyle()`: it is handed
 * the set of elements to re-resolve, and narrowing that set is the whole of what
 * an invalidation set would do.
 */

import { applyProps, type Cascade, type CascadeResult, type PropValues } from './cascade.js';
import { LAYOUT_PROPERTIES, type PropertyName, PROPERTY_NAMES, type Style } from './properties.js';
import type { StyleNode } from './selector.js';

/**
 * An element, as the invalidator needs it: a `StyleNode` that also carries its
 * props and its children.
 *
 * Still not the element tree, for the reason the selector engine gives. The
 * element tree will satisfy this; so will a literal in a test.
 */
export interface StyleTarget extends StyleNode {
	readonly children?: readonly StyleTarget[];
	readonly parent?: StyleTarget;
	/** What the component wrote directly, which overrides the sheet per property. */
	readonly props?: PropValues;
}

/**
 * The three dirty bits, each implying the ones after it.
 *
 * A style change can move a box, so it implies layout; a layout change moves
 * what is on screen, so it implies paint. The frame loop settles them in that
 * order: restyle, re-layout, repaint, diff, write.
 */
export type Dirty = 'layout' | 'paint' | 'style';

/**
 * The bits in the order a frame settles them, which is also the order they
 * imply each other in: everything a `style` change dirties, a `layout` change
 * dirties too, and so on rightwards.
 */
export const DIRTY_ORDER: readonly Dirty[] = ['style', 'layout', 'paint'];

/** What one `update()` decided. */
export interface Update {
	/** Elements whose box may have moved. */
	readonly layout: ReadonlySet<StyleTarget>;
	/** Elements whose cells may have changed. */
	readonly paint: ReadonlySet<StyleTarget>;
	/** How many elements were re-resolved. The number the naive claim is about. */
	readonly restyled: number;
}

/**
 * Holds each element's resolved style, and works out what a change implies.
 */
export class Restyler {
	readonly #cascade: Cascade;
	/** The sheet-resolved result per element, which is what the prop fast path reuses. */
	readonly #results = new Map<StyleTarget, CascadeResult>();
	readonly #styles = new Map<StyleTarget, Style>();
	/** Elements whose resolved style has to be recomputed. */
	#style = new Set<StyleTarget>();
	/** Elements that need repainting for a reason that is not a style change. */
	#paint = new Set<StyleTarget>();
	/** Everything is stale: the sheets changed, or the terminal did. */
	#all = true;

	constructor(cascade: Cascade) {
		this.#cascade = cascade;
	}

	/** The style an element last resolved to, if it has been through an update. */
	styleOf(node: StyleTarget): Style | undefined {
		return this.#styles.get(node);
	}

	/**
	 * A prop was written.
	 *
	 * The common case, and it costs nothing. Props override the sheet per
	 * property and there are no attribute selectors, so writing a prop cannot
	 * change any other element's resolved style -- there is no rule that could
	 * have matched differently. So this does not restyle: it re-applies props
	 * over the kept `CascadeResult` and marks paint.
	 *
	 * @param node - The element whose props changed.
	 */
	touchProps(node: StyleTarget): void {
		this.#paint.add(node);
	}

	/**
	 * A class, an id, or a state changed on an element.
	 *
	 * The case that is left, and the price of keeping combinators:
	 * `.form.invalid .hint { color: red }` means toggling a class on an ancestor
	 * restyles descendants that never changed. Naive is the answer -- the subtree
	 * is restyled, because a combinator can only reach downwards or sideways from
	 * here, never up.
	 *
	 * @param node - The element that changed.
	 */
	touchClasses(node: StyleTarget): void {
		this.#markSubtree(node);
		// sideways as well: `:nth-child()` and `+`/`~` mean a sibling's match can
		// depend on this one. Cheaper than it looks -- a parent's other children,
		// not the whole tree
		this.#markSiblings(node);
	}

	/**
	 * A child was added to or removed from an element.
	 *
	 * This invalidates *sideways*, which is the case that is easy to forget and
	 * visible immediately when wrong: `:nth-child()` and the sibling combinators
	 * mean inserting a child changes what its siblings match, and none of those
	 * siblings changed in any way an element-level check would see.
	 *
	 * @param parent - The element whose children changed.
	 */
	touchChildren(parent: StyleTarget): void {
		this.#markSubtree(parent);
	}

	/** The stylesheets changed. Everything is stale. */
	touchSheets(): void {
		this.#all = true;
	}

	/**
	 * The terminal resized.
	 *
	 * Everything, media queries included: a rule that was inside
	 * `@media (min-width: 100)` may now apply or may now not, and which elements
	 * those are is exactly the question a full re-match answers.
	 */
	touchSize(): void {
		this.#all = true;
	}

	/**
	 * Settles everything marked since the last call.
	 *
	 * @param root - The root of the tree.
	 * @returns What needs laying out and what needs painting.
	 */
	update(root: StyleTarget): Update {
		const layout = new Set<StyleTarget>();
		const paint = new Set<StyleTarget>();
		const wanted = this.#all ? undefined : this.#style;

		let restyled = 0;

		// walked from the root in document order, because a child's inherited
		// values come from its parent's resolved style and the parent has to have
		// been resolved first. This is also why an element is never restyled
		// without its subtree: inheritance flows down
		const walk = (node: StyleTarget, parent: Style | undefined, forced: boolean): void => {
			const mine = forced || wanted === undefined || wanted.has(node);
			let style = this.#styles.get(node);

			if (mine || style === undefined) {
				const before = style;
				style = this.#resolve(node, parent);
				restyled++;

				const changed = before === undefined ? ALL : difference(before, style);
				if (changed.length > 0) {
					paint.add(node);
					if (changed.some((property) => LAYOUT_PROPERTIES.has(property))) {
						layout.add(node);
					}
				}
			}

			for (const child of node.children ?? []) {
				// a parent that was restyled forces its children, because what they
				// inherit may have changed and nothing else would have told them
				walk(child, style, mine);
			}
		};

		walk(root, undefined, false);

		// a prop write does not restyle, so its element is painted without ever
		// having been compared -- which is the whole point of the fast path
		for (const node of this.#paint) {
			const result = this.#results.get(node);
			if (result) {
				this.#styles.set(node, applyProps(result, node.props ?? {}, this.#parentStyle(node)));
			}
			paint.add(node);
		}

		this.#style = new Set();
		this.#paint = new Set();
		this.#all = false;

		return { layout, paint, restyled };
	}

	/** Resolves one element and keeps both halves of the answer. */
	#resolve(node: StyleTarget, parent: Style | undefined): Style {
		const result = this.#cascade.resolveSheets(node, parent);
		this.#results.set(node, result);
		const style = node.props ? applyProps(result, node.props, parent) : result.style;
		this.#styles.set(node, style);
		return style;
	}

	#parentStyle(node: StyleTarget): Style | undefined {
		return node.parent ? this.#styles.get(node.parent) : undefined;
	}

	#markSubtree(node: StyleTarget): void {
		this.#style.add(node);
		for (const child of node.children ?? []) {
			this.#markSubtree(child);
		}
	}

	#markSiblings(node: StyleTarget): void {
		for (const sibling of node.parent?.children ?? []) {
			if (sibling !== node) {
				this.#markSubtree(sibling);
			}
		}
	}
}

/** Every property, for the first time an element is resolved. */
const ALL: readonly PropertyName[] = PROPERTY_NAMES;

/**
 * Which properties two styles disagree about.
 *
 * Compared by value rather than by identity: a `Length` is an object, and two
 * resolutions of `width: 4` produce two equal objects. Comparing by identity
 * would report every property as changed on every restyle, which would make the
 * dirty bits mean nothing.
 *
 * @param before - The old style.
 * @param after - The new style.
 * @returns The properties that differ.
 */
export function difference(before: Style, after: Style): PropertyName[] {
	const out: PropertyName[] = [];

	for (const property of PROPERTY_NAMES) {
		const a = before[property];
		const b = after[property];
		if (a === b) {
			continue;
		}
		// the only non-primitive a style holds is a Length, which is four shapes of
		// `{ type, value? }` -- shallow is enough and `JSON.stringify` on a hot
		// path is not
		if (
			typeof a === 'object' &&
			typeof b === 'object' &&
			a !== null &&
			b !== null &&
			(a as { type: string }).type === (b as { type: string }).type &&
			(a as { value?: number }).value === (b as { value?: number }).value
		) {
			continue;
		}
		out.push(property);
	}

	return out;
}
