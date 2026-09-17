import { ESC } from '../ansi/codes.js';

/**
 * A cell's style, and the SGR needed to move from one to another.
 *
 * Kept apart from `src/ansi/`, which styles *strings* by wrapping them in an
 * open and a close. A cell grid has no strings to wrap: the diff walks from the
 * style already in effect to the style the next cell wants and emits only the
 * difference, so what it needs is a value to compare rather than a pair of
 * bookends.
 */

/** A colour: the terminal's own, a palette index, or 24-bit. */
export type Color = number;

/** The terminal's own foreground or background, whatever the user set it to. */
export const DEFAULT_COLOR: Color = -1;

/** Where the 24-bit range starts, past the 256 palette. */
const RGB_BASE = 0x100;

/**
 * A palette colour. `0`-`7` are the basic set, `8`-`15` the bright set, and
 * `16`-`255` the xterm cube and grey ramp.
 *
 * @param index - The palette index.
 * @returns The colour.
 */
export function palette(index: number): Color {
	if (!Number.isInteger(index) || index < 0 || index > 255) {
		throw new TypeError(`Invalid palette index ${String(index)}: expected a whole number 0-255`);
	}
	return index;
}

/**
 * A 24-bit colour, packed above the palette range so that any two colours can
 * be compared with `===` regardless of which kind they are.
 *
 * @param r - Red, 0-255.
 * @param g - Green, 0-255.
 * @param b - Blue, 0-255.
 * @returns The colour.
 */
export function rgb(r: number, g: number, b: number): Color {
	return RGB_BASE + ((byte(r, 'red') << 16) | (byte(g, 'green') << 8) | byte(b, 'blue'));
}

/**
 * A colour channel, refused rather than clamped.
 *
 * Clamping is how `rgb(NaN, 0, 0)` becomes black and `rgb(256, -1, 1.9)` becomes
 * something near-but-not-what-was-asked-for. `assertByte()` in the styler takes
 * the same line, for the reason this module's own validation gives: quietly
 * rendering as something else is worse than a thrown error.
 *
 * @param value - The channel.
 * @param name - Which channel, for the message.
 * @returns The channel.
 */
function byte(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0 || value > 255) {
		throw new TypeError(`Invalid ${name} channel ${String(value)}: expected a whole number 0-255`);
	}
	return value;
}

/** Whether a colour is 24-bit rather than a palette index. */
function isRgb(color: Color): boolean {
	return color >= RGB_BASE;
}

/**
 * The text attributes, as bits, so a whole style compares as three numbers.
 *
 * Written as literals rather than as shifts because `isolatedDeclarations`
 * cannot infer the type of `1 << 3` -- the same reason the SGR table in
 * `src/ansi/codes.ts` spells its codes out.
 */
export const ATTR = {
	none: 0,
	bold: 1,
	dim: 2,
	italic: 4,
	underline: 8,
	inverse: 16,
	hidden: 32,
	strikethrough: 64,
	overline: 128,
} as const;

/** The SGR code that turns each attribute on, and the one that turns it off. */
const ATTR_CODES: [bit: number, on: number, off: number][] = [
	[ATTR.bold, 1, 22],
	[ATTR.dim, 2, 22],
	[ATTR.italic, 3, 23],
	[ATTR.underline, 4, 24],
	[ATTR.inverse, 7, 27],
	[ATTR.hidden, 8, 28],
	[ATTR.strikethrough, 9, 29],
	[ATTR.overline, 53, 55],
];

/**
 * `bold` and `dim` share a closing code, so turning one off turns the other off
 * too and whichever is still wanted has to be reopened.
 */
const SHARED_OFF = new Map<number, number>([[22, ATTR.bold | ATTR.dim]]);

export interface Style {
	attrs: number;
	bg: Color;
	fg: Color;
}

/** What a cell looks like when nothing has styled it. */
export const DEFAULT_STYLE: Style = Object.freeze({
	attrs: ATTR.none,
	bg: DEFAULT_COLOR,
	fg: DEFAULT_COLOR,
});

/**
 * Interns styles so a cell holds a number rather than an object.
 *
 * A grid repeats a handful of styles across thousands of cells, and the diff's
 * inner loop asks "same style?" once per cell. Comparing integers rather than
 * three fields of an object is most of what makes that loop cheap, and it means
 * the grid can keep its styles in a typed array.
 */
export class StyleTable {
	#styles: Style[] = [DEFAULT_STYLE];
	#index = new Map<string, number>([[key(DEFAULT_STYLE), 0]]);

	/** The index of the default style, which is always zero. */
	static readonly DEFAULT = 0;

	/**
	 * The index for a style, adding it if this is the first time it is seen.
	 *
	 * A partial style is filled from the defaults, so `{ fg: palette(4) }` means
	 * what it looks like it means.
	 *
	 * @param style - The style to intern.
	 * @returns Its index.
	 */
	intern(style: Partial<Style>): number {
		const full = normalize(style);
		const k = key(full);
		const existing = this.#index.get(k);
		if (existing !== undefined) {
			return existing;
		}
		const index = this.#styles.length;
		this.#styles.push(full);
		this.#index.set(k, index);
		return index;
	}

	/**
	 * The style at an index.
	 *
	 * Frozen, so a caller inspecting one cannot rewrite what every cell holding
	 * that index looks like.
	 *
	 * @param index - The index.
	 * @returns The style, or the default for an index nothing interned.
	 */
	get(index: number): Style {
		return this.#styles[index] ?? DEFAULT_STYLE;
	}

	/** How many distinct styles have been interned, the default included. */
	get size(): number {
		return this.#styles.length;
	}
}

/**
 * A complete, valid, frozen style from whatever was handed in.
 *
 * Validated rather than trusted. A style is reached through `Partial<Style>`, so
 * a missing field is `undefined`, and `undefined` propagates silently all the
 * way to an SGR sequence reading `38;5;undefined` -- output the terminal drops
 * and nobody can trace back. The styler takes the same line in `assertByte()`:
 * quietly rendering as something else is worse than a thrown error.
 *
 * @param style - What the caller wrote.
 * @returns The style, complete and frozen.
 */
function normalize(style: Partial<Style>): Style {
	const fg = style.fg ?? DEFAULT_COLOR;
	const bg = style.bg ?? DEFAULT_COLOR;
	const attrs = style.attrs ?? ATTR.none;

	assertColor(fg, 'fg');
	assertColor(bg, 'bg');
	if (!Number.isInteger(attrs) || attrs < 0 || attrs > 0xff) {
		throw new TypeError(`Invalid style attrs ${String(attrs)}`);
	}

	return Object.freeze({ attrs, bg, fg });
}

/**
 * Refuses a colour that is not one.
 *
 * @param color - The candidate.
 * @param which - Which field, for the message.
 */
function assertColor(color: Color, which: string): void {
	if (!Number.isInteger(color) || color < DEFAULT_COLOR || color > RGB_BASE + 0xff_ff_ff) {
		throw new TypeError(`Invalid style ${which} ${String(color)}`);
	}
}

/**
 * A key that is unique per style.
 *
 * A string rather than arithmetic. The obvious packing multiplies the two
 * colours and the attributes into one number, and it does not fit: two 25-bit
 * colours and eight attribute bits are 58 bits, so the product runs past
 * `Number.MAX_SAFE_INTEGER` and the low bits -- the attributes -- are rounded
 * away. Bold truecolor text then interns as the same style as plain truecolor
 * text and silently renders unstyled, and two unrelated colour pairs collide
 * into one entry.
 *
 * A string is slower to build, and is built once per `intern()` call -- once per
 * `text()` or `fill()`, not once per cell.
 *
 * @param style - The style to key.
 * @returns The key.
 */
function key(style: Style): string {
	return `${style.fg},${style.bg},${style.attrs}`;
}

/**
 * The SGR parameters that set a foreground or background colour.
 *
 * The semicolon form, which is what `src/ansi/style.ts` emits and what every
 * terminal that does 256 or 24-bit colour accepts. ITU T.416 does specify a
 * colon form and the semicolon form is a misreading of it, but the misreading
 * is what was implemented everywhere; the colon form is a strict subset of
 * terminals and the six-element `38:2::r:g:b` spelling narrower still.
 *
 * The ambiguity the colon form avoids -- a run of parameters that cannot be
 * told apart from separate attributes -- is a problem for *parsers inside this
 * library*, which is why `reopen()` and `createSgrState()` both had to learn
 * about it. Nothing here passes through either: the terminal is the only reader
 * of this output.
 *
 * Degrading a colour the terminal cannot show is M2-61's, not this module's.
 * What is emitted here is whatever it was handed.
 *
 * @param color - The colour to set.
 * @param background - Whether this is the background.
 * @returns The parameters, without the CSI or the trailing `m`.
 */
function colorParams(color: Color, background: boolean): string {
	const base = background ? 40 : 30;

	if (color === DEFAULT_COLOR) {
		return String(base + 9);
	}

	if (isRgb(color)) {
		const value = color - RGB_BASE;
		const r = (value >> 16) & 0xff;
		const g = (value >> 8) & 0xff;
		const b = value & 0xff;
		return `${base + 8};2;${r};${g};${b}`;
	}

	// the basic eight and the bright eight have their own codes, which are
	// shorter and are understood by terminals that do not do 256 colour at all
	if (color < 8) {
		return String(base + color);
	}
	if (color < 16) {
		return String((background ? 100 : 90) + color - 8);
	}

	return `${base + 8};5;${color}`;
}

/**
 * The SGR sequence that turns `from` into `to`, or an empty string when they
 * are already the same.
 *
 * Only the difference is emitted. A full reset before every run would be
 * simpler and would roughly double the bytes on the wire for a screen of
 * styled text, which is the cost this whole module exists to avoid.
 *
 * @param from - The style currently in effect.
 * @param to - The style wanted.
 * @returns The sequence.
 */
export function transition(from: Style, to: Style): string {
	const params: string[] = [];

	const turnOff = from.attrs & ~to.attrs;
	let attrs = from.attrs;

	if (turnOff) {
		const emitted = new Set<number>();
		for (const [bit, , off] of ATTR_CODES) {
			if (turnOff & bit && !emitted.has(off)) {
				emitted.add(off);
				params.push(String(off));
				// a closing code shared with another attribute takes that one down
				// too, so anything still wanted has to be reopened below
				attrs &= ~(SHARED_OFF.get(off) ?? bit);
			}
		}
	}

	const turnOn = to.attrs & ~attrs;
	if (turnOn) {
		for (const [bit, on] of ATTR_CODES) {
			if (turnOn & bit) {
				params.push(String(on));
			}
		}
	}

	if (from.fg !== to.fg) {
		params.push(colorParams(to.fg, false));
	}

	if (from.bg !== to.bg) {
		params.push(colorParams(to.bg, true));
	}

	return params.length ? `${ESC}[${params.join(';')}m` : '';
}

/** Puts every attribute and colour back to the terminal's own. */
export const RESET: string = `${ESC}[0m`;
