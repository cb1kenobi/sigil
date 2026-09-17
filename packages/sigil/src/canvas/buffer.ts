import { strip } from '../ansi/strip.js';
import { graphemes, graphemeWidth } from '../width/index.js';
import { DEFAULT_STYLE, type Style, StyleTable } from './style.js';

/**
 * A grid of cells, addressed by row and column.
 *
 * A cell holds one grapheme cluster and a style index. A cluster two columns
 * wide -- most CJK, most emoji -- occupies its own cell and leaves a
 * **continuation** in the next one, so the grid stays addressable by column
 * even where the text is not. Without that marker there is no way to answer
 * "what is in column 40" for a screen containing a single wide character, and
 * every clip, overwrite, and diff would be off by one from there rightwards.
 *
 * Two parallel arrays rather than an array of cell objects: the diff compares a
 * style per cell, and an integer out of a typed array is the cheapest form that
 * comparison takes.
 *
 * Named `CellBuffer` rather than `Buffer` because the shorter name is Node's,
 * and a file that forgets the import gets a byte buffer and a deprecation
 * warning instead of a type error.
 */

/** What a cell holds when nothing has been painted into it. */
export const BLANK = ' ';

/**
 * How many cells a cluster occupies, which is one or two and never more.
 *
 * `graphemeWidth()` sums the widths of what a cluster contains, and a cluster
 * can contain more than two columns' worth -- a CJK character followed by a
 * spacing mark, two leading Hangul jamo. A cell grid has no third cell to put
 * that in: the cluster went into one cell, the cursor advanced by three, and the
 * cells in between were never drawn while still holding content nothing would
 * paint over. Two is the most a grid can represent, so two is what it gets.
 *
 * @param cluster - One grapheme cluster.
 * @returns Zero, one, or two.
 */
export function cellWidth(cluster: string): number {
	return Math.min(2, graphemeWidth(cluster));
}

/**
 * The C0 and C1 control characters, tab included.
 *
 * None of them has a cell. A tab is not an exception: its width depends on where
 * it lands and on a tab stop the grid does not model, so expanding it here would
 * be guessing and painting it would put a hole in the row.
 */
// the rule exists to catch a control character reaching a regex by accident;
// matching them is this one's whole job
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** The right-hand half of a wide cluster. Never painted, never drawn. */
export const CONTINUATION = '';

export class CellBuffer {
	#chars: string[];
	#styles: Int32Array;
	#width: number;
	#height: number;

	constructor(width: number, height: number) {
		this.#width = Math.max(0, Math.trunc(width));
		this.#height = Math.max(0, Math.trunc(height));
		const size = this.#width * this.#height;
		// eslint-disable-next-line unicorn/no-new-array
		this.#chars = new Array<string>(size).fill(BLANK);
		this.#styles = new Int32Array(size);
	}

	get width(): number {
		return this.#width;
	}

	get height(): number {
		return this.#height;
	}

	/**
	 * Resizes, discarding what was there.
	 *
	 * Nothing is preserved on purpose. A resize means the layout is about to run
	 * again at the new size and paint everything, and keeping stale cells would
	 * only give the diff something wrong to compare against -- the frame that was
	 * on screen described a terminal that no longer exists.
	 *
	 * @param width - The new width.
	 * @param height - The new height.
	 */
	resize(width: number, height: number): void {
		const next = new CellBuffer(width, height);
		this.#chars = next.#chars;
		this.#styles = next.#styles;
		this.#width = next.#width;
		this.#height = next.#height;
	}

	/** Puts every cell back to a blank in the default style. */
	clear(): void {
		this.#chars.fill(BLANK);
		this.#styles.fill(StyleTable.DEFAULT);
	}

	/**
	 * Whether a coordinate is on the grid.
	 *
	 * @param x - The column.
	 * @param y - The row.
	 * @returns Whether it can be addressed.
	 */
	inside(x: number, y: number): boolean {
		return x >= 0 && y >= 0 && x < this.#width && y < this.#height;
	}

	/** The index of a cell, or `-1` when it is off the grid. */
	#at(x: number, y: number): number {
		return this.inside(x, y) ? y * this.#width + x : -1;
	}

	/**
	 * The grapheme in a cell. An empty string means the cell is the right-hand
	 * half of a wide cluster.
	 *
	 * @param x - The column.
	 * @param y - The row.
	 * @returns The grapheme, or a blank when off the grid.
	 */
	charAt(x: number, y: number): string {
		const index = this.#at(x, y);
		return index < 0 ? BLANK : this.#chars[index];
	}

	/**
	 * The style index of a cell.
	 *
	 * @param x - The column.
	 * @param y - The row.
	 * @returns The index, or the default style when off the grid.
	 */
	styleAt(x: number, y: number): number {
		const index = this.#at(x, y);
		return index < 0 ? StyleTable.DEFAULT : this.#styles[index];
	}

	/** @internal Raw access, for the diff, which walks by index. */
	rawChars(): readonly string[] {
		return this.#chars;
	}

	/** @internal */
	rawStyles(): Int32Array {
		return this.#styles;
	}

	/**
	 * Blanks a cell, and repairs whatever wide cluster it was part of.
	 *
	 * Overwriting half of a wide cluster has to take the other half with it. Left
	 * alone, the surviving half is a lead cell whose continuation now holds
	 * something else, or a continuation with no lead -- either way the terminal
	 * is told to draw half a glyph, and every column after it on that row is
	 * shifted.
	 *
	 * @param x - The column.
	 * @param y - The row.
	 * @param styleIndex - The style to leave the blanked cells in.
	 */
	#breakCluster(x: number, y: number, styleIndex: number): void {
		const index = this.#at(x, y);
		if (index < 0) {
			return;
		}

		if (this.#chars[index] === CONTINUATION) {
			// this is the right-hand half; the lead is the cell before it
			const lead = this.#at(x - 1, y);
			if (lead >= 0) {
				this.#chars[lead] = BLANK;
				this.#styles[lead] = styleIndex;
			}
			return;
		}

		if (cellWidth(this.#chars[index]) === 2) {
			// this is the lead; its continuation follows
			const tail = this.#at(x + 1, y);
			if (tail >= 0) {
				this.#chars[tail] = BLANK;
				this.#styles[tail] = styleIndex;
			}
		}
	}

	/**
	 * Paints one grapheme cluster.
	 *
	 * A zero-width cluster -- a lone combining mark, a variation selector -- is
	 * refused rather than given a cell of its own. It has no column to occupy,
	 * and `graphemes()` has already attached it to the cluster it modifies.
	 *
	 * @param x - The column.
	 * @param y - The row.
	 * @param cluster - One grapheme cluster.
	 * @param styleIndex - The interned style.
	 * @returns How many columns were consumed, which is `0` when nothing was
	 * painted.
	 */
	put(x: number, y: number, cluster: string, styleIndex: number): number {
		const width = cellWidth(cluster);
		if (width === 0) {
			return 0;
		}

		const index = this.#at(x, y);
		if (index < 0) {
			// off the left or right edge, or off the grid entirely. A wide cluster
			// whose lead is on-grid but whose continuation is not is refused below
			return 0;
		}

		if (width === 2 && x + 1 >= this.#width) {
			// no room for the second half. Half a wide glyph is worse than none, so
			// a blank takes the column and the caller's clipping decides the rest
			this.#breakCluster(x, y, styleIndex);
			this.#chars[index] = BLANK;
			this.#styles[index] = styleIndex;
			return 1;
		}

		this.#breakCluster(x, y, styleIndex);
		if (width === 2) {
			this.#breakCluster(x + 1, y, styleIndex);
		}

		this.#chars[index] = cluster;
		this.#styles[index] = styleIndex;

		if (width === 2) {
			this.#chars[index + 1] = CONTINUATION;
			this.#styles[index + 1] = styleIndex;
		}

		return width;
	}

	/**
	 * Paints a string, cluster by cluster, stopping at the right edge.
	 *
	 * @param x - The starting column.
	 * @param y - The row.
	 * @param text - The text. Split into clusters, so combining marks and emoji
	 * sequences stay whole.
	 * @param styleIndex - The interned style.
	 * @returns How many columns were consumed.
	 */
	write(x: number, y: number, text: string, styleIndex: number): number {
		let column = x;
		// A cell grid expresses styling as a style per cell, so a string that
		// carries its own escape sequences has nowhere to put them -- and painting
		// them cluster by cluster writes `[31m` on the screen as text, because the
		// ESC itself is zero width and the rest is not. Every existing component
		// builds strings like that, so the first one moved onto a canvas would
		// render junk. Stripped rather than refused: the text is what was meant,
		// and the style belongs in `styleIndex`.
		const plain = strip(text);

		// a control character is refused rather than dropped. `\n` is zero width,
		// so it took no cell and `put()` returned 0 -- and `write()` only stopped
		// on a *positive*-width cluster that failed to land, so a wrapped paragraph
		// painted as one concatenated line with no complaint. A grid has one row
		// per call by construction; the caller has to say which row
		const control = CONTROL.exec(plain);
		if (control) {
			throw new RangeError(
				`Cannot paint control character U+${control[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}: a row is painted one call at a time`
			);
		}

		for (const cluster of graphemes(plain)) {
			if (column >= this.#width) {
				break;
			}
			const consumed = this.put(column, y, cluster, styleIndex);
			if (consumed === 0 && cellWidth(cluster) > 0) {
				// off the grid rather than zero-width: nothing further will land
				break;
			}
			column += consumed;
		}
		return column - x;
	}

	/**
	 * Fills a rectangle with a grapheme, clipped to the grid.
	 *
	 * @param x - The left column.
	 * @param y - The top row.
	 * @param width - How many columns.
	 * @param height - How many rows.
	 * @param cluster - What to fill with. A wide cluster is laid two columns at
	 * a time and the rectangle is left short rather than overrun when its width is
	 * odd.
	 * @param styleIndex - The interned style.
	 */
	fill(
		x: number,
		y: number,
		width: number,
		height: number,
		cluster: string,
		styleIndex: number
	): void {
		const step = cellWidth(cluster);
		if (step === 0) {
			// nothing to fill with, and a loop that never advances would not end
			return;
		}

		const right = x + width;
		for (let row = y; row < y + height; row++) {
			// stepped by what the cluster actually consumes, and stopped before one
			// would cross the caller's own right edge. Advancing by one regardless
			// made each iteration break the continuation the last one left, so only
			// the final column kept its glyph -- and the last `put()` wrote its
			// continuation one column *past* the rectangle, over whatever else was
			// painted there
			for (let column = x; column + step <= right; column += step) {
				this.put(column, row, cluster, styleIndex);
			}
		}
	}

	/**
	 * Copies another buffer's contents over this one, which is how a presented
	 * frame becomes the thing the next frame is compared against.
	 *
	 * @param other - The buffer to copy from. Must be the same size.
	 */
	copyFrom(other: CellBuffer): void {
		if (other.#width !== this.#width || other.#height !== this.#height) {
			this.#width = other.#width;
			this.#height = other.#height;
			// eslint-disable-next-line unicorn/no-new-array
			this.#chars = new Array<string>(other.#chars.length).fill(BLANK);
			this.#styles = new Int32Array(other.#styles.length);
		}
		for (let i = 0; i < this.#chars.length; i++) {
			this.#chars[i] = other.#chars[i];
		}
		this.#styles.set(other.#styles);
	}

	/**
	 * The grid as lines of plain text, with no styling.
	 *
	 * For tests, and for anything that wants to know what a frame says rather
	 * than how it looks. A continuation contributes nothing, so a wide cluster
	 * appears once and the line reads the way it renders.
	 *
	 * @returns One string per row.
	 */
	toLines(): string[] {
		const lines: string[] = [];
		for (let y = 0; y < this.#height; y++) {
			let line = '';
			for (let x = 0; x < this.#width; x++) {
				line += this.#chars[y * this.#width + x];
			}
			lines.push(line);
		}
		return lines;
	}

	/**
	 * The grid as one string, rows joined by newlines and trailing blanks
	 * trimmed -- which is what a snapshot wants to read.
	 *
	 * @returns The text.
	 */
	toString(): string {
		return this.toLines()
			.map((line) => line.replace(/ +$/, ''))
			.join('\n');
	}
}

/**
 * A painter over a buffer that takes styles as objects and interns them.
 *
 * The buffer deals in style indices because that is what makes it fast; a
 * caller deals in styles because that is what makes it writable. This is the
 * one place that converts.
 */
export class Painter {
	#buffer: CellBuffer;
	#styles: StyleTable;

	constructor(buffer: CellBuffer, styles: StyleTable) {
		this.#buffer = buffer;
		this.#styles = styles;
	}

	/**
	 * Paints text.
	 *
	 * @param x - The starting column.
	 * @param y - The row.
	 * @param text - What to paint.
	 * @param style - How it looks. The terminal's own, if omitted.
	 * @returns How many columns were consumed.
	 */
	text(x: number, y: number, text: string, style: Partial<Style> = DEFAULT_STYLE): number {
		return this.#buffer.write(x, y, text, this.#styles.intern(style));
	}

	/**
	 * Fills a rectangle.
	 *
	 * @param x - The left column.
	 * @param y - The top row.
	 * @param width - How many columns.
	 * @param height - How many rows.
	 * @param style - How it looks.
	 * @param cluster - What to fill with. A blank, if omitted.
	 */
	fill(
		x: number,
		y: number,
		width: number,
		height: number,
		style: Partial<Style> = DEFAULT_STYLE,
		cluster: string = BLANK
	): void {
		this.#buffer.fill(x, y, width, height, cluster, this.#styles.intern(style));
	}
}
