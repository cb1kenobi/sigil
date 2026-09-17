import { type Color, DEFAULT_COLOR, palette, rgb } from '../canvas/style.js';

/**
 * The value types a declaration can hold, and how each is read from source.
 *
 * There is exactly one unit, and it is a cell. A terminal has no other: the cell
 * size is the user's, set in their terminal's preferences, and not ours to ask
 * about. Anything sub-cell -- a fractional length, a radius, a shadow -- cannot
 * be drawn, so it is not a value this system can hold.
 */

/**
 * A length: whole cells, a share of the parent, "work it out", or "no limit".
 *
 * `auto` and `none` are different questions and need different answers.
 * `width: auto` means size to content; `max-width: none` means unbounded. Using
 * one sentinel for both makes `max-width: none` -- an ordinary declaration --
 * inexpressible.
 */
export type Length =
	| { readonly type: 'auto' }
	| { readonly type: 'cells'; readonly value: number }
	| { readonly type: 'none' }
	| { readonly type: 'percent'; readonly value: number };

/**
 * Frozen, and so is everything `cells()` and `percent()` build.
 *
 * `readonly` is a TypeScript fiction at runtime, and one shared `AUTO` is the
 * initial value of ten properties -- so a single in-place mutation anywhere
 * downstream (the obvious optimization in a layout resolver) rewrites `width`,
 * `height`, every `min`/`max`, `flex-basis`, and all four insets, on every style
 * in the process. `canvas/style.ts` freezes interned styles for exactly this
 * reason; so does this.
 */
export const AUTO: Length = Object.freeze({ type: 'auto' });

/** No limit. The initial value of `max-width` and `max-height`. */
export const NONE: Length = Object.freeze({ type: 'none' });

/**
 * A length in whole cells.
 *
 * @param value - The number of cells. Truncated, because half a cell is not a
 * thing a terminal can draw and rounding it silently is how a layout ends up
 * one column out with nobody able to say where.
 * @returns The length.
 */
export function cells(value: number): Length {
	return Object.freeze({ type: 'cells', value: Math.trunc(value) });
}

/**
 * A length as a share of the parent.
 *
 * @param value - The percentage.
 * @returns The length.
 */
export function percent(value: number): Length {
	return Object.freeze({ type: 'percent', value });
}

/**
 * Whether a string holds nothing a number could be read from.
 *
 * `Number('')` and `Number(' ')` are both `0`, so every numeric parser here has
 * to refuse an empty value before it asks. The parser's data types learned the
 * same lesson -- see the entry about `number` and `int` in AGENTS.md -- and
 * `50%` minus its sign is exactly the string that reaches this.
 *
 * @param text - The candidate.
 * @returns Whether there is nothing there.
 */
function blank(text: string): boolean {
	return text.trim() === '';
}

/**
 * A CSS `<number>` and nothing else.
 *
 * `Number()` on its own accepts `0x10`, which is not CSS syntax and is not
 * something a stylesheet author meant -- the parser's own `int` type takes hex
 * deliberately, for CLI arguments, and it should not leak in here by accident of
 * reaching for the same function.
 */
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Reads a number, refusing what `Number()` would quietly accept or quietly get
 * wrong.
 *
 * Past 2^53-1 a decimal integer comes back as a *different* integer --
 * `Number('9007199254740993')` is `...992` -- which is the one failure a caller
 * cannot detect. The parser's data types already carry an entry about this;
 * rediscovering it here would have been the second time.
 *
 * @param text - The source text.
 * @returns The number, or `undefined` if it is not one.
 */
function readNumber(text: string): number | undefined {
	const trimmed = text.trim();
	if (!NUMBER.test(trimmed)) {
		return undefined;
	}
	const value = Number(trimmed);
	if (!Number.isFinite(value)) {
		return undefined;
	}
	if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
		return undefined;
	}
	// `-0` is a number nobody writes on purpose, and it compares unequal to `0`
	// under `Object.is` -- which is what a deep-equality assertion uses
	return value + 0;
}

/**
 * What counts as true and what counts as false.
 *
 * The same vocabulary `transformValue()`'s `bool` uses, because AGENTS.md
 * documents it as "strict and symmetric" and a second, narrower spelling of the
 * same idea in a sibling module is how two parts of one library come to disagree
 * about what `on` means. The empty string is false rather than an error, which
 * is that rule's sharpest edge and the one most easily lost.
 */
const TRUE = /^(?:true|t|yes|y|on|1)$/i;
const FALSE = /^(?:false|f|no|n|off|0|)$/i;

/**
 * Reads a boolean.
 *
 * @param input - The source text.
 * @param name - The property, for the message.
 * @returns The value.
 */
export function parseBoolean(input: string, name: string): boolean {
	const text = input.trim();
	if (TRUE.test(text)) {
		return true;
	}
	if (FALSE.test(text)) {
		return false;
	}
	throw new StyleError(`Invalid ${name} "${input}": expected true or false`);
}

/** Thrown when a declaration cannot be read. Carries what was wrong, for help. */
export class StyleError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'StyleError';
	}
}

/**
 * The sixteen colours a terminal has had since the beginning, by the names
 * people actually type.
 *
 * These are palette indices rather than RGB on purpose: the basic sixteen are
 * whatever the user's terminal theme says they are, and resolving `red` to a
 * specific RGB would override a choice the user already made.
 */
const NAMED: Record<string, number> = {
	// null-prototype, for the reason AGENTS.md gives under Conventions: on a plain
	// object `constructor` reads back truthy, so `parseColor('constructor')`
	// reached `palette()` with the Object constructor
	__proto__: null,
	black: 0,
	red: 1,
	green: 2,
	yellow: 3,
	blue: 4,
	magenta: 5,
	cyan: 6,
	white: 7,
	gray: 8,
	grey: 8,
	brightblack: 8,
	brightred: 9,
	brightgreen: 10,
	brightyellow: 11,
	brightblue: 12,
	brightmagenta: 13,
	brightcyan: 14,
	brightwhite: 15,
} as unknown as Record<string, number>;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_FN = /^rgb\(\s*(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)\s*\)$/i;
const PALETTE_FN = /^(?:ansi|palette)\(\s*(\d+)\s*\)$/i;

/**
 * Reads a colour.
 *
 * `inherit` and `currentcolor` are not handled here -- they are cascade-level
 * keywords and mean nothing to a value parser.
 *
 * @param input - The source text.
 * @returns The colour.
 */
export function parseColor(input: string): Color {
	const text = input.trim();
	const lower = text.toLowerCase();

	if (lower === 'default' || lower === 'transparent' || lower === 'none') {
		return DEFAULT_COLOR;
	}

	if (Object.hasOwn(NAMED, lower)) {
		return palette(NAMED[lower]);
	}

	if (HEX.test(text)) {
		const hex = text.slice(1);
		const full =
			hex.length === 3
				? hex
						.split('')
						.map((c) => c + c)
						.join('')
				: hex;
		return rgb(
			Number.parseInt(full.slice(0, 2), 16),
			Number.parseInt(full.slice(2, 4), 16),
			Number.parseInt(full.slice(4, 6), 16)
		);
	}

	const fn = RGB_FN.exec(text);
	if (fn) {
		const parts = [fn[1], fn[2], fn[3]].map(Number);
		if (parts.some((n) => n < 0 || n > 255)) {
			throw new StyleError(`Colour channel out of range in "${text}": each must be 0-255`);
		}
		return rgb(parts[0], parts[1], parts[2]);
	}

	const indexed = PALETTE_FN.exec(text);
	if (indexed) {
		const index = Number(indexed[1]);
		if (index > 255) {
			throw new StyleError(`Palette index out of range in "${text}": must be 0-255`);
		}
		return palette(index);
	}

	throw new StyleError(`Invalid colour "${text}"`);
}

/**
 * Reads a length.
 *
 * A bare number is cells, because there is only one unit and spelling it every
 * time is noise. `ch` is accepted as a synonym for people used to writing it.
 *
 * @param input - The source text.
 * @returns The length.
 */
export function parseLength(input: string, opts: { none?: boolean } = {}): Length {
	const text = input.trim().toLowerCase();

	if (text === 'auto') {
		return AUTO;
	}

	// only where "no limit" is a thing to say. Accepting it everywhere made
	// `width: none` and `margin: none` parse and then behave as `auto` or as zero,
	// which is not CSS and is not anything the author meant
	if (text === 'none' && opts.none) {
		return NONE;
	}

	if (text.endsWith('%')) {
		// not trimmed: `50 %` is two tokens in CSS, not a percentage
		const digits = text.slice(0, -1);
		if (digits !== digits.trimEnd()) {
			throw new StyleError(`Invalid percentage "${input}"`);
		}
		const share = blank(digits) ? undefined : readNumber(digits);
		if (share === undefined) {
			throw new StyleError(`Invalid percentage "${input}"`);
		}
		return percent(share);
	}

	const bare = text.endsWith('ch') ? text.slice(0, -2) : text;
	const value = blank(bare) ? undefined : readNumber(bare);
	if (value === undefined) {
		throw new StyleError(`Invalid length "${input}"`);
	}
	if (!Number.isInteger(value)) {
		// refused rather than rounded: a terminal cannot draw half a cell, and
		// silently rounding is how a layout ends up a column out with nobody able
		// to say which declaration did it
		throw new StyleError(`Length "${input}" is not a whole number of cells`);
	}

	return cells(value);
}

/**
 * Reads a number that has to be an integer and not negative.
 *
 * @param input - The source text.
 * @param name - The property, for the message.
 * @returns The number.
 */
export function parseCount(input: string, name: string): number {
	const value = blank(input) ? undefined : readNumber(input);
	if (value === undefined || !Number.isInteger(value) || value < 0) {
		throw new StyleError(`Invalid ${name} "${input}": expected a whole number of 0 or more`);
	}
	return value;
}

/**
 * Reads a number that may be fractional and may not be negative. `flex-grow`
 * and `flex-shrink` are the only two, and they are ratios rather than lengths --
 * the cells they resolve to are whole even when the ratio is not.
 *
 * @param input - The source text.
 * @param name - The property, for the message.
 * @returns The number.
 */
export function parseFactor(input: string, name: string): number {
	const value = blank(input) ? undefined : readNumber(input);
	if (value === undefined || value < 0) {
		throw new StyleError(`Invalid ${name} "${input}": expected a number of 0 or more`);
	}
	return value;
}

/**
 * Reads a whole number, positive or negative.
 *
 * @param input - The source text.
 * @param name - The property, for the message.
 * @returns The number.
 */
export function parseInteger(input: string, name: string): number {
	const value = blank(input) ? undefined : readNumber(input);
	if (value === undefined || !Number.isInteger(value)) {
		throw new StyleError(`Invalid ${name} "${input}": expected a whole number`);
	}
	return value;
}

/**
 * Reads one of a fixed set of keywords.
 *
 * @param input - The source text.
 * @param allowed - What is permitted.
 * @param name - The property, for the message.
 * @returns The keyword.
 */
export function parseKeyword<T extends string>(
	input: string,
	allowed: readonly T[],
	name: string
): T {
	const text = input.trim().toLowerCase();
	if ((allowed as readonly string[]).includes(text)) {
		return text as T;
	}
	throw new StyleError(`Invalid ${name} "${input}": expected one of ${allowed.join(', ')}`);
}

/**
 * Splits a value into its space-separated parts, keeping anything inside
 * brackets together so `rgb(1, 2, 3)` survives being one part.
 *
 * @param input - The source text.
 * @returns The parts.
 */
export function parts(input: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = '';

	for (const ch of input.trim()) {
		if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth--;
		}

		if (depth === 0 && /\s/.test(ch)) {
			if (current) {
				out.push(current);
				current = '';
			}
			continue;
		}

		current += ch;
	}

	if (current) {
		out.push(current);
	}

	return out;
}
