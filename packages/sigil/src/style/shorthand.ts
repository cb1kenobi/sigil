import { type PropertyName, PROPERTIES, registerShorthandLookup } from './properties.js';
import { parts, StyleError } from './value.js';

/**
 * Shorthands, expanded into longhands before anything else looks at them.
 *
 * A table rather than a parser per shorthand. Every one of these is either "one
 * to four values in the CSS edge order" or "a fixed list of parts" -- writing
 * each as its own function would be the same twenty lines eight times, and the
 * thing most likely to drift is the edge order, which is worth having in exactly
 * one place.
 *
 * Not having shorthands at all was the alternative. It is less code and it makes
 * a stylesheet miserable to write: `padding: 1 2` is the spelling everybody
 * knows, and four longhands to say it is four chances to get one wrong.
 */

/** The CSS edge order, which is the thing worth writing down once. */
type Edges = [top: PropertyName, right: PropertyName, bottom: PropertyName, left: PropertyName];

/**
 * One to four values, top-right-bottom-left, filled in the way CSS fills them:
 * one value is every edge, two are vertical then horizontal, three leave the
 * left to match the right.
 *
 * @param values - What was written.
 * @param edges - The longhands, in edge order.
 * @param name - The shorthand, for the message.
 * @returns The longhand declarations, still as source text.
 */
function edges(values: string[], edgeNames: Edges, name: string): [PropertyName, string][] {
	const [top, right, bottom, left] = edgeNames;

	switch (values.length) {
		case 1:
			return [
				[top, values[0]],
				[right, values[0]],
				[bottom, values[0]],
				[left, values[0]],
			];
		case 2:
			return [
				[top, values[0]],
				[right, values[1]],
				[bottom, values[0]],
				[left, values[1]],
			];
		case 3:
			return [
				[top, values[0]],
				[right, values[1]],
				[bottom, values[2]],
				[left, values[1]],
			];
		case 4:
			return [
				[top, values[0]],
				[right, values[1]],
				[bottom, values[2]],
				[left, values[3]],
			];
		default:
			throw new StyleError(`Invalid ${name}: expected one to four values`);
	}
}

const PADDING: Edges = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
const MARGIN: Edges = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'];
const INSET: Edges = ['top', 'right', 'bottom', 'left'];
const GAP: readonly PropertyName[] = ['rowGap', 'columnGap'];
const BORDER: readonly PropertyName[] = ['borderStyle', 'borderColor'];
const FLEX: readonly PropertyName[] = ['flexGrow', 'flexShrink', 'flexBasis'];
const FLEX_FLOW: readonly PropertyName[] = ['flexDirection', 'flexWrap'];
const TRANSITION: readonly PropertyName[] = [
	'transitionProperty',
	'transitionDuration',
	'transitionTimingFunction',
	'transitionDelay',
];
const ANIMATION: readonly PropertyName[] = [
	'animationName',
	'animationDuration',
	'animationTimingFunction',
	'animationDelay',
	'animationIterationCount',
	'animationDirection',
	'animationFillMode',
];

type Expander = (values: string[]) => [PropertyName, string][];

/**
 * A shorthand: the longhands it covers, and how it reads a value into them.
 *
 * The two are one entry rather than two tables, for the reason the property
 * table gives: a shorthand is added in one place or it is added wrong. The
 * longhand list is the fixed set the shorthand *covers*, which is not what one
 * use of it happens to mention -- a shorthand resets every longhand it covers,
 * and `inherit` needs the whole set before any value has been read.
 */
interface Shorthand {
	readonly expand: Expander;
	readonly longhands: readonly PropertyName[];
}

/** Builds one entry, so that each reads as a list and a reader. */
function shorthand(longhands: readonly PropertyName[], expand: Expander): Shorthand {
	return { expand, longhands };
}

/**
 * Every shorthand name.
 *
 * Written out rather than read off the table with `keyof`, and that is not the
 * duplication it looks like: the declaration emitter cannot write the table's
 * literal type -- it widens to `Record<string, Shorthand>` -- so a `keyof` of
 * it is `string` in the *published* types while being a union inside the
 * package. The JSX prop types read this, so a mapped type over it would have
 * silently become an index signature and let every misspelled prop through,
 * which is the bug it was written to prevent, arriving through the build.
 *
 * The table is annotated with this union, so a shorthand added to one and not
 * the other does not compile: a missing key is an error and an extra one is an
 * error. One fact, checked, in two places that cannot drift apart.
 */
export type ShorthandName =
	| 'animation'
	| 'border'
	| 'flex'
	| 'flex-flow'
	| 'gap'
	| 'inset'
	| 'margin'
	| 'padding'
	| 'transition';

const SHORTHANDS = {
	padding: shorthand(PADDING, (v) => edges(v, PADDING, 'padding')),
	margin: shorthand(MARGIN, (v) => edges(v, MARGIN, 'margin')),
	inset: shorthand(INSET, (v) => edges(v, INSET, 'inset')),

	gap: shorthand(GAP, (v) => {
		if (v.length === 1) {
			return [
				['rowGap', v[0]],
				['columnGap', v[0]],
			];
		}
		if (v.length === 2) {
			return [
				['rowGap', v[0]],
				['columnGap', v[1]],
			];
		}
		throw new StyleError('Invalid gap: expected one or two values');
	}),

	/**
	 * `border: <style> <color>`, in either order and either alone.
	 *
	 * No width. A terminal border is one cell and cannot be anything else, so a
	 * width would be a number with exactly one legal value.
	 */
	// `none` is the one ambiguous token: a valid border-style *and* a valid way to
	// spell "no colour". Style wins, because the first position is the style's
	border: shorthand(BORDER, (v) => {
		if (v.length === 0 || v.length > 2) {
			throw new StyleError('Invalid border: expected a style, a colour, or both');
		}

		const out: [PropertyName, string][] = [];
		let sawStyle = false;
		let sawColor = false;

		for (const part of v) {
			let isStyle = false;
			try {
				PROPERTIES.borderStyle.parse(part);
				isStyle = true;
			} catch {
				isStyle = false;
			}

			if (isStyle && !sawStyle) {
				sawStyle = true;
				out.push(['borderStyle', part]);
				continue;
			}

			if (sawColor) {
				throw new StyleError(`Invalid border "${v.join(' ')}": two colours`);
			}
			// left for the colour parser to reject, so the message names the colour
			// rather than the shorthand
			sawColor = true;
			out.push(['borderColor', part]);
		}

		// a border given only a colour is still a border, which is the one thing
		// CSS gets wrong here: `border-color` alone draws nothing
		if (!sawStyle) {
			out.unshift(['borderStyle', 'single']);
		}

		// a shorthand resets every longhand it covers, including the ones this use
		// did not mention. That is what makes `border: single` after a
		// `border-color: red` mean what it looks like it means
		if (!sawColor) {
			out.push(['borderColor', 'default']);
		}

		return out;
	}),

	/**
	 * `flex: <grow> <shrink> <basis>`, with the CSS shorthand's defaults.
	 *
	 * `flex: 1` means grow 1, shrink 1, basis 0 -- not basis auto. That surprises
	 * people every time and it is the behavior everyone's muscle memory expects,
	 * so it is what this does.
	 */
	flex: shorthand(FLEX, (v) => {
		if (v.length === 0 || v.length > 3) {
			throw new StyleError('Invalid flex: expected one to three values');
		}

		if (v.length === 1) {
			const keyword = v[0].toLowerCase();
			if (keyword === 'none') {
				return [
					['flexGrow', '0'],
					['flexShrink', '0'],
					['flexBasis', 'auto'],
				];
			}
			if (keyword === 'initial') {
				return [
					['flexGrow', '0'],
					['flexShrink', '1'],
					['flexBasis', 'auto'],
				];
			}
		}

		// CSS is `none | [ <grow> <shrink>? || <basis> ]`, so a part that is a
		// length rather than a plain number is the basis wherever it sits.
		// `flex: auto` is the second most typed value after `flex: 1` and used to
		// throw as an invalid grow factor
		const numbers: string[] = [];
		let basis: string | undefined;

		for (const part of v) {
			if (NUMBER.test(part)) {
				numbers.push(part);
				continue;
			}
			if (basis === undefined && accepts('flexBasis', part)) {
				basis = part;
				continue;
			}
			throw new StyleError(`Invalid flex "${v.join(' ')}"`);
		}

		return [
			['flexGrow', numbers[0] ?? '1'],
			['flexShrink', numbers[1] ?? '1'],
			// a bare `<number>` sets the basis to zero, which is the well-known
			// "why doesn't flex: 1 behave the way I think" gotcha and is what
			// everybody's muscle memory expects
			['flexBasis', basis ?? (numbers.length > 0 ? '0' : 'auto')],
		];
	}),

	/**
	 * `<flex-direction> || <flex-wrap>` -- either alone, in either order, which is
	 * what CSS says and what the error message already promised. Only the
	 * positional form was read, so `flex-flow: wrap` was rejected as an invalid
	 * direction.
	 */
	'flex-flow': shorthand(FLEX_FLOW, (v) => {
		if (v.length === 0 || v.length > 2) {
			throw new StyleError('Invalid flex-flow: expected a direction, a wrap, or both');
		}

		let direction: string | undefined;
		let wrap: string | undefined;

		for (const part of v) {
			if (direction === undefined && accepts('flexDirection', part)) {
				direction = part;
				continue;
			}
			if (wrap === undefined && accepts('flexWrap', part)) {
				wrap = part;
				continue;
			}
			throw new StyleError(`Invalid flex-flow "${v.join(' ')}"`);
		}

		// the omitted half is reset rather than left alone, for the same reason
		// `border` resets its colour
		return [
			['flexDirection', direction ?? 'row'],
			['flexWrap', wrap ?? 'nowrap'],
		];
	}),

	/**
	 * `<property> || <duration> || <timing-function> || <delay>`, in any order,
	 * with the first time being the duration and the second the delay.
	 *
	 * **A time in a shorthand carries its unit**, which is the one divergence from
	 * the longhands, where a bare number is milliseconds. It is forced rather than
	 * chosen: a bare number in `animation` is CSS's iteration count, so one
	 * grammar cannot have both, and the two shorthands agreeing about it is worth
	 * more than `transition: width 300` saving two characters.
	 */
	transition: shorthand(TRANSITION, (v) => {
		noList(v, 'transition');

		let property: string | undefined;
		let duration: string | undefined;
		let delay: string | undefined;
		let timing: string | undefined;

		for (const part of v) {
			if (TIME.test(part)) {
				if (duration === undefined) {
					duration = part;
				} else if (delay === undefined) {
					delay = part;
				} else {
					throw new StyleError(
						`Invalid transition "${v.join(' ')}": a transition has a duration and a delay, and no third time`
					);
				}
				continue;
			}
			if (timing === undefined && accepts('transitionTimingFunction', part)) {
				timing = part;
				continue;
			}
			if (property === undefined && accepts('transitionProperty', part)) {
				property = part;
				continue;
			}
			throw bareTime(part, `Invalid transition "${v.join(' ')}"`);
		}

		// every longhand reset, including the ones this use did not mention, which
		// is the shorthand rule `border` and `flex-flow` already follow
		return [
			['transitionProperty', property ?? 'all'],
			['transitionDuration', duration ?? '0s'],
			['transitionTimingFunction', timing ?? 'linear'],
			['transitionDelay', delay ?? '0s'],
		];
	}),

	/**
	 * `<duration> || <timing-function> || <delay> || <iteration-count> ||
	 * <direction> || <fill-mode> || <name>`, in any order.
	 *
	 * An identifier is tried as a direction, then a fill mode, then the name --
	 * which means `@keyframes normal` cannot be started from the shorthand, the
	 * same reservation CSS has and for the same reason. `animation-name: normal`
	 * still reaches it.
	 */
	animation: shorthand(ANIMATION, (v) => {
		noList(v, 'animation');

		let name: string | undefined;
		let duration: string | undefined;
		let delay: string | undefined;
		let timing: string | undefined;
		let iterations: string | undefined;
		let direction: string | undefined;
		let fill: string | undefined;

		for (const part of v) {
			if (TIME.test(part)) {
				if (duration === undefined) {
					duration = part;
				} else if (delay === undefined) {
					delay = part;
				} else {
					throw new StyleError(
						`Invalid animation "${v.join(' ')}": an animation has a duration and a delay, and no third time`
					);
				}
				continue;
			}
			if (iterations === undefined && COUNT.test(part)) {
				iterations = part;
				continue;
			}
			if (timing === undefined && accepts('animationTimingFunction', part)) {
				timing = part;
				continue;
			}
			if (direction === undefined && accepts('animationDirection', part)) {
				direction = part;
				continue;
			}
			if (fill === undefined && accepts('animationFillMode', part)) {
				fill = part;
				continue;
			}
			if (name === undefined && accepts('animationName', part)) {
				name = part;
				continue;
			}
			throw bareTime(part, `Invalid animation "${v.join(' ')}"`);
		}

		return [
			['animationName', name ?? 'none'],
			['animationDuration', duration ?? '0s'],
			['animationTimingFunction', timing ?? 'linear'],
			['animationDelay', delay ?? '0s'],
			['animationIterationCount', iterations ?? '1'],
			['animationDirection', direction ?? 'normal'],
			['animationFillMode', fill ?? 'none'],
		];
	}),
} satisfies { readonly [K in ShorthandName]: Shorthand };

/** A time with its unit, which is what a shorthand requires. */
const TIME = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?m?s$/i;

/** A bare number, which in `animation` is the iteration count. */
const COUNT = /^(?:infinite|\d+(?:\.\d+)?|\.\d+)$/i;

/**
 * The message for a part that is a bare number where a time was meant.
 *
 * Worth its own branch because it is the mistake the unit rule above creates,
 * and "invalid animation" on its own sends the reader looking at the keyframes.
 */
function bareTime(part: string, prefix: string): StyleError {
	if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(part)) {
		return new StyleError(
			`${prefix}: "${part}" needs a unit here -- write ${part}ms or ${part}s, because a bare number in a shorthand is an iteration count`
		);
	}
	return new StyleError(`${prefix}: "${part}" is not part of it`);
}

/**
 * Refuses a comma-separated list of transitions or animations.
 *
 * CSS lets both take a list, where every longhand holds a list of its own and
 * the shorter ones repeat to the length of the first. What that costs here is
 * eleven array-valued properties, a second comparison path in `difference()`,
 * and a repetition rule; what it buys is a per-property duration, which in a
 * terminal is rare enough that nobody has asked. So the list is **refused where
 * it is written** rather than taken as its first entry, which is the rule an
 * unknown property in a stylesheet already follows -- a declaration whose second
 * half was silently dropped is worse than one that did not parse.
 *
 * Several properties at one duration is still expressible, because
 * `transition-property` is itself a list.
 */
function noList(values: readonly string[], name: string): void {
	let depth = 0;
	for (const part of values) {
		for (const ch of part) {
			if (ch === '(') {
				depth++;
			} else if (ch === ')') {
				depth--;
			} else if (ch === ',' && depth === 0) {
				throw new StyleError(
					`Invalid ${name} "${values.join(' ')}": one ${name} at a time -- a comma-separated list is not read here, and several properties at one duration is "${name}-property: a, b"`
				);
			}
		}
	}
}

/** A plain `<number>`, for telling a flex factor from a basis. */
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Whether a property would accept a value, used to tell one part of a shorthand
 * from another without duplicating either one's grammar.
 *
 * @param property - The longhand to ask.
 * @param value - The part.
 * @returns Whether it parses.
 */
function accepts(property: PropertyName, value: string): boolean {
	try {
		PROPERTIES[property].parse(value);
		return true;
	} catch {
		return false;
	}
}

/** The shorthand a name refers to, in either spelling and any case. */
function shorthandFor(name: string): Shorthand | undefined {
	const trimmed = name.trim();
	const kebab = trimmed.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
	for (const candidate of [trimmed.toLowerCase(), kebab.toLowerCase()]) {
		if (Object.hasOwn(SHORTHANDS, candidate)) {
			return SHORTHANDS[candidate as ShorthandName];
		}
	}
	return undefined;
}

/** Whether a name is a shorthand rather than a property. */
export function isShorthand(name: string): boolean {
	return shorthandFor(name) !== undefined;
}

// null-prototype, for the reason AGENTS.md gives under Conventions: on a plain
// object `__proto__` and `constructor` read back truthy, so `isShorthand`
// answered yes and the expander lookup then handed back something that is not a
// function. Set here rather than written as a `__proto__` key in the literal,
// because that key makes TypeScript type the literal as `Record<string,
// Shorthand>` -- which is what the `as unknown as` cast this replaced was for,
// and what made `keyof` useless. The literal's own keys are what checks
// `ShorthandName`, so they have to survive
Object.setPrototypeOf(SHORTHANDS, null);

/** Every shorthand, for documentation and for tests that walk them. */
export const SHORTHAND_NAMES: readonly ShorthandName[] = Object.keys(SHORTHANDS) as ShorthandName[];

/**
 * Expands a shorthand into the declarations it stands for, still as source text
 * -- the longhand parsers do the reading, so a bad value is reported against the
 * property it belongs to rather than against the shorthand.
 *
 * @param name - The shorthand.
 * @param value - The value, as written.
 * @returns The longhand declarations.
 */
export function expandShorthand(name: string, value: string): [PropertyName, string][] {
	const entry = shorthandFor(name);
	if (!entry) {
		throw new StyleError(`"${name}" is not a shorthand`);
	}
	return entry.expand(parts(value));
}

/**
 * The longhands a shorthand covers, whatever a given use of it mentions.
 *
 * Asked by the cascade, which has to expand `padding: inherit` into four
 * properties without a value for any parser to read.
 *
 * @param name - The shorthand, in either spelling and any case.
 * @returns The longhands, or `undefined` if the name is not a shorthand.
 */
export function shorthandLonghands(name: string): readonly PropertyName[] | undefined {
	return shorthandFor(name)?.longhands;
}

// `transition-property: padding` has to reach all four edges, which means the
// property table needs to know what a shorthand covers -- and this module
// imports *that* one, because expanding a shorthand is the longhand parsers
// doing the reading. So the dependency goes the only way it can: a hook, filled
// in here, where the answer is
registerShorthandLookup(shorthandLonghands);
