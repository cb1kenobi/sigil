/**
 * The SGR codes the styler exposes by name, as `[open, close]` pairs.
 *
 * The table is written out rather than generated so that it is the spec: the
 * name a consumer types and the number the terminal receives sit on one line,
 * and the type of every style name falls out of the object literal.
 *
 * Closing codes are not all distinct -- `bold` and `dim` both close with 22,
 * every foreground color closes with 39, every background with 49 -- which is
 * why the styler reopens what it owns after any close it finds in the text it
 * was handed.
 */
export const codes = {
	// modifiers
	reset: [0, 0],
	bold: [1, 22],
	dim: [2, 22],
	italic: [3, 23],
	underline: [4, 24],
	inverse: [7, 27],
	hidden: [8, 28],
	strikethrough: [9, 29],
	overline: [53, 55],

	// foreground
	black: [30, 39],
	red: [31, 39],
	green: [32, 39],
	yellow: [33, 39],
	blue: [34, 39],
	magenta: [35, 39],
	cyan: [36, 39],
	white: [37, 39],

	// bright foreground; `gray` and `grey` are the usual names for 90
	blackBright: [90, 39],
	gray: [90, 39],
	grey: [90, 39],
	redBright: [91, 39],
	greenBright: [92, 39],
	yellowBright: [93, 39],
	blueBright: [94, 39],
	magentaBright: [95, 39],
	cyanBright: [96, 39],
	whiteBright: [97, 39],

	// background
	bgBlack: [40, 49],
	bgRed: [41, 49],
	bgGreen: [42, 49],
	bgYellow: [43, 49],
	bgBlue: [44, 49],
	bgMagenta: [45, 49],
	bgCyan: [46, 49],
	bgWhite: [47, 49],

	// bright background
	bgBlackBright: [100, 49],
	bgGray: [100, 49],
	bgGrey: [100, 49],
	bgRedBright: [101, 49],
	bgGreenBright: [102, 49],
	bgYellowBright: [103, 49],
	bgBlueBright: [104, 49],
	bgMagentaBright: [105, 49],
	bgCyanBright: [106, 49],
	bgWhiteBright: [107, 49],
	// `as const` alone, with no `satisfies`: `isolatedDeclarations` cannot infer
	// a declaration through a `satisfies` clause. `test/ansi/style.test.ts`
	// asserts the shape instead.
} as const;

/**
 * The escape character, built rather than written as a literal: the formatter
 * normalizes `\u001B` into the raw control character, and a raw control
 * character in source is invisible in an editor and in a diff.
 */
export const ESC: string = String.fromCharCode(0x1b);

/**
 * The single-byte C1 form of `ESC [`. Rare, but a sequence written with it is
 * still a sequence, so measuring and stripping have to see it.
 */
export const CSI: string = String.fromCharCode(0x9b);

/** Every style name the styler chain accepts. */
export type StyleName = keyof typeof codes;

/**
 * Wraps SGR parameters in the escape sequence that carries them.
 *
 * @param params - The parameters, already joined with `;`.
 * @returns The complete control sequence.
 */
export function sgr(params: number | string): string {
	return `${ESC}[${params}m`;
}
