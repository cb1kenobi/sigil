/**
 * Colour degradation: one stylesheet, four colour depths.
 *
 * The problem CSS does not have. The same sheet has to render on a truecolor
 * terminal, a 256-colour one, a 16-colour one, and something with no colour at
 * all, and the author writes it once.
 *
 * ```js
 * import { degradeColor } from '@ttylabs/sigil/style';
 *
 * degradeColor(rgb(255, 95, 95), 2);  // the nearest xterm cube entry
 * degradeColor(rgb(255, 95, 95), 1);  // the nearest of the basic sixteen
 * degradeColor(rgb(255, 95, 95), 0);  // the terminal's own foreground
 * ```
 *
 * This runs at resolve time rather than at paint time, so the canvas only ever
 * holds colours the terminal can actually emit and the diff never compares a
 * colour against its own approximation. It is pure and memoized: the same
 * declared colour always degrades the same way at a given depth.
 */

import type { ColorLevel } from '../ansi/color-support.js';
import { type Color, DEFAULT_COLOR, palette } from '../canvas/style.js';
import { ATTRIBUTE_PROPERTIES, COLOR_PROPERTIES, type Style } from './properties.js';

/** Where the 24-bit range starts, past the 256 palette. Mirrors `canvas/style.ts`. */
const RGB_BASE = 0x100;

/**
 * The xterm default palette for the basic sixteen.
 *
 * Terminal themes make these unknowable -- somebody running Solarized has a
 * different red -- so this matches against the xterm defaults and accepts being
 * wrong for them. There is no way to ask a terminal what its palette is that is
 * worth the round trip, and being wrong about a colour the user chose is a
 * smaller failure than refusing to degrade at all.
 */
const BASIC: readonly (readonly [number, number, number])[] = [
	[0x00, 0x00, 0x00], // 0  black
	[0xcd, 0x00, 0x00], // 1  red
	[0x00, 0xcd, 0x00], // 2  green
	[0xcd, 0xcd, 0x00], // 3  yellow
	[0x00, 0x00, 0xee], // 4  blue
	[0xcd, 0x00, 0xcd], // 5  magenta
	[0x00, 0xcd, 0xcd], // 6  cyan
	[0xe5, 0xe5, 0xe5], // 7  white
	[0x7f, 0x7f, 0x7f], // 8  bright black
	[0xff, 0x00, 0x00], // 9  bright red
	[0x00, 0xff, 0x00], // 10 bright green
	[0xff, 0xff, 0x00], // 11 bright yellow
	[0x5c, 0x5c, 0xff], // 12 bright blue
	[0xff, 0x00, 0xff], // 13 bright magenta
	[0x00, 0xff, 0xff], // 14 bright cyan
	[0xff, 0xff, 0xff], // 15 bright white
];

/** The six levels each axis of the xterm colour cube takes. */
const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/**
 * The RGB an xterm palette index stands for.
 *
 * `16`-`231` are a 6x6x6 cube and `232`-`255` a 24-step grey ramp, both fixed by
 * the spec. `0`-`15` are the user's, and are answered from the xterm defaults
 * above for want of anything better.
 *
 * @param index - The palette index.
 * @returns The channels.
 */
export function paletteRgb(index: number): readonly [number, number, number] {
	if (index < 16) {
		return BASIC[index];
	}
	if (index < 232) {
		const n = index - 16;
		return [
			CUBE_LEVELS[Math.floor(n / 36) % 6],
			CUBE_LEVELS[Math.floor(n / 6) % 6],
			CUBE_LEVELS[n % 6],
		];
	}
	const grey = 8 + (index - 232) * 10;
	return [grey, grey, grey];
}

/** Pulls the channels out of a colour, whichever kind it is. */
function channels(color: Color): readonly [number, number, number] {
	if (color >= RGB_BASE) {
		const packed = color - RGB_BASE;
		return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
	}
	return paletteRgb(color);
}

/**
 * sRGB to Oklab.
 *
 * Oklab over CIELAB because it is simpler, newer, and better behaved around
 * blues; either beats Euclidean RGB, which is the thing actually worth avoiding.
 * The sixteen basic colours are perceptually scattered rather than evenly spaced,
 * so RGB distance picks visibly wrong answers -- a mid orange comes out green
 * because green happens to be numerically closer than red.
 *
 * @param channel - The sRGB channels, 0-255.
 * @returns The Oklab coordinates.
 */
export function oklab(
	channel: readonly [number, number, number]
): readonly [number, number, number] {
	const [r, g, b] = channel.map(linear) as [number, number, number];

	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		// -0.8086758033 rather than Ottosson's published -0.808675766. For D65
		// white the LMS rows each sum to one, so l, m and s are all 1 and the a and
		// b rows have to sum to exactly zero or a grey acquires chroma. The a row
		// does; the published b row leaves a residue of 3.7e-8, which is small but
		// is a bias in one direction on every neutral colour there is. This is the
		// value that makes the row sum zero, and `should give a grey no chroma`
		// pins the property rather than the digits
		0.0259040371 * l + 0.7827717662 * m - 0.8086758033 * s,
	];
}

/** One sRGB channel, 0-255, to linear light. */
function linear(value: number): number {
	const v = value / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Squared Oklab distance. Squared because only the ordering is used. */
function distance(
	a: readonly [number, number, number],
	b: readonly [number, number, number]
): number {
	return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** The palette indices degradation is allowed to land on, per level. */
const TARGETS_256: readonly number[] = range(16, 256);
const TARGETS_16: readonly number[] = range(0, 16);

function range(from: number, to: number): number[] {
	return Array.from({ length: to - from }, (_, i) => from + i);
}

/** Every target's Oklab, computed once. */
const OKLAB_OF: readonly (readonly [number, number, number])[] = range(0, 256).map((index) =>
	oklab(paletteRgb(index))
);

/**
 * The nearest palette index to a colour, among a set of candidates.
 *
 * @param color - The colour to match.
 * @param targets - The indices it may land on.
 * @returns The nearest index.
 */
function nearest(color: Color, targets: readonly number[]): number {
	const wanted = oklab(channels(color));
	let best = targets[0];
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const index of targets) {
		const here = distance(wanted, OKLAB_OF[index]);
		if (here < bestDistance) {
			bestDistance = here;
			best = index;
		}
	}

	return best;
}

/** One memo per lossy level. Level 3 is identity and level 0 has one answer. */
const MEMO: Map<number, Color>[] = [new Map(), new Map(), new Map(), new Map()];

/**
 * Degrades one colour to what a terminal at this depth can emit.
 *
 * The ladder: truecolor is the declared value; 256 quantizes to the xterm cube
 * and grey ramp; 16 matches the nearest basic colour in Oklab; 0 drops colour
 * entirely.
 *
 * Note what level 2 does *not* do: it never *lands* on `0`-`15`. Those sixteen
 * are whatever the user's theme says they are, so quantizing an ordinary colour
 * onto one makes the result depend on a setting nothing here can read. The cube
 * and the grey ramp are fixed by the spec, so at 256 colours there is always a
 * predictable answer; the unpredictable ones are a target only at level 1, where
 * there is no choice. A colour *declared* as one of the sixteen is a different
 * question and passes through untouched, for the reason AGENTS.md already gives.
 *
 * Memoized per level, and the memo is never evicted. What reaches this is a
 * *declared* colour -- what a stylesheet or a prop wrote -- of which an app has
 * a few dozen, so the table is small and stays small. A gradient painted cell by
 * cell does not come through here: it goes to the canvas directly.
 *
 * @param color - The declared colour.
 * @param level - How much colour the destination can render.
 * @returns A colour the destination can emit.
 */
export function degradeColor(color: Color, level: ColorLevel): Color {
	// the terminal's own foreground survives every level: it is not a colour we
	// chose, it is the absence of one
	if (color === DEFAULT_COLOR || level >= 3) {
		return color;
	}
	if (level <= 0) {
		return DEFAULT_COLOR;
	}

	const memo = MEMO[level];
	const cached = memo.get(color);
	if (cached !== undefined) {
		return cached;
	}

	// a palette colour the level can already emit is left exactly as declared.
	// At 256 that is every palette index, the basic sixteen included: AGENTS.md
	// records that a named colour stays a palette index, because those sixteen are
	// whatever the user's theme says they are -- so rewriting a declared `blue`
	// into the cube's #0000ff would override a choice they already made. Only a
	// colour the level *cannot* emit is matched, and only ever onto the fixed part
	// of the palette
	const answer =
		level === 2
			? color < RGB_BASE
				? color
				: palette(nearest(color, TARGETS_256))
			: color < 16
				? color
				: palette(nearest(color, TARGETS_16));

	memo.set(color, answer);
	return answer;
}

/**
 * Degrades every colour in a style, in place.
 *
 * In place because the caller is the cascade, which has just built the style and
 * is the only thing holding it. `degradeStyle()` is the copying version.
 *
 * @param style - The style to degrade.
 * @param level - How much colour the destination can render.
 * @returns The same style.
 */
export function degradeInto(style: Style, level: ColorLevel): Style {
	if (level >= 3) {
		return style;
	}
	// the table says which properties hold a colour, so the cast is a statement
	// about that rather than about any particular property
	const writable = style as unknown as Record<string, Color>;
	for (const property of COLOR_PROPERTIES) {
		writable[property] = degradeColor(writable[property], level);
	}

	// level 0 is plain text, attributes included, which is what the styler has
	// always meant by it: `ansi.bold()` at level 0 hands back the string it was
	// given. The two ways a process arrives at level 0 are a pipe and `NO_COLOR`,
	// and neither wants `ESC[1m` in the file it is writing -- so a bold heading
	// and a cyan one go together rather than the library deciding that one of
	// them was too important to turn off. It is also what makes a prompt asked
	// for plain text plain: the caret is `inverse`, and a caret drawn at level 0
	// would be the one sequence nothing could switch off
	if (level === 0) {
		const attrs = style as unknown as Record<string, boolean>;
		for (const property of ATTRIBUTE_PROPERTIES) {
			attrs[property] = false;
		}
	}

	return style;
}

/**
 * Degrades every colour in a style.
 *
 * Nothing but the colours changes. A palette that carried meaning -- an error is
 * red -- loses that meaning at level 0, and nothing here invents an attribute to
 * carry it: turning red into bold would make red and blue both bold, which
 * preserves the emphasis while destroying the distinction it is pretending to
 * keep. The rule that follows is a rule for components rather than for this
 * function: do not encode meaning in colour alone. That is an accessibility
 * argument as much as a compatibility one.
 *
 * @param style - The style.
 * @param level - How much colour the destination can render.
 * @returns A new style with its colours degraded.
 */
export function degradeStyle(style: Style, level: ColorLevel): Style {
	return level >= 3 ? style : degradeInto({ ...style }, level);
}
