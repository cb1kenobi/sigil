/**
 * Large text: a FIGlet renderer and the `.flf` format.
 *
 * A masthead, a splash screen, a section heading you can read across a room.
 *
 * **This is not `font-size`, and the distinction is load bearing.** The cell size
 * is the user's and an app cannot change it, so nothing here is scaled: one
 * logical character becomes an N by M picture of ordinary cells, all at the size
 * the terminal already draws. A `font-size` meaning "this string now occupies
 * three rows" would change how many cells a string *consumes*, which puts the
 * cascade in front of the layout engine's measure step -- every text measurement
 * would have to resolve a style before it knew its own width, which nothing else
 * in the property table does. As a component it is a node with an unusually tall
 * intrinsic size, and layout already handles those.
 *
 * ```js
 * import { readFileSync } from 'node:fs';
 * import { largeText, parseFlf } from '@ttylabs/sigil/components';
 *
 * const font = parseFlf(readFileSync('standard.flf', 'utf8'));
 * console.log(largeText('sigil', { font }));
 * ```
 *
 * ## The three layers, and why they are one file
 *
 * `parseFlf()` reads a font, `renderFiglet()` turns a string into a rectangle of
 * characters, and `largeTextView()` puts that rectangle in a `text` element. The
 * first two are pure string functions that import nothing from the element tree,
 * the renderer or the cascade -- which is what "the parser is separable" actually
 * buys: a `.flf` is read and a banner is rendered with no component runtime
 * anywhere, and the tests for both are a plain character grid.
 *
 * They are not a subpath of their own. A `@ttylabs/sigil/figlet` entry is
 * permanent API surface whose only consumer is the component beside it, and the
 * property that makes the parser testable is that it is a pure function rather
 * than that it sits behind a module boundary. One file is also one `sigil add`
 * entry: ejecting the banner takes the format with it, which is what somebody
 * ejecting it wants.
 *
 * ## A `text` element rather than a `raw` one
 *
 * The rows are joined with newlines into one `nowrap` `text`, which gives the
 * whole thing for free: a `nowrap` text is one line per newline whatever room it
 * was offered, so the intrinsic height is the row count and the intrinsic width
 * is the widest row; the measurement is cached per resolved style; and `color`,
 * `background-color` and `bold` inherit, because each cell is still one cell.
 *
 * `raw` was the obvious alternative -- measure to `font.height` and paint row by
 * row through `Painter.text()` -- and it is reaching for the trapdoor when the
 * front door works. `raw` exists for a thing the layout engine cannot express, a
 * sparkline or an image, and a grid of ordinary single-column characters is
 * exactly what a `text` expresses. It would also mean a second implementation of
 * what a string measures to, and a banner would stop being copyable: `selectable`
 * defaults to false on a `raw`, which is right for a wall of block characters
 * nobody wants in their clipboard and wrong for a word somebody wants to paste.
 *
 * ## What is deliberately out
 *
 * **Vertical smushing.** A banner is one line. The five vertical rules need a
 * notion of what a line's sub-rows are, and the one that is genuinely hard --
 * vertical line supersmushing -- can *change the height* of the result, which is
 * the one number the component's intrinsic size promises. A newline in the input
 * is still a line break: the lines are rendered and stacked with no overlap,
 * which is predictable and is better than refusing ordinary input.
 *
 * **Right-to-left print direction.** It is parsed, it is reported, and a font
 * that declares it is refused by the renderer rather than rendered the wrong way
 * round -- which is the rule a property the engine ignores already follows, read
 * one layer along. Mirroring the overlap arithmetic is contained work and it is
 * not work to do blind: there is no right-to-left font here to check it against,
 * and a mirrored smush written from the spec alone would be a second answer
 * nobody has compared with the first. The day somebody has `ivrit.flf` is the day
 * to write it, with that font to hand.
 *
 * **A bundled font.** `font` is required and there is no default, which is two
 * decisions rather than one. No third-party `.flf` is committed, because the
 * notices inside the fonts the FIGlet distribution ships grant permission to
 * *modify* and say nothing about redistribution, and committing a font is a
 * distribution decision rather than a file copy. And no font of this repository's
 * own is bundled either: the look of a banner is the app's choice, which is the
 * whole reason the format is supported rather than invented, so a default would
 * be a few kilobytes every app carries and the app drawing the banner would
 * replace anyway. Required rather than defaulted means a type error rather than a
 * surprise at run time. `demos/components/08-large-text.js` carries a font of its
 * own, written here, so there is something to draw with.
 */

import { ansi as defaultAnsi } from '../ansi/index.js';
import {
	box,
	type Element,
	renderToString,
	text as textNode,
	toDisplayText,
} from '../element/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';

/** The five characters every `.flf` begins with. */
const SIGNATURE = 'flf2a';

/**
 * The characters a font carries before any code tag, in the order it carries
 * them.
 *
 * ASCII 32 to 126, then the seven the format calls the Deutsch characters:
 * `Ä Ö Ü ä ö ü ß`. They are positional -- the file says nothing about which code
 * a glyph is for -- so a font that stops early stops at a code point rather than
 * at a character it chose to leave out.
 */
const REQUIRED: readonly number[] = [
	...Array.from({ length: 126 - 32 + 1 }, (_, index) => 32 + index),
	0xc4,
	0xd6,
	0xdc,
	0xe4,
	0xf6,
	0xfc,
	0xdf,
];

/** Which way a font says its characters are laid out. */
export type FigDirection = 'ltr' | 'rtl';

/** How close adjacent characters sit. */
export type FigLayoutMode =
	/** Every character keeps its own columns. */
	| 'full'
	/** Blank columns overlap; visible ones never touch. */
	| 'kern'
	/** Visible columns may be merged, by the rules below. */
	| 'smush';

/**
 * The six horizontal smushing rules, as the format names them.
 *
 * All six off is not "no smushing" -- it is *universal* smushing, where the later
 * character simply wins. A font says that by turning smushing on and selecting
 * no rules, which is why this is six booleans rather than an optional set.
 */
export interface FigSmushRules {
	/** Rule 5: `/` and `\` make `|`, `\` and `/` make `Y`, `>` and `<` make `X`. */
	readonly bigX: boolean;
	/** Rule 1: two of the same character smush to that character. */
	readonly equal: boolean;
	/** Rule 6: two hardblanks smush to a hardblank. */
	readonly hardblank: boolean;
	/** Rule 3: a class hierarchy, `|` then `/\` then `[]` then `{}` then `()` then `<>`. */
	readonly hierarchy: boolean;
	/** Rule 4: a matched bracket pair smushes to `|`. */
	readonly pair: boolean;
	/** Rule 2: an underscore gives way to a border character. */
	readonly underscore: boolean;
}

/** What a font says about spacing, once both header fields have been read. */
export interface FigLayout {
	/** Full width, kerning, or smushing. */
	readonly mode: FigLayoutMode;
	/** Which rules smushing uses. All false is universal smushing. */
	readonly rules: FigSmushRules;
}

/** A parsed `.flf` font. */
export interface FigFont {
	/**
	 * Which row the characters sit on, counting from one.
	 *
	 * Reported rather than read: nothing here stacks a line of large text against
	 * ordinary text, so there is nothing for it to align. A caller doing that
	 * alignment itself is the one thing that cannot work it out from the glyphs.
	 */
	readonly baseline: number;
	/**
	 * The glyphs, by code point.
	 *
	 * Every entry is exactly `height` rows and every row of one entry is the same
	 * number of columns, whatever the file said -- a character is a rectangle, and
	 * a font whose rows disagree is padded rather than refused.
	 *
	 * A column is one code point, which is what the format assumes: a `.flf` is a
	 * picture drawn with single-column characters.
	 */
	readonly characters: ReadonlyMap<number, readonly string[]>;
	/** The comment block, as the file wrote it. Usually the author and the terms. */
	readonly comment: string;
	/** Which way the characters are laid out. */
	readonly direction: FigDirection;
	/** The character that draws as a space and refuses to be smushed into. */
	readonly hardblank: string;
	/** How many rows one character is. */
	readonly height: number;
	/** How close adjacent characters sit. */
	readonly layout: FigLayout;
}

/**
 * Reads one header field as an integer.
 *
 * Strictly, where the format's own reference reads it with `sscanf`: a field that
 * is not an integer means the header is not the header it claims to be, and
 * everything after it is being counted wrong. `15.5` comment lines is a font
 * whose glyph data starts somewhere nobody can work out. The pattern is what keeps
 * `Number()`'s own grammar out of it, which is the rule the parser's data types
 * already keep: `0x10` is sixteen to `Number` and is not a number anybody wrote in
 * a FIGlet header.
 *
 * Past 2^53-1 it is refused rather than read, for the reason the same entry gives:
 * what comes back is a *different* integer, which is the one failure a caller
 * cannot detect. A twenty-digit height would also reach `Array.from()` as a length
 * no array can have.
 *
 * @param token - The field.
 * @returns The value, or `undefined` if it is not an integer this can hold.
 */
function readInt(token: string | undefined): number | undefined {
	if (token === undefined || !/^[+-]?\d+$/.test(token)) {
		return undefined;
	}
	const value = Number(token);
	return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Reads a code tag's number, in any of the three bases the format allows.
 *
 * `0x41` is hex, `0101` is octal, `65` is decimal, and a sign may lead any of
 * them. A leading zero followed by a digit octal cannot hold -- `08` -- is read
 * as decimal rather than refused, because the only thing somebody can have meant
 * by it is eight.
 *
 * @param token - The first word of the code tag line.
 * @returns The code point, or `undefined` if it is not a number.
 */
function readCode(token: string): number | undefined {
	const sign = token.startsWith('-') ? -1 : 1;
	const body = token.startsWith('-') || token.startsWith('+') ? token.slice(1) : token;

	if (/^0[xX][\da-fA-F]+$/.test(body)) {
		return sign * Number.parseInt(body.slice(2), 16);
	}
	if (/^0[0-7]+$/.test(body)) {
		return sign * Number.parseInt(body.slice(1), 8);
	}
	if (/^\d+$/.test(body)) {
		return sign * Number.parseInt(body, 10);
	}
	return undefined;
}

/** A row as its columns, which is code points rather than code units. */
function columnsOf(row: string): string[] {
	return [...row];
}

/**
 * A row padded out to a column count with blanks.
 *
 * Both callers pass the widest row they have, so the count is never negative and
 * an already-wide row repeats nothing -- which is why there is no branch here. One
 * was written and deleted again for failing its sabotage: `repeat(0)` is the empty
 * string, so the guard answered what the expression already answered.
 */
function padTo(row: string, width: number): string {
	return row + ' '.repeat(width - columnsOf(row).length);
}

/**
 * One line of glyph data with its endmark taken off.
 *
 * The format's rule, exactly as it is written: the last character of the line is
 * the endmark and the whole trailing run of it comes off. That is what makes the
 * last row of a character -- conventionally `@@` -- the same as every other row,
 * and it is what a line of nothing but endmarks means: a column of nothing.
 *
 * It is the rule rather than a tidier one on purpose. A font with whitespace
 * *after* its endmark makes a space the endmark, and then the trailing run that
 * comes off is the glyph's own right-hand padding -- which is a font figlet
 * cannot read either, and guessing which of the two trailing runs was meant is a
 * heuristic that is wrong about the next font.
 *
 * @param line - The line as the file wrote it.
 * @returns The glyph's columns.
 */
function stripEndmark(line: string): string {
	const chars = columnsOf(line);
	const endmark = chars.at(-1);
	let end = chars.length;
	while (end > 0 && chars[end - 1] === endmark) {
		end--;
	}
	return chars.slice(0, end).join('');
}

/**
 * One character's rows, read from a position in the file.
 *
 * @param lines - The file.
 * @param at - The first row.
 * @param height - How many rows.
 * @returns The rows, every one the same number of columns.
 */
function readGlyph(lines: readonly string[], at: number, height: number): string[] {
	const rows: string[] = [];
	for (let row = 0; row < height; row++) {
		rows.push(stripEndmark(lines[at + row] ?? ''));
	}

	// a character is a rectangle. The format says the rows agree and real fonts
	// sometimes do not, and a glyph whose rows disagree would make every column
	// index after it mean a different thing per row
	const width = Math.max(...rows.map((row) => columnsOf(row).length));
	return rows.map((row) => padTo(row, width));
}

/**
 * What the two layout fields come to, with the newer one winning.
 *
 * The format grew `Full_Layout` after `Old_Layout`, and a font written across the
 * change carries both -- so there has to be a precedence and this is it:
 * **`Full_Layout` wins wherever the header has one, and `Old_Layout` is read only
 * when it does not.** That is what the reference implementation does and what
 * every port of it does, and it is the only reading that works: `Old_Layout`
 * cannot express the vertical rules or the "fit by default" bit at all, so in a
 * font that has both it is the lossy summary kept for drivers that predate the
 * other. Intersecting them was the alternative and it is wrong in exactly that
 * case -- it would hold a modern font down to what its backwards-compatibility
 * field could say.
 *
 * The conversion from `Old_Layout` is the reference implementation's: negative is
 * full width, zero is kerning, and positive is smushing with the rules its low
 * five bits name.
 *
 * @param oldLayout - The fifth header field.
 * @param fullLayout - The eighth, if the header has one.
 * @returns The mode and the rules.
 */
function readLayout(oldLayout: number, fullLayout: number | undefined): FigLayout {
	// the bitmask, either as the font gave it or as the old field converts to it,
	// so that there is one thing below this line to read the rules off rather than
	// two that have to agree
	let bits: number;
	if (fullLayout === undefined) {
		// all six rule bits, because the format documents bit 32 of `Old_Layout` as
		// rule 6 exactly as it documents it in `Full_Layout`. Masking to five would
		// drop a rule a font declared, and it would do it in the worst possible
		// direction: an old layout of 32 -- smush, and only two hardblanks -- would
		// come out as 128, which is *universal* smushing and merges everything
		bits = oldLayout < 0 ? 0 : oldLayout === 0 ? 64 : (oldLayout & 63) | 128;
	} else {
		bits = fullLayout;
	}

	return {
		// 128 is "smush by default" and it outranks 64, "fit by default", which is
		// the format's own order
		mode: (bits & 128) !== 0 ? 'smush' : (bits & 64) !== 0 ? 'kern' : 'full',
		rules: {
			bigX: (bits & 16) !== 0,
			equal: (bits & 1) !== 0,
			hardblank: (bits & 32) !== 0,
			hierarchy: (bits & 4) !== 0,
			pair: (bits & 8) !== 0,
			underscore: (bits & 2) !== 0,
		},
	};
}

/**
 * Reads a `.flf` font.
 *
 * @param source - The file.
 * @returns The font.
 * @throws If the file is not a `.flf`, or if what the header says cannot be read.
 */
export function parseFlf(source: string): FigFont {
	// a byte order mark is what an editor put there and is not part of the
	// signature, which is the one thing checked before anything else
	const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
	// every line ending there is, because a font is a text file that has been
	// through other people's editors. A lone carriage return is split on too, so
	// nothing downstream has to strip one off the end of a glyph row
	const lines = text.split(/\r\n|\r|\n/);

	// the file's own final newline rather than data: every row of glyph data
	// carries an endmark, so no row of data is an empty line
	while (lines.length > 0 && lines.at(-1) === '') {
		lines.pop();
	}

	const header = lines[0] ?? '';
	if (!header.startsWith(SIGNATURE)) {
		throw new Error(`Not a FIGlet font: expected a line beginning "${SIGNATURE}"`);
	}

	// read as a code point rather than a code unit, so that an astral hardblank is
	// one character here and in every comparison below it
	const code = header.codePointAt(SIGNATURE.length);
	const hardblank = code === undefined ? '' : String.fromCodePoint(code);
	// three ways of having none, refused together because none of them leaves a
	// character that can do the job. Nothing after the signature at all is how a
	// header that left it out arrives; a *space* there is the same thing written down,
	// and taking it would make the one rule a hardblank exists for mean nothing, since
	// every space in the font would stop being smushable; and a control character
	// cannot be drawn in a cell at all
	if (hardblank === '' || /\s/u.test(hardblank) || /\p{Cc}/u.test(hardblank)) {
		throw new Error(
			'FIGlet header needs a hardblank after the signature, which must be a printable character other than a space'
		);
	}

	const fields = header
		.slice(SIGNATURE.length + hardblank.length)
		.trim()
		.split(/\s+/u);
	const height = readInt(fields[0]);
	const baseline = readInt(fields[1]);
	// `Max_Length` is read past and never kept. It is the longest line the font
	// claims, the reference implementation uses it to size a buffer, and nothing
	// here needs one -- so keeping it would be publishing a number that is
	// derivable from the glyphs and, in a font whose header lies, wrong about them
	const maxLength = readInt(fields[2]);
	const oldLayout = readInt(fields[3]);
	const commentLines = readInt(fields[4]);

	if (
		height === undefined ||
		baseline === undefined ||
		maxLength === undefined ||
		oldLayout === undefined ||
		commentLines === undefined
	) {
		throw new Error(
			'FIGlet header needs five numbers after the hardblank: height, baseline, max length, old layout, comment lines'
		);
	}
	if (height < 1) {
		throw new Error(`FIGlet header says a height of ${height}, which is not a number of rows`);
	}
	if (commentLines < 0) {
		throw new Error(`FIGlet header says ${commentLines} comment lines`);
	}

	// the two optional fields that are read. Checked only when present, because a
	// header is allowed to stop after the fifth number
	const printDirection = fields.length > 5 ? readInt(fields[5]) : 0;
	if (printDirection !== 0 && printDirection !== 1) {
		throw new Error(
			`FIGlet header says a print direction of ${fields[5]}, which is neither 0 nor 1`
		);
	}

	const fullLayout = fields.length > 6 ? readInt(fields[6]) : undefined;
	if (fields.length > 6 && fullLayout === undefined) {
		throw new Error(`FIGlet header says a full layout of ${fields[6]}, which is not a number`);
	}

	// and `Codetag_Count` is not read at all. It is the number of code-tagged
	// characters, the reference implementation ignores it, and trusting it would
	// stop reading early on a font whose count is wrong -- which is a font missing
	// characters it has, for a field nothing needs

	const body = 1 + commentLines;
	if (body > lines.length) {
		throw new Error(
			`FIGlet header says ${commentLines} comment lines and the file has ${lines.length - 1} after it`
		);
	}

	const characters = new Map<number, readonly string[]>();
	let at = body;
	/** Whether the file ran out before the required run did. */
	let cut = false;

	// the required run, in order, as far as the file goes. A font that stops early
	// is read as far as it goes rather than refused: the renderer has a defined
	// answer for a character a font does not have, the required range is routinely
	// cut short by fonts the reference implementation loads, and a font with a
	// smaller repertoire is a usable font. What is *not* kept is a character the
	// file ran out in the middle of -- a glyph shorter than `height` would break
	// the one promise the component's intrinsic size makes
	for (const point of REQUIRED) {
		if (at + height > lines.length) {
			cut = true;
			break;
		}
		characters.set(point, readGlyph(lines, at, height));
		at += height;
	}

	// and nothing after a cut is a code tag. A code tag only ever follows the whole
	// required run, so what is left of a file that ran out partway is the rows of
	// the character it ran out in -- which would be read as a code tag, and `x@` is
	// not a number, so a font that merely stopped early would be refused outright
	while (!cut && at < lines.length) {
		const tag = lines[at] ?? '';
		// stepped past before the tag is read, which also makes `at` the tag's own
		// 1-based line number for the message below -- `lines` is indexed from zero and
		// a reader counts from one
		at++;

		// a blank line between code tags is somebody's formatting. It cannot be
		// glyph data, because glyph data carries an endmark, so skipping it cannot
		// put the read out of step
		if (tag.trim() === '') {
			continue;
		}

		const token = tag.trim().split(/\s+/u)[0] ?? '';
		const point = readCode(token);
		if (point === undefined) {
			throw new Error(`FIGlet code tag on line ${at} is "${token}", which is not a character code`);
		}

		if (at + height > lines.length) {
			break;
		}
		characters.set(point, readGlyph(lines, at, height));
		at += height;
	}

	return {
		baseline,
		characters,
		comment: lines.slice(1, body).join('\n'),
		direction: printDirection === 1 ? 'rtl' : 'ltr',
		hardblank,
		height,
		layout: readLayout(oldLayout, fullLayout),
	};
}

/** The characters an underscore gives way to, which is rule 2's whole list. */
const UNDERSCORE_PARTNERS = '|/\\[]{}()<>';

/** Rule 3's classes, least dominant first. A later class wins. */
const HIERARCHY: readonly string[] = ['|', '/\\', '[]', '{}', '()', '<>'];

/** Rule 4's matched pairs, in both orders, each of which smushes to `|`. */
const PAIRS: ReadonlySet<string> = new Set(['[]', '][', '{}', '}{', '()', ')(']);

/** Which of rule 3's classes a character is in, or `-1`. */
function hierarchyClass(char: string): number {
	return HIERARCHY.findIndex((members) => members.includes(char));
}

/** Whether any of the six rules is selected, which is what makes it not universal. */
function anyRule(rules: FigSmushRules): boolean {
	return (
		rules.equal ||
		rules.underscore ||
		rules.hierarchy ||
		rules.pair ||
		rules.bigX ||
		rules.hardblank
	);
}

/**
 * What two visible columns smush to, or `undefined` if they cannot.
 *
 * The rules are asked in the format's own order, and the order is the whole of
 * it: the hardblank rule comes first because it is the one rule a hardblank can
 * take part in, and everything after it refuses a hardblank outright. Getting
 * that backwards treats a hardblank as an ordinary character, which is the second
 * of the two classic bugs -- the first being to draw it as a literal `$`.
 *
 * `previous` and `current` are the widths of the two characters rather than of
 * the accumulated output, and they are here because the reference implementation
 * puts them here: a character one column wide never smushes, only kerns. Without
 * it a one-column `|` merges into its neighbour and is simply gone.
 *
 * @param left - The column already on the row.
 * @param right - The column arriving.
 * @param font - For the hardblank and the rules.
 * @param previous - How wide the character on the left is.
 * @param current - How wide the character on the right is.
 * @returns What the column becomes, or `undefined`.
 */
function smush(
	left: string,
	right: string,
	font: FigFont,
	previous: number,
	current: number
): string | undefined {
	if (previous < 2 || current < 2) {
		return undefined;
	}

	const rules = font.layout.rules;
	const hard = font.hardblank;

	if (!anyRule(rules)) {
		// universal smushing: the character arriving wins, and a hardblank gives way
		// to anything that can be seen
		if (left === hard) {
			return right;
		}
		return right === hard ? left : right;
	}

	if (rules.hardblank && left === hard && right === hard) {
		return hard;
	}
	if (left === hard || right === hard) {
		return undefined;
	}

	if (rules.equal && left === right) {
		return left;
	}

	if (rules.underscore) {
		if (left === '_' && UNDERSCORE_PARTNERS.includes(right)) {
			return right;
		}
		if (right === '_' && UNDERSCORE_PARTNERS.includes(left)) {
			return left;
		}
	}

	if (rules.hierarchy) {
		const here = hierarchyClass(left);
		const there = hierarchyClass(right);
		// the same class is not a smush: two of one class are two of the same thing,
		// which is rule 1's business and not this one's
		if (here >= 0 && there >= 0 && here !== there) {
			return here > there ? left : right;
		}
	}

	if (rules.pair && PAIRS.has(left + right)) {
		return '|';
	}

	if (rules.bigX) {
		if (left === '/' && right === '\\') {
			return '|';
		}
		if (left === '\\' && right === '/') {
			return 'Y';
		}
		// and deliberately not the other way round: `<` beside `>` is two brackets
		// facing away from each other, which is not a crossing
		if (left === '>' && right === '<') {
			return 'X';
		}
	}

	return undefined;
}

/** How many blank columns a row ends with. */
function trailingBlanks(row: readonly string[]): number {
	let count = 0;
	while (count < row.length && row[row.length - 1 - count] === ' ') {
		count++;
	}
	return count;
}

/** How many blank columns a row begins with. */
function leadingBlanks(row: readonly string[]): number {
	let count = 0;
	while (count < row.length && row[count] === ' ') {
		count++;
	}
	return count;
}

/**
 * How far one row would let the arriving character slide left.
 *
 * The arithmetic is the reference implementation's and it is one line once it is
 * said properly. Slide the character left and the first distance at which two
 * *visible* columns meet is `trailing + leading + 1` -- and at exactly that
 * distance there is only ever one such pair, because any other would need a
 * visible column on one side further in than its own last one. So the answer is
 * that distance when the pair smushes and one less when it does not, and kerning
 * is the mode where it never does.
 *
 * A hardblank is visible here. That is the whole reason hardblanks exist: a space
 * character drawn out of them keeps its width through a smush, where one drawn
 * out of spaces collapses into whatever is beside it.
 *
 * @param out - The row built so far.
 * @param arriving - The arriving character's row.
 * @param font - For the hardblank and the rules.
 * @param mode - Kerning or smushing. Full width never asks.
 * @param previous - How wide the character on the left is.
 * @param current - How wide the character on the right is.
 * @returns The distance, in columns.
 */
function rowOverlap(
	out: readonly string[],
	arriving: readonly string[],
	font: FigFont,
	mode: FigLayoutMode,
	previous: number,
	current: number
): number {
	const trailing = trailingBlanks(out);
	const leading = leadingBlanks(arriving);

	// nothing visible on one side of the join, so no two visible columns can ever
	// meet and the two slide as far as the blanks allow. A bounds guard as much as
	// a rule: with nothing visible there is no column to read, and the two indices
	// below would be past the end of their rows
	if (trailing === out.length || leading === arriving.length) {
		return trailing + leading;
	}

	const touching = trailing + leading + 1;
	const left = out[out.length - 1 - trailing];
	const right = arriving[leading];

	return mode === 'smush' && smush(left, right, font, previous, current) !== undefined
		? touching
		: touching - 1;
}

/**
 * How far the arriving character slides left, over every row.
 *
 * The least any row allows, which is what makes the result a rectangle: a row
 * that could have gone further is merged at the distance its neighbours could
 * take.
 *
 * @param out - The rows built so far.
 * @param arriving - The arriving character's rows.
 * @param font - For the hardblank and the rules.
 * @param mode - Kerning or smushing. Full width never asks.
 * @param previous - How wide the character on the left is.
 * @param current - How wide the character on the right is.
 * @returns The distance, in columns.
 */
function overlapOf(
	out: readonly (readonly string[])[],
	arriving: readonly (readonly string[])[],
	font: FigFont,
	mode: FigLayoutMode,
	previous: number,
	current: number
): number {
	// neither side can give up more columns than it has, which does two things: it
	// stops an all-blank character -- a space glyph drawn out of spaces rather than
	// out of hardblanks -- sliding past the left edge of the row it is joining, and
	// it is why the first character of a line needs no case of its own, since there
	// are no columns on the row for it to slide into
	let overlap = Math.min(out[0]?.length ?? 0, current);
	for (const [row, line] of out.entries()) {
		overlap = Math.min(overlap, rowOverlap(line, arriving[row], font, mode, previous, current));
	}

	return overlap;
}

/**
 * What one overlapped column becomes.
 *
 * A blank gives way to whatever is on the other side, which is most of what an
 * overlap is. Two visible columns only ever meet where `rowOverlap()` said they
 * smush, so the `??` is the type's answer rather than a fallback anybody can
 * reach -- and it is `right` because that is what universal smushing does, so the
 * one value it could produce is the least surprising one.
 *
 * @param left - The column already on the row.
 * @param right - The column arriving.
 * @param font - For the hardblank and the rules.
 * @param previous - How wide the character on the left is.
 * @param current - How wide the character on the right is.
 * @returns The column.
 */
function combine(
	left: string,
	right: string,
	font: FigFont,
	previous: number,
	current: number
): string {
	if (left === ' ') {
		return right;
	}
	if (right === ' ') {
		return left;
	}
	return smush(left, right, font, previous, current) ?? right;
}

/**
 * Lays one line of text out as rows of columns.
 *
 * @param line - The text, with no newline in it.
 * @param font - The font.
 * @param mode - How close the characters sit.
 * @returns One array of single-column strings per row.
 */
function layLine(line: string, font: FigFont, mode: FigLayoutMode): string[][] {
	const rows: string[][] = Array.from({ length: font.height }, () => []);
	/** The width of the character before this one, which is what `smush()` asks. */
	let previous = 0;

	// by code point, so that an astral character is one lookup rather than two
	// halves of one that neither matches
	for (const char of line) {
		const point = char.codePointAt(0) ?? 0;
		// the answer for a character the font does not have, and it is the format's
		// own: the glyph at code 0 is what a font nominates for the ones it is
		// missing, and a font that nominates none has the character left out. Putting
		// something else there -- a `?`, a blank the width of a space -- would be
		// inventing a glyph the font's author did not draw
		const glyph = font.characters.get(point) ?? font.characters.get(0);
		if (glyph === undefined) {
			continue;
		}

		const arriving = glyph.map(columnsOf);
		const current = arriving[0]?.length ?? 0;
		const overlap = mode === 'full' ? 0 : overlapOf(rows, arriving, font, mode, previous, current);

		for (const [row, target] of rows.entries()) {
			const source = arriving[row];
			const start = target.length - overlap;
			for (let column = 0; column < overlap; column++) {
				target[start + column] = combine(
					target[start + column],
					source[column],
					font,
					previous,
					current
				);
			}
			for (let column = overlap; column < source.length; column++) {
				target.push(source[column]);
			}
		}

		previous = current;
	}

	return rows;
}

export interface FigletOptions {
	/**
	 * How close adjacent characters sit. Defaults to what the font says.
	 *
	 * Worth having because most fonts look wrong in the wrong mode, and a caller
	 * who wants a tighter or looser banner than the font's author chose has no
	 * other way to say so. Forcing `smush` on a font that declares full width uses
	 * universal smushing, because a font that declares full width names no rules.
	 */
	layout?: FigLayoutMode;
}

/**
 * Renders a string as rows of characters.
 *
 * A newline is a line break: each line is laid out on its own and the blocks are
 * stacked, with no vertical smushing between them. Hardblanks are spaces by the
 * time they are returned, and every row is padded out to the widest -- what comes
 * back is a rectangle, which is what a caller drawing it into anything needs.
 *
 * @param value - The text.
 * @param font - The font.
 * @param opts - The layout mode, if not the font's.
 * @returns One string per row. Empty for an empty string.
 * @throws If the font declares a right-to-left print direction.
 */
export function renderFiglet(value: string, font: FigFont, opts: FigletOptions = {}): string[] {
	if (value === '') {
		return [];
	}
	if (font.direction === 'rtl') {
		throw new Error(
			'This FIGlet font declares a right-to-left print direction, which is not implemented'
		);
	}

	const mode = opts.layout ?? font.layout.mode;
	const rows: string[] = [];

	for (const line of value.split('\n')) {
		for (const row of layLine(line, font, mode)) {
			// the hardblank draws as a space, which is the last thing that happens to
			// it: everything above this line reads it as a character that cannot be
			// smushed into, and treating it as a space there is the first of the two
			// classic bugs
			rows.push(row.join('').replaceAll(font.hardblank, ' '));
		}
	}

	const width = Math.max(0, ...rows.map((row) => columnsOf(row).length));
	return rows.map((row) => padTo(row, width));
}

export interface LargeTextOptions extends StyledOptions, FigletOptions {
	/**
	 * The font.
	 *
	 * Required, and there is no bundled default: see this module's own notes for
	 * why. `parseFlf()` is what turns a `.flf` into one.
	 */
	font: FigFont;
}

/**
 * The banner, as an element tree.
 *
 * One `nowrap` `text` holding every row, which is what makes the intrinsic size
 * fall out: a `nowrap` text is one line per newline whatever room it was offered,
 * so it measures `font.height` rows by the widest row. Nothing here names a
 * colour, so `color`, `background-color` and `bold` are inherited from whatever
 * the banner was put inside -- each cell is still one cell.
 *
 * `min-width` is deliberately left alone. A `nowrap` text's automatic minimum is
 * its widest line, which is its whole width, so it cannot be squeezed below the
 * banner -- and a `flex-shrink: 0` saying the same thing again would be a
 * declaration that changes nothing.
 *
 * @param value - The text.
 * @param opts - The font and the layout mode.
 * @returns The tree, and how wide it wants to be.
 */
export function largeTextView(
	value: string,
	opts: LargeTextOptions
): { element: Element; width: number } {
	const rows = renderFiglet(value, opts.font, opts);

	return {
		element: box(
			{ class: 'sigil-large-text' },
			textNode(rows.join('\n'), {
				class: 'sigil-large-text-body',
				'white-space': 'nowrap',
			})
		),
		// measured as what a `text` will *draw* rather than as what the font holds,
		// which is two things at once. A font drawn with wide characters is wider on
		// screen than its own column arithmetic says. And `displayText` is what decides
		// what a control character means -- a tab draws as a space and measures as
		// nothing, so a glyph holding one is a column narrower than it looks, which is
		// the same disagreement the table's own column widths are measured through
		// `toDisplayText()` to avoid. The format says nothing about which characters a
		// glyph may be drawn with, so what a cell grid refuses is sigil's rule and
		// belongs where sigil draws rather than where the font is read
		width: Math.max(1, ...rows.map((row) => stringWidth(toDisplayText(row)))),
	};
}

/**
 * Renders a string as large text.
 *
 * A facade over `largeTextView()`, the way `table()` is one over `tableView()`:
 * the tree is laid out and painted onto a grid of its own, and what comes back is
 * the grid read as lines. There is no mounted form, because a banner does not
 * animate -- it is a thing printed into a log beside everything else.
 *
 * As wide as it came out rather than as wide as the terminal: a banner longer than
 * the screen runs past the edge and the terminal wraps it, which is the rule the
 * table and the help screen already keep for a cell and a flag name too wide for
 * their column.
 *
 * @param value - The text.
 * @param opts - The font, the layout mode, and the theme.
 * @returns The banner, with no trailing newline.
 */
export function largeText(value: string, opts: LargeTextOptions): string {
	const { element, width } = largeTextView(value, opts);

	return renderToString(element, {
		cascade: themedCascade(opts),
		colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
		width,
	});
}
