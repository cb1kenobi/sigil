import { type PropertyName, PROPERTIES } from './properties.js';
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

type Expander = (values: string[]) => [PropertyName, string][];

const SHORTHANDS: Record<string, Expander> = {
	// null-prototype, for the reason AGENTS.md gives under Conventions: on a plain
	// object `__proto__` and `constructor` read back truthy, so `isShorthand`
	// answered yes and the expander lookup then handed back something that is not
	// a function
	__proto__: null,
	padding: (v) => edges(v, PADDING, 'padding'),
	margin: (v) => edges(v, MARGIN, 'margin'),
	inset: (v) => edges(v, INSET, 'inset'),

	gap: (v) => {
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
	},

	/**
	 * `border: <style> <color>`, in either order and either alone.
	 *
	 * No width. A terminal border is one cell and cannot be anything else, so a
	 * width would be a number with exactly one legal value.
	 */
	// `none` is the one ambiguous token: a valid border-style *and* a valid way to
	// spell "no colour". Style wins, because the first position is the style's
	border: (v) => {
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
	},

	/**
	 * `flex: <grow> <shrink> <basis>`, with the CSS shorthand's defaults.
	 *
	 * `flex: 1` means grow 1, shrink 1, basis 0 -- not basis auto. That surprises
	 * people every time and it is the behavior everyone's muscle memory expects,
	 * so it is what this does.
	 */
	flex: (v) => {
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
	},

	/**
	 * `<flex-direction> || <flex-wrap>` -- either alone, in either order, which is
	 * what CSS says and what the error message already promised. Only the
	 * positional form was read, so `flex-flow: wrap` was rejected as an invalid
	 * direction.
	 */
	'flex-flow': (v) => {
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
	},
} as unknown as Record<string, Expander>;

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
function shorthandFor(name: string): Expander | undefined {
	const trimmed = name.trim();
	const kebab = trimmed.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
	for (const candidate of [trimmed.toLowerCase(), kebab.toLowerCase()]) {
		if (Object.hasOwn(SHORTHANDS, candidate)) {
			return SHORTHANDS[candidate];
		}
	}
	return undefined;
}

/** Whether a name is a shorthand rather than a property. */
export function isShorthand(name: string): boolean {
	return shorthandFor(name) !== undefined;
}

/** Every shorthand, for documentation and for tests that walk them. */
export const SHORTHAND_NAMES: readonly string[] = Object.keys(SHORTHANDS);

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
	const expander = shorthandFor(name);
	if (!expander) {
		throw new StyleError(`"${name}" is not a shorthand`);
	}
	return expander(parts(value));
}
