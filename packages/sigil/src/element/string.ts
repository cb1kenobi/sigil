/**
 * Rendering an element tree to a string, for everything that produces text
 * rather than a frame.
 *
 * A table printed into a build log and a help screen written to stdout are
 * element trees like any other -- laid out by the layout engine and painted onto
 * a cell grid by the same painter a canvas uses -- and what they want at the end
 * is lines, not a diff. This is that end: paint a tree into a grid of its own and
 * read the grid back as styled text.
 *
 * ```js
 * import { box, renderToString, text } from '@ttylabs/sigil/element';
 *
 * renderToString(box({ 'flex-direction': 'column' }, text('one'), text('two')), {
 *   width: 40,
 * });
 * ```
 */

import type { ColorLevel } from '../ansi/color-support.js';
import {
	ATTR,
	BLANK,
	CellBuffer,
	CONTINUATION,
	DEFAULT_COLOR,
	DEFAULT_STYLE,
	LINK_OFF,
	Painter,
	RESET,
	type Style as CellStyle,
	StyleTable,
	transition,
} from '../canvas/index.js';
import { measureNode } from '../layout/index.js';
import { Cascade, Restyler } from '../style/index.js';
import type { Element } from './index.js';
import { arrange, arrangedExtent, paint, settleStyles } from './paint.js';

/**
 * The attributes that draw something on a cell holding no character.
 *
 * Trailing blanks are dropped from a line, because a line that ends in spaces
 * copies wrong and takes more of the screen than it shows. A blank carrying a
 * *background* or one of these is not that kind of blank: it is part of the
 * picture, and cutting it off erases the right-hand edge of a highlighted row.
 * `bold`, `dim` and `italic` are not here, because a space wears none of them --
 * which is what stops a bold heading's padding from surviving as trailing
 * whitespace nobody can see.
 */
const PAINTS_A_BLANK = ATTR.underline | ATTR.strikethrough | ATTR.overline | ATTR.inverse;

export interface RenderStringOptions {
	/**
	 * The stylesheets, and what the media queries are asked about.
	 *
	 * Defaults to none, which is props and inheritance. The cascade's own
	 * `media` is left alone apart from the two things this call is the authority
	 * on -- the width it is laying out in, and the colour depth -- because the
	 * other half of a query is "how much screen is there", and a string being
	 * built has no answer to that which the caller does not already have.
	 */
	cascade?: Cascade;
	/**
	 * How much colour to resolve for. Defaults to truecolor.
	 *
	 * The same number `@media (color-level: N)` reads and the depth the cascade
	 * degrades to. A caller writing to something that is not a terminal passes
	 * `0`, which drops colour rather than emitting sequences into a file.
	 */
	colorLevel?: ColorLevel;
	/**
	 * How many rows to lay out in. Defaults to what the tree measures.
	 *
	 * A string is not bounded by a screen, so the default is the height the
	 * content asked for -- which is what `measureNode()` answers and what a fixed
	 * height would refuse.
	 */
	height?: number;
	/** How many columns to lay out in. */
	width: number;
}

/**
 * Lays a tree out and reads it back as styled lines.
 *
 * @param root - The tree.
 * @param opts - The width, and what to resolve styles against.
 * @returns One string per row, each ending in the state it started in.
 */
export function renderToLines(root: Element, opts: RenderStringOptions): string[] {
	const width = Math.max(1, Math.floor(opts.width));
	const colorLevel = opts.colorLevel ?? 3;
	const cascade = opts.cascade ?? new Cascade([]);

	// the cascade is the caller's, so what is borrowed is put back: a `table()`
	// inside a running app shares its sheets with the frame loop, and a media
	// context left behind would be the next frame's answer to a question about a
	// screen this render was never about
	const previousMedia = cascade.media;
	cascade.media = { ...previousMedia, colorLevel, width };

	let height: number;
	let grid: number;
	try {
		settleStyles(root, new Restyler(cascade));

		height = Math.max(1, Math.floor(opts.height ?? measureNode(root, width).height));

		let extent = arrangedExtent(arrange(root, { height, width }));

		// laid out again where it reached further down than it measured. A row whose
		// children flex is measured with each child offered the whole content box
		// and placed with each given a share, so a description that wraps to three
		// lines in its share was two lines in the room it was offered -- and the
		// rows after it were painted over. Only where the caller did not name a
		// height, since a caller that did is describing a box rather than asking
		// how big one is
		if (opts.height === undefined && extent.height > height) {
			height = extent.height;
			extent = arrangedExtent(arrange(root, { height, width }));
		}

		// and painted into a grid as wide as what the layout came to rather than as
		// wide as it was laid out in. The two part company only where something
		// genuinely does not fit -- a flag name longer than the terminal, which help
		// prints whole on the rule that the name surviving beats the line being tidy
		// -- and a grid the width it was asked for has no columns to put it in, so
		// it would be cut off with nothing to say so. This is the width half of what
		// the height already does, for the same reason: a string is not bounded by a
		// screen
		grid = Math.max(width, Math.ceil(extent.width));
	} finally {
		cascade.media = previousMedia;
	}

	const styles = new StyleTable();
	const buffer = new CellBuffer(grid, height);
	paint(root, new Painter(buffer, styles));

	const lines: string[] = [];
	for (let y = 0; y < height; y++) {
		lines.push(lineOf(buffer, styles, y, grid));
	}
	return lines;
}

/**
 * Lays a tree out and reads it back as one string.
 *
 * @param root - The tree.
 * @param opts - The width, and what to resolve styles against.
 * @returns The lines, joined by newlines, with no trailing one.
 */
export function renderToString(root: Element, opts: RenderStringOptions): string {
	return renderToLines(root, opts).join('\n');
}

/**
 * One row, as styled text with its trailing blanks dropped.
 *
 * @param buffer - The painted grid.
 * @param styles - What its indices mean.
 * @param y - The row.
 * @param width - How wide the grid is.
 * @returns The line.
 */
function lineOf(buffer: CellBuffer, styles: StyleTable, y: number, width: number): string {
	let end = width;
	while (end > 0 && isTrailingBlank(buffer, styles, end - 1, y)) {
		end--;
	}

	let out = '';
	let current = DEFAULT_STYLE;

	for (let x = 0; x < end; x++) {
		const char = buffer.charAt(x, y);

		// a continuation carries no grapheme: its lead cell wrote the whole cluster
		// and the terminal's own cursor covers the second column, so writing here
		// would be writing it twice
		if (char === CONTINUATION) {
			continue;
		}

		const next = styles.get(buffer.styleAt(x, y));

		// a blank that shows nothing is written in whatever is already open, as
		// long as that also shows nothing on a blank. A paragraph is a row of
		// one-word elements and the gap between two of them is an unpainted cell,
		// so closing and reopening at every space turned one dim parenthetical
		// into a sequence per word -- identical on screen and three times the
		// bytes. A background or an underline is a different matter and is the
		// reason this is a test rather than a blanket skip
		if (invisibleOnBlank(char, next) && invisibleOnBlank(BLANK, current)) {
			out += char;
			continue;
		}

		out += transition(current, next);
		current = next;
		out += char;
	}

	// every line ends where it began, which is what makes the lines independent:
	// one joined onto another, or written into a log beside something else, must
	// not carry its colour into what follows. The link is closed separately
	// because SGR and OSC are separate state -- `RESET` puts the colours back and
	// leaves an OSC 8 open over whatever is written next
	if (current.link !== '') {
		out += LINK_OFF;
	}
	if (current.attrs !== 0 || current.fg !== DEFAULT_COLOR || current.bg !== DEFAULT_COLOR) {
		out += RESET;
	}

	return out;
}

/**
 * Whether a cell is a blank worth cutting off the end of a line.
 *
 * @param buffer - The painted grid.
 * @param styles - What its indices mean.
 * @param x - The column.
 * @param y - The row.
 * @returns Whether it shows nothing.
 */
function isTrailingBlank(buffer: CellBuffer, styles: StyleTable, x: number, y: number): boolean {
	const char = buffer.charAt(x, y);
	return (
		(char === BLANK || char === CONTINUATION) &&
		invisibleOnBlank(char, styles.get(buffer.styleAt(x, y)))
	);
}

/**
 * Whether a cell in this style would show nothing at all.
 *
 * A space wears no colour, no weight and no slant. What it does wear is a
 * background, an underline, a strikethrough, an overline, an inverse, and a
 * hyperlink -- which is exactly the list that decides both whether a trailing
 * blank may be cut off and whether one may be written in whatever style happens
 * to be open.
 *
 * @param char - What is in the cell.
 * @param style - How it was painted.
 * @returns Whether the cell is invisible.
 */
function invisibleOnBlank(char: string, style: CellStyle): boolean {
	return (
		(char === BLANK || char === CONTINUATION) &&
		style.bg === DEFAULT_COLOR &&
		(style.attrs & PAINTS_A_BLANK) === 0 &&
		style.link === ''
	);
}
