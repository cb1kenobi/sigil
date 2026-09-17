/**
 * The cascade: which declaration wins, and what an element's style ends up as.
 *
 * ```js
 * import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';
 *
 * const cascade = new Cascade([parseStylesheet('.panel:focus { color: cyan }')]);
 * const style = cascade.resolve(node, { parent: parentStyle, props: { padding: '1' } });
 * ```
 *
 * The order is **layer, then origin, then specificity, then source order** --
 * the standard algorithm with the one axis a terminal UI needs added. Inventing
 * a different one buys nothing and costs everyone's intuition.
 */

import type { ColorLevel } from '../ansi/color-support.js';
import { readSettings, resolveKeyword } from './declaration.js';
import { degradeInto } from './degrade.js';
import { inheritFrom, initialStyle, type PropertyName, type Style } from './properties.js';
import {
	compareSpecificity,
	keysFor,
	matches,
	type Selector,
	type Specificity,
	type StyleNode,
} from './selector.js';
import {
	DEFAULT_MEDIA,
	LAYERS,
	matchesMedia,
	type MediaContext,
	ORIGINS,
	type Origin,
	type Rule,
	type Stylesheet,
} from './stylesheet.js';

/**
 * Props, as a component writes them.
 *
 * Read as source text, because that is what every other way into this system
 * takes -- `width={10}` and `width="10"` are the same declaration. A prop set to
 * `undefined` is one the template did not set, so it is skipped rather than read
 * as the word.
 */
export type PropValues = Record<string, boolean | number | string | undefined>;

/**
 * A style resolved from the sheets alone, and what a prop may not overwrite.
 *
 * This is the shape the prop fast path is built on. A sheet supplies defaults
 * and props override them per property, which is where `style=""` sits in a
 * browser -- so a prop write cannot change any *other* element's resolved style,
 * and re-applying props over a result the cascade already produced needs no
 * selector matching at all. The one thing props do not beat is an `!important`
 * declaration, which is the whole point of retaining `!important`; `locked` is
 * how that survives the fast path.
 */
export interface CascadeResult {
	/**
	 * The colour depth this was resolved at.
	 *
	 * Carried on the result rather than passed to `applyProps()` separately: a
	 * prop can name a colour, so the fast path has to degrade too, and a `level`
	 * argument defaulting to truecolor is a fast path that silently disagrees
	 * with `resolve()` on exactly the terminals degradation exists for.
	 */
	readonly colorLevel: ColorLevel;
	readonly locked: ReadonlySet<PropertyName>;
	readonly style: Style;
}

export interface ResolveOptions {
	/** The parent element's resolved style, for inheritance. */
	readonly parent?: Style;
	readonly props?: PropValues;
}

/** A rule that matched, with the specificity of the selector that did it. */
export interface Matched {
	readonly order: number;
	readonly origin: Origin;
	readonly rule: Rule;
	readonly specificity: Specificity;
}

/** One rule filed under one of its selectors' buckets. */
interface Candidate {
	readonly order: number;
	readonly origin: Origin;
	readonly rule: Rule;
	readonly selector: Selector;
}

/**
 * Where a declaration sits in the cascade.
 *
 * Compared field by field, in this order. `band` is what `!important` moves a
 * declaration into, and inside an important band the origin and the layer are
 * read backwards -- an app sheet's `!important` beats a component's props, and
 * within one origin an earlier layer's `!important` beats a later one's. That
 * inversion is CSS's, and it is the reason `!important` is worth keeping: a
 * component copied in by `sigil add` that bakes `color="red"` into its template
 * would otherwise be unthemeable, with no recourse.
 *
 * Specificity and source order are never inverted, which is also CSS.
 */
interface Precedence {
	readonly band: number;
	readonly layer: number;
	readonly order: number;
	readonly origin: number;
	readonly specificity: Specificity;
}

/** Normal declarations from a sheet: the bottom band. */
const NORMAL = 0;
/**
 * `!important`, wherever it came from.
 *
 * Band 1 is props, and nothing here carries it: props are applied after the
 * sheets have been resolved and are gated by `locked`, which says the same
 * thing -- above every normal declaration, below every important one -- while
 * being the fast path rather than another pass over the rules.
 */
const IMPORTANT = 2;

function compare(a: Precedence, b: Precedence): number {
	return (
		a.band - b.band ||
		a.origin - b.origin ||
		a.layer - b.layer ||
		compareSpecificity(a.specificity, b.specificity) ||
		a.order - b.order
	);
}

/**
 * The cascade: a set of stylesheets, and the answer for any one element.
 *
 * Matching is right-to-left and rules are bucketed by their rightmost simple
 * selector, so an element only tests rules that could possibly match it. Worth
 * keeping in proportion: browsers optimize this hard because they have ten
 * thousand elements and ten thousand rules, and a terminal UI has a couple of
 * hundred of each. Naive may simply be the permanent answer.
 */
export class Cascade {
	/** What the media queries are asked about. A renderer sets it on resize. */
	media: MediaContext;

	#buckets: Map<string, Candidate[]> | undefined;
	readonly #sheets: Stylesheet[] = [];

	constructor(sheets: Iterable<Stylesheet> = [], media: MediaContext = DEFAULT_MEDIA) {
		this.media = media;
		for (const sheet of sheets) {
			this.add(sheet);
		}
	}

	get sheets(): readonly Stylesheet[] {
		return this.#sheets;
	}

	/**
	 * Adds a stylesheet. Sheets are in source order, so a sheet added later
	 * breaks ties against one added earlier -- within one origin and layer.
	 *
	 * @param sheet - The sheet.
	 * @returns This cascade, for chaining.
	 */
	add(sheet: Stylesheet): this {
		this.#sheets.push(sheet);
		this.#buckets = undefined;
		return this;
	}

	/**
	 * Every rule that matches an element, once per rule however many of its
	 * selectors matched.
	 *
	 * A rule's selector list behaves as though the rule were written once per
	 * selector, so the specificity reported is the highest among the selectors
	 * that actually matched.
	 *
	 * @param node - The element.
	 * @returns The matched rules, in no particular order.
	 */
	match(node: StyleNode): Matched[] {
		const best = new Map<number, Matched>();

		for (const key of keysFor(node)) {
			for (const candidate of this.#index().get(key) ?? []) {
				const found = best.get(candidate.order);
				if (found && compareSpecificity(found.specificity, candidate.selector.specificity) >= 0) {
					continue;
				}
				if (!matchesMedia(candidate.rule.media, this.media)) {
					continue;
				}
				if (!matches(candidate.selector, node)) {
					continue;
				}
				best.set(candidate.order, {
					order: candidate.order,
					origin: candidate.origin,
					rule: candidate.rule,
					specificity: candidate.selector.specificity,
				});
			}
		}

		return [...best.values()];
	}

	/**
	 * Resolves an element's style from the stylesheets alone.
	 *
	 * @param node - The element.
	 * @param parent - The parent's resolved style, for inheritance.
	 * @returns The style, and the properties props may not overwrite.
	 */
	resolveSheets(node: StyleNode, parent?: Style): CascadeResult {
		const style = (parent ? inheritFrom(parent) : initialStyle()) as Record<PropertyName, unknown>;
		const winners = new Map<PropertyName, Precedence>();
		const locked = new Set<PropertyName>();

		for (const matched of this.match(node)) {
			const layer = LAYERS.indexOf(matched.rule.layer);
			const origin = ORIGINS.indexOf(matched.origin);

			for (const declaration of matched.rule.declarations) {
				const here: Precedence = declaration.important
					? {
							band: IMPORTANT,
							// read backwards inside the important band
							layer: LAYERS.length - 1 - layer,
							order: matched.order,
							origin: ORIGINS.length - 1 - origin,
							specificity: matched.specificity,
						}
					: {
							band: NORMAL,
							layer,
							order: matched.order,
							origin,
							specificity: matched.specificity,
						};

				const winner = winners.get(declaration.property);
				if (winner && compare(here, winner) < 0) {
					continue;
				}

				winners.set(declaration.property, here);
				style[declaration.property] = declaration.keyword
					? resolveKeyword(declaration.keyword, declaration.property, parent)
					: declaration.value;
				if (declaration.important) {
					// nothing outside the important band can take it back, so this only
					// ever grows
					locked.add(declaration.property);
				}
			}
		}

		// the last pass over a resolved style, so nothing downstream ever holds a
		// colour the terminal cannot emit and the diff never compares a colour
		// against its own approximation
		const level = this.media.colorLevel as ColorLevel;
		return { colorLevel: level, locked, style: degradeInto(style as Style, level) };
	}

	/**
	 * Resolves an element's style: the sheets, then its props over the top.
	 *
	 * @param node - The element.
	 * @param opts - The parent's style, and the element's props.
	 * @returns The resolved style.
	 */
	resolve(node: StyleNode, opts: ResolveOptions = {}): Style {
		const result = this.resolveSheets(node, opts.parent);
		// written into in place: the result is freshly built and nothing else holds
		// it, so there is nothing to protect by copying it first
		return opts.props
			? applyPropsInto(result, opts.props, opts.parent, result.style)
			: result.style;
	}

	/** Builds the bucket index, once per change to the sheet set. */
	#index(): Map<string, Candidate[]> {
		if (this.#buckets) {
			return this.#buckets;
		}

		const buckets = new Map<string, Candidate[]>();
		let order = 0;

		for (const sheet of this.#sheets) {
			for (const rule of sheet.rules) {
				const at = order++;
				for (const selector of rule.selectors) {
					const bucket = buckets.get(selector.key);
					const candidate: Candidate = {
						order: at,
						origin: sheet.origin,
						rule,
						selector,
					};
					if (bucket) {
						bucket.push(candidate);
					} else {
						buckets.set(selector.key, [candidate]);
					}
				}
			}
		}

		this.#buckets = buckets;
		return buckets;
	}
}

/**
 * Applies an element's props over a style the cascade already resolved.
 *
 * This is the fast path: a prop write affects nothing but the element it was
 * written on, so re-running this over a kept `CascadeResult` is the whole of the
 * work, with no selector matched and no other element touched.
 *
 * @param result - What the sheets resolved to. It is not modified, so one kept
 * result answers for any number of prop writes.
 * @param props - The element's props.
 * @param parent - The parent's style, which `inherit` in a prop reads.
 * @returns The style, props applied.
 */
export function applyProps(result: CascadeResult, props: PropValues, parent?: Style): Style {
	return applyPropsInto(result, props, parent, { ...result.style });
}

/**
 * Writes props into a style, taking it over.
 *
 * `into` is the caller's to give away: `resolve()` hands over the style it has
 * just built, which nothing else holds, and `applyProps()` hands over a copy so
 * that a kept result answers again.
 */
function applyPropsInto(
	result: CascadeResult,
	props: PropValues,
	parent: Style | undefined,
	into: Style
): Style {
	const { colorLevel: level, locked } = result;
	const target = into;
	const style = target as Record<PropertyName, unknown>;

	for (const [name, raw] of Object.entries(props)) {
		if (raw === undefined) {
			continue;
		}
		for (const setting of readSettings(name, String(raw))) {
			// an `!important` declaration outranks every prop, which is what makes a
			// component that bakes a value into its template themeable at all
			if (locked.has(setting.property)) {
				continue;
			}
			style[setting.property] = setting.keyword
				? resolveKeyword(setting.keyword, setting.property, parent)
				: setting.value;
		}
	}

	// a prop can name a colour too, so the fast path degrades as well -- three
	// memoized lookups, which is what keeps it a fast path
	return degradeInto(style as Style, level);
}
