import { codes, CSI, ESC, sgr, type StyleName } from './codes.js';
import { type ColorLevel } from './color-support.js';

/**
 * One style in a chain: the sequence that turns it on, and the SGR parameter
 * that turns it off.
 *
 * `open` is a function for the colors whose rendering depends on the level --
 * a truecolor request has to come out as a 256-color or a 16-color sequence on
 * a terminal that cannot do better -- and the level is read when the text is
 * rendered, not when the chain was built, so setting the level after building a
 * styler still changes what that styler writes.
 *
 * `close` is the parameter rather than the whole sequence because the text
 * being styled is searched for it: a style has to be reopened after a sequence
 * that turned it off, and one sequence may carry several parameters at once.
 */
interface Part {
	close: number;
	open: string | ((level: ColorLevel) => string);
}

const Parts: unique symbol = Symbol('main2.ansi.parts');
const Cache: unique symbol = Symbol('main2.ansi.cache');
const Level: unique symbol = Symbol('main2.ansi.level');

/**
 * A callable style. Every style name is also a property that returns another
 * one with that style added, so `ansi.bold.red` is a styler and
 * `ansi.bold.red('x')` is the styled text.
 */
export interface Styler {
	(...text: unknown[]): string;

	/** The 256-color palette, by index. */
	ansi256(code: number): Styler;
	/** The 256-color palette as a background, by index. */
	bgAnsi256(code: number): Styler;
	/** A background color from a hex string, with or without the `#`. */
	bgHex(hex: string): Styler;
	/** A background color from 8-bit channel values. */
	bgRgb(red: number, green: number, blue: number): Styler;
	/** A foreground color from a hex string, with or without the `#`. */
	hex(hex: string): Styler;
	/** A foreground color from 8-bit channel values. */
	rgb(red: number, green: number, blue: number): Styler;
}

export type Styles = { readonly [K in StyleName]: Styler };

export interface Styler extends Styles {}

interface InternalStyler extends Styler {
	[Cache]: Map<StyleName, Styler>;
	[Level]: () => ColorLevel;
	[Parts]: Part[];
}

/**
 * The shared prototype every styler inherits, so the fifty-odd style getters
 * are defined once rather than on each link of every chain.
 */
const proto = Object.create(Function.prototype) as InternalStyler;

for (const name of Object.keys(codes) as StyleName[]) {
	const [open, close] = codes[name];
	const part: Part = { close, open: sgr(open) };

	Object.defineProperty(proto, name, {
		configurable: true,
		get(this: InternalStyler) {
			return chain(this, name, part);
		},
	});
}

Object.defineProperties(proto, {
	ansi256: method(function (this: InternalStyler, code: number) {
		const n = assertByte(code, 'color code');
		return extend(this, {
			close: 39,
			open: (level) => (level >= 2 ? sgr(`38;5;${n}`) : sgr(rgbToBasic(...ansi256ToRgb(n), false))),
		});
	}),
	bgAnsi256: method(function (this: InternalStyler, code: number) {
		const n = assertByte(code, 'color code');
		return extend(this, {
			close: 49,
			open: (level) => (level >= 2 ? sgr(`48;5;${n}`) : sgr(rgbToBasic(...ansi256ToRgb(n), true))),
		});
	}),
	bgHex: method(function (this: InternalStyler, hex: string) {
		const [r, g, b] = hexToRgb(hex);
		return this.bgRgb(r, g, b);
	}),
	bgRgb: method(function (this: InternalStyler, red: number, green: number, blue: number) {
		return rgbChain(this, red, green, blue, true);
	}),
	hex: method(function (this: InternalStyler, hex: string) {
		const [r, g, b] = hexToRgb(hex);
		return this.rgb(r, g, b);
	}),
	rgb: method(function (this: InternalStyler, red: number, green: number, blue: number) {
		return rgbChain(this, red, green, blue, false);
	}),
});

/**
 * A non-enumerable, writable property descriptor, matching what a method
 * declared in a class body would get.
 *
 * @param value - The function to describe.
 * @returns The descriptor.
 */
function method(value: (...args: never[]) => unknown): PropertyDescriptor {
	return { configurable: true, value, writable: true };
}

/**
 * Builds a root styler, which adds no styles of its own -- `ansi('x')` is
 * `'x'` -- and is the head of every chain built from it.
 *
 * @param level - Reads the level to render at. Called per render, so changing a
 * root's level also changes the chains already built from it.
 * @returns The styler.
 */
export function createStyler(level: () => ColorLevel): Styler {
	return build(level, []);
}

/**
 * Builds a styler from a list of parts.
 *
 * @param level - Reads the level to render at.
 * @param parts - The styles to apply, outermost first.
 * @returns The styler.
 */
function build(level: () => ColorLevel, parts: Part[]): Styler {
	const styler = ((...text: unknown[]) => render(level(), parts, text)) as InternalStyler;
	Object.setPrototypeOf(styler, proto);
	styler[Cache] = new Map();
	styler[Level] = level;
	styler[Parts] = parts;
	return styler;
}

/**
 * Extends a styler with one named style, reusing the styler already built for
 * that name. Chains are read repeatedly -- a help screen asks for
 * `ansi.bold.cyan` once per command -- and without the cache every read walks a
 * getter and allocates.
 *
 * Only the named styles are cached, and only once each per chain: a style
 * already in the chain is already in effect, so `ansi.bold.bold` is `ansi.bold`
 * rather than a second entry. What is retained is one styler per distinct chain
 * the program spells out, which is bounded by the program. A cache keyed on a
 * color would be bounded by that color's input instead, and a process cycling
 * through a gradient would grow an entry per frame forever; `extend()` builds
 * those fresh.
 *
 * @param parent - The styler being extended.
 * @param name - The style being added.
 * @param part - The style to add.
 * @returns The extended styler.
 */
function chain(parent: InternalStyler, name: StyleName, part: Part): Styler {
	if (parent[Parts].includes(part)) {
		return parent;
	}

	let styler = parent[Cache].get(name);
	if (!styler) {
		styler = extend(parent, part);
		parent[Cache].set(name, styler);
	}
	return styler;
}

/**
 * Extends a styler with one part, without caching it.
 *
 * @param parent - The styler being extended.
 * @param part - The style to add.
 * @returns The extended styler.
 */
function extend(parent: InternalStyler, part: Part): Styler {
	return build(parent[Level], [...parent[Parts], part]);
}

/**
 * Adds a 24-bit color, downsampled to whatever the level can render.
 *
 * @param parent - The styler being extended.
 * @param red - The red channel, 0-255.
 * @param green - The green channel, 0-255.
 * @param blue - The blue channel, 0-255.
 * @param background - Whether the color is a background.
 * @returns The extended styler.
 */
function rgbChain(
	parent: InternalStyler,
	red: number,
	green: number,
	blue: number,
	background: boolean
): Styler {
	const r = assertByte(red, 'red');
	const g = assertByte(green, 'green');
	const b = assertByte(blue, 'blue');
	const prefix = background ? 48 : 38;

	return extend(parent, {
		close: background ? 49 : 39,
		open: (level) => {
			if (level >= 3) {
				return sgr(`${prefix};2;${r};${g};${b}`);
			}
			if (level === 2) {
				return sgr(`${prefix};5;${rgbToAnsi256(r, g, b)}`);
			}
			return sgr(rgbToBasic(r, g, b, background));
		},
	});
}

/** Matches one SGR sequence, in either the ESC or the single-byte C1 form. */
const sgrPattern = new RegExp(`(?:${ESC}\\[|${CSI})([\\d;:]*)m`, 'g');

/**
 * Wraps text in a chain's sequences.
 *
 * Two details beyond the obvious concatenation, both of which only show up in
 * composed output:
 *
 * - The text may already carry sequences that turn this chain's own styles back
 *   off. Close codes are shared -- bold and dim both close with 22, every
 *   foreground with 39 -- and a reset closes everything, so an inner style that
 *   ended would leave the outer one off for the rest of the line. Every
 *   sequence in the text is read for what it turns off, and whatever it turned
 *   off is opened again after it.
 * - A style left open across a newline bleeds into whatever the terminal draws
 *   at the start of the next line, which for a background color means the
 *   margin. Each line closes and reopens instead. This runs after the pass
 *   above, so the closes it inserts are not themselves read as the inner text
 *   ending a style.
 *
 * @param level - The level to render at.
 * @param parts - The styles to apply.
 * @param args - What to style; joined with spaces, as `console.log` does.
 * @returns The styled text.
 */
function render(level: ColorLevel, parts: Part[], args: unknown[]): string {
	let text = args.length === 1 ? String(args[0]) : args.map(String).join(' ');

	if (level === 0 || parts.length === 0 || text === '') {
		return text;
	}

	let openAll = '';
	let closeAll = '';
	const opened: [close: number, open: string][] = [];

	for (const part of parts) {
		const open = typeof part.open === 'string' ? part.open : part.open(level);
		openAll += open;
		closeAll = sgr(part.close) + closeAll;
		opened.push([part.close, open]);
	}

	if (text.includes(ESC) || text.includes(CSI)) {
		text = text.replace(sgrPattern, (seq: string, params: string) =>
			reopen(seq, params, opened, openAll)
		);
	}

	if (text.includes('\n')) {
		text = text.replace(/\r?\n/g, (newline) => `${closeAll}${newline}${openAll}`);
	}

	return `${openAll}${text}${closeAll}`;
}

/**
 * The attributes that take a color rather than being one, and how many
 * parameters each spends on it in the semicolon form, counting itself and the
 * mode: `38;5;n` is a palette index and takes three, `38;2;r;g;b` is a color and
 * takes five. Keyed on the mode, which is the parameter right after the 38.
 *
 * `src/wrap/sgr-state.ts` models the same thing for the same reason; the two are
 * small enough, and far enough apart, to say it twice rather than share a module
 * across the styler and the wrapper.
 */
const extendable = new Set([38, 48, 58]);
const extendedLengths: Record<number, number> = { 2: 5, 5: 3 };

/**
 * Reopens whatever one SGR sequence in the styled text turned off.
 *
 * The parameters are read rather than the whole sequence compared, because
 * everything that matters here has more than one spelling: `ESC[0m`, `ESC[m`,
 * `ESC[00m`, and `ESC[0;31m` are all resets, and `ESC[39;1m` turns a foreground
 * off in passing. A sub-parameter -- the `3` of `ESC[4:3m` -- is not a
 * parameter of its own, so only the part before the colon is read.
 *
 * @param seq - The sequence, as it appeared.
 * @param params - Its parameters, unparsed.
 * @param opened - This chain's close codes and what reopens each, outermost
 * first.
 * @param openAll - The whole chain, for a reset.
 * @returns The sequence, followed by whatever has to come back after it.
 */
function reopen(
	seq: string,
	params: string,
	opened: [close: number, open: string][],
	openAll: string
): string {
	// an SGR carrying no parameters means the same as `0`
	const parts = params === '' ? ['0'] : params.split(';');
	const values = parts.map((p) => Number.parseInt(p, 10) || 0);

	// only the parameters that are attributes, with the channels of an extended
	// color dropped. In the semicolon form `38`, `48`, and `58` spread one color
	// over the parameters that follow, and reading those as attributes of their
	// own is what made a color turn a style back on over itself: `38;2;255;0;0`
	// carries a `0` and was taken for a reset, so the whole outer chain reopened
	// on top of the red and the text came out blue, and `38;5;39` carries the
	// foreground's own close code and reopened the outer foreground the same way.
	// The colon form -- `38:2:255:0:0` -- is one parameter already
	const attrs: number[] = [];
	for (let i = 0; i < values.length; i++) {
		attrs.push(values[i]);

		// the colon form -- `38:2:255:0:0` -- carries the whole color inside this one
		// parameter, so there is nothing after it belonging to the color and nothing
		// to skip. Skipping anyway swallowed whatever followed: `ESC[38:2:255:0:0;39m`
		// lost its `39` and left the outer style closed
		if (extendable.has(values[i]) && !parts[i].includes(':')) {
			// `38;5;n` is three parameters counting the 38, `38;2;r;g;b` is five. A
			// mode that is neither is malformed, and the rest of the sequence is the
			// only safe reading -- the alternative leaves its tail to be read as
			// attributes, which is the bug this is fixing
			i += (extendedLengths[values[i + 1]] ?? values.length - i) - 1;
		}
	}

	if (attrs.includes(0)) {
		return seq + openAll;
	}

	// outermost first, so the innermost style is opened last and is the one left
	// in effect
	let reopened = '';
	for (const [close, open] of opened) {
		if (attrs.includes(close)) {
			reopened += open;
		}
	}

	return seq + reopened;
}

/**
 * Parses `#rgb`, `#rrggbb`, and the same two without the `#`.
 *
 * @param hex - The hex color.
 * @returns The channel values.
 */
function hexToRgb(hex: string): [number, number, number] {
	const match = /^#?(?:([\da-f]{3})|([\da-f]{6}))$/i.exec(String(hex));

	if (!match) {
		throw new Error(`Invalid hex color "${hex}"`);
	}

	// `#abc` is `#aabbcc`, not `#0a0b0c`
	const value = match[1] ? match[1].replace(/./g, '$&$&') : match[2]!;
	const int = Number.parseInt(value, 16);

	return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

/**
 * The standard 16 colors, as the values most terminals ship.
 *
 * All sixteen are a theme the user can change, so this is an approximation and
 * cannot be anything else: what 31 draws is whatever the terminal was told to
 * draw. These are the conventional values, and they are what picking a nearest
 * color has to be measured against.
 */
const basic16 = [
	[0, 0, 0], // black
	[128, 0, 0], // red
	[0, 128, 0], // green
	[128, 128, 0], // yellow
	[0, 0, 128], // blue
	[128, 0, 128], // magenta
	[0, 128, 128], // cyan
	[192, 192, 192], // white
	[128, 128, 128], // bright black
	[255, 0, 0], // bright red
	[0, 255, 0], // bright green
	[255, 255, 0], // bright yellow
	[0, 0, 255], // bright blue
	[255, 0, 255], // bright magenta
	[0, 255, 255], // bright cyan
	[255, 255, 255], // bright white
] as const;

/**
 * The six levels each channel of the 256-color cube steps through. They are
 * neither evenly spaced nor multiples of 51: the first step up is 95, and the
 * rest are 40 apart.
 */
const cubeSteps = [0, 95, 135, 175, 215, 255] as const;

/**
 * How far apart two colors are, by the "redmean" weighting -- a closer match to
 * what the eye does than plain squared distance, for about the same arithmetic.
 *
 * @param red - The red channel of the first color.
 * @param green - The green channel of the first color.
 * @param blue - The blue channel of the first color.
 * @param to - The second color.
 * @returns The weighted square of the distance between them.
 */
function distance(
	red: number,
	green: number,
	blue: number,
	to: readonly [number, number, number]
): number {
	const mean = (red + to[0]) / 2;
	const dr = red - to[0];
	const dg = green - to[1];
	const db = blue - to[2];
	return (2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db;
}

/**
 * The nearest of the basic 16, as an SGR parameter.
 *
 * Nearest by distance against the palette above, rather than by rounding each
 * channel to a bit and reading the result as a color index. Rounding to bits
 * cannot express a gray at all -- every channel rounds the same way, so the
 * only grays it reaches are black and white -- which puts mid-gray on 37 when
 * 37 is `#c0c0c0` and 90 is exactly `#808080`. A tie goes to the lower index,
 * which is the darker or the less saturated of the two.
 *
 * @param red - The red channel, 0-255.
 * @param green - The green channel, 0-255.
 * @param blue - The blue channel, 0-255.
 * @param background - Whether the color is a background.
 * @returns The SGR parameter.
 */
function rgbToBasic(red: number, green: number, blue: number, background: boolean): number {
	let nearest = 0;
	let shortest = Infinity;

	for (let i = 0; i < basic16.length; i++) {
		const d = distance(red, green, blue, basic16[i]!);
		if (d < shortest) {
			shortest = d;
			nearest = i;
		}
	}

	const offset = background ? 10 : 0;
	return nearest < 8 ? 30 + nearest + offset : 90 + (nearest - 8) + offset;
}

/**
 * The nearest index in the 256-color palette.
 *
 * Above 15 the palette is a 6x6x6 cube and a 24-step gray ramp, and a color is
 * measured against both: the ramp is far finer than the cube's six gray steps,
 * but only the cube reaches pure black and white, so neither alone is right.
 *
 * The first sixteen entries are skipped on purpose. They are the theme the user
 * can change, so quantizing into them would make a fixed color follow it.
 *
 * @param red - The red channel, 0-255.
 * @param green - The green channel, 0-255.
 * @param blue - The blue channel, 0-255.
 * @returns The palette index.
 */
function rgbToAnsi256(red: number, green: number, blue: number): number {
	const r = nearestCubeStep(red);
	const g = nearestCubeStep(green);
	const b = nearestCubeStep(blue);
	const cube = 16 + 36 * r + 6 * g + b;
	const cubeDistance = distance(red, green, blue, [cubeSteps[r]!, cubeSteps[g]!, cubeSteps[b]!]);

	// the ramp runs 8 to 238 in steps of 10, as indices 232 to 255
	const mean = (red + green + blue) / 3;
	const step = Math.min(Math.max(Math.round((mean - 8) / 10), 0), 23);
	const value = step * 10 + 8;
	const rampDistance = distance(red, green, blue, [value, value, value]);

	return rampDistance < cubeDistance ? 232 + step : cube;
}

/**
 * The index of the cube step nearest a channel value.
 *
 * @param value - The channel value, 0-255.
 * @returns The step index, 0-5.
 */
function nearestCubeStep(value: number): number {
	let nearest = 0;
	let shortest = Infinity;

	for (let i = 0; i < cubeSteps.length; i++) {
		const d = Math.abs(value - cubeSteps[i]!);
		if (d < shortest) {
			shortest = d;
			nearest = i;
		}
	}

	return nearest;
}

/**
 * The color a 256-color palette index stands for.
 *
 * @param code - The palette index, 0-255.
 * @returns The channel values.
 */
function ansi256ToRgb(code: number): readonly [number, number, number] {
	if (code < 16) {
		return basic16[code]!;
	}

	if (code >= 232) {
		const value = (code - 232) * 10 + 8;
		return [value, value, value];
	}

	const index = code - 16;
	return [
		cubeSteps[Math.floor(index / 36)]!,
		cubeSteps[Math.floor((index % 36) / 6)]!,
		cubeSteps[index % 6]!,
	];
}

/**
 * Validates a channel or palette index.
 *
 * A color quietly rendering as something else is worse than a thrown error:
 * the sequence still writes, so the only symptom is the wrong color in a
 * terminal somebody else is looking at.
 *
 * @param value - The value to check.
 * @param what - What the value is, for the error message.
 * @returns The value.
 */
function assertByte(value: number, what: string): number {
	if (!Number.isInteger(value) || value < 0 || value > 255) {
		throw new Error(`Invalid ${what} "${value}"; expected an integer between 0 and 255`);
	}
	return value;
}
