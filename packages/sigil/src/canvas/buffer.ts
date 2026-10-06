import { strip } from '../ansi/strip.js';
import { graphemes, graphemeWidth } from '../width/index.js';
import { DEFAULT_STYLE, type Style, StyleTable } from './style.js';

/**
 * A rectangle of cells, which is all a clip is.
 *
 * Four numbers of its own rather than the layout engine's `Box`: the canvas sits
 * below layout and does not know what a laid-out box is, and a type-only import
 * would still be this module pointing at that one. The shapes are identical and
 * that is a coincidence of arithmetic rather than a relationship.
 */
export interface Clip {
	height: number;
	width: number;
	x: number;
	y: number;
}

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
	/**
	 * Whether anything has been painted into each cell, which is the one question
	 * the chars and the styles cannot answer between them.
	 *
	 * `clear()` fills with `BLANK` in `StyleTable.DEFAULT`, so a space painted in
	 * the terminal's own colours is indistinguishable from a cell nothing touched
	 * -- and compositing one grid over another has to tell them apart. The case
	 * that decides it is the first one anybody writes: a panel filled with a
	 * background colour is *opaque* and must occlude what is underneath, and every
	 * cell of it is a blank.
	 *
	 * A parallel array rather than a sentinel grapheme. A sentinel would be a
	 * third meaning for a slot that already carries two -- `BLANK` and
	 * `CONTINUATION` -- and it would have to survive `#breakCluster()`,
	 * `copyFrom()` and `toLines()`, each of which reads what a cell holds for a
	 * different reason. A `Uint8Array` is one byte per cell, 1,920 of them at
	 * 80x24, and nothing downstream has to know it exists.
	 */
	#occupied: Uint8Array;
	#width: number;
	#height: number;
	/** What may be painted, when something has narrowed it. */
	#clip: Clip | undefined;

	constructor(width: number, height: number) {
		this.#width = Math.max(0, Math.trunc(width));
		this.#height = Math.max(0, Math.trunc(height));
		const size = this.#width * this.#height;
		// eslint-disable-next-line unicorn/no-new-array
		this.#chars = new Array<string>(size).fill(BLANK);
		this.#styles = new Int32Array(size);
		this.#occupied = new Uint8Array(size);
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
		this.#occupied = next.#occupied;
		this.#width = next.#width;
		this.#height = next.#height;
	}

	/**
	 * Puts every cell back to a blank in the default style, and back to holding
	 * nothing.
	 *
	 * The occupancy goes with the contents, which is the whole of what makes it
	 * mean anything: a grid `paint()` has just cleared is one nothing has painted,
	 * and a composite over it must let every layer through.
	 */
	clear(): void {
		this.#chars.fill(BLANK);
		this.#styles.fill(StyleTable.DEFAULT);
		this.#occupied.fill(0);
	}

	/**
	 * Whether a coordinate is on the grid, and inside the clip if there is one.
	 *
	 * The clip is the grid's rather than the painter's because this is where a
	 * wide cluster is refused its second cell: the rule that half a glyph is
	 * worse than none was already written here for the grid's own right edge, and
	 * a clip edge is the same edge one column in. Asking it anywhere else would be
	 * the same rule said twice, and the two would come to disagree.
	 *
	 * A coordinate that is not a whole number is not on the grid, which is the
	 * same answer and for the same reason as one past the edge: it names no cell.
	 * Asked here because this is where the index arithmetic happens, and it was a
	 * crash rather than a wrong answer -- `y * width + 0.5` is a fractional index,
	 * `#chars[0.5]` is `undefined`, and `cellWidth(undefined)` throws out of
	 * `graphemeWidth()` from three frames inside `put()`. `NaN` reached it the
	 * same way, by failing every comparison below rather than by passing one, and
	 * both ends of `Infinity` with it. Found by a `Layer` origin, which is the
	 * first coordinate here a caller fills in as a plain field rather than getting
	 * from a loop -- and the fix is one line for every caller rather than a
	 * truncation in the one that found it, which is the rule the clip itself
	 * already follows.
	 *
	 * @param x - The column.
	 * @param y - The row.
	 * @returns Whether it can be addressed.
	 */
	inside(x: number, y: number): boolean {
		if (!Number.isInteger(x) || !Number.isInteger(y)) {
			return false;
		}
		if (x < 0 || y < 0 || x >= this.#width || y >= this.#height) {
			return false;
		}
		const clip = this.#clip;
		return (
			!clip || (x >= clip.x && y >= clip.y && x < clip.x + clip.width && y < clip.y + clip.height)
		);
	}

	/**
	 * Restricts what can be painted to a rectangle, and says what it was before.
	 *
	 * Nothing outside is written -- not refused loudly, simply not painted, which
	 * is what `overflow: hidden` means and what every caller already handles,
	 * since a cell off the grid has always answered the same way.
	 *
	 * @param box - The rectangle, or `undefined` for the whole grid.
	 * @returns The clip that was in effect, so a caller can put it back.
	 */
	clipTo(box: Clip | undefined): Clip | undefined {
		const previous = this.#clip;
		this.#clip = box;
		return previous;
	}

	/** The index of a cell, or `-1` when it is off the grid or outside the clip. */
	#at(x: number, y: number): number {
		return this.inside(x, y) ? y * this.#width + x : -1;
	}

	/**
	 * The index of a cell on the grid, whatever the clip says.
	 *
	 * For the one question that is the grid's own rather than a caller's: where
	 * the other half of a cluster is. A clip governs what may be *painted*, and
	 * repairing a cluster is the grid un-painting a cell it wrote itself -- so
	 * asking through the clip left a real orphan on screen. Overwriting half of a
	 * wide cluster whose other half sat one column outside the clip blanked
	 * nothing, and the diff then drew the surviving lead over both columns: the
	 * cell inside the clip had been changed and the glyph on screen had not. Both
	 * halves are damaged either way -- that is what painting over half a cluster
	 * means -- and only one of the two answers leaves the grid addressable, which
	 * is the whole of what the continuation marker is for.
	 *
	 * Reachable through the element tree's own `overflow: hidden`, not only
	 * through a stray `clipTo()`: a wide cluster drawn by one element across a
	 * clip boundary and overwritten by a clipped sibling is exactly it. Found by
	 * review; pre-existing, and it took a composite onto a clipped destination to
	 * go looking.
	 *
	 * It asks about the bounds and nothing else. An integer check was written here
	 * beside `inside()`'s and deleted for failing a sabotage: both callers are one
	 * column either side of a cell that has already been through `#at()`, which
	 * refuses a coordinate that is not a whole number, so `x ± 1` is an integer by
	 * the time it arrives. A guard that cannot fire is deleted rather than
	 * commented, and the invariant it stood for is this sentence.
	 */
	#onGrid(x: number, y: number): number {
		if (x < 0 || y < 0 || x >= this.#width || y >= this.#height) {
			return -1;
		}
		return y * this.#width + x;
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

	/**
	 * Whether anything has been painted into a cell.
	 *
	 * A blank painted deliberately answers `true` and a blank nothing touched
	 * answers `false`, which is the distinction a composite is built on and the
	 * one `charAt()` cannot make. A cell off the grid or outside the clip holds
	 * nothing by definition.
	 *
	 * @param x - The column.
	 * @param y - The row.
	 * @returns Whether a cell was painted.
	 */
	occupiedAt(x: number, y: number): boolean {
		const index = this.#at(x, y);
		return index >= 0 && this.#occupied[index] !== 0;
	}

	/** @internal Raw access, for the diff, which walks by index. */
	rawChars(): readonly string[] {
		return this.#chars;
	}

	/** @internal */
	rawStyles(): Int32Array {
		return this.#styles;
	}

	/** @internal Raw access, for the composite, which walks by index. */
	rawOccupied(): Uint8Array {
		return this.#occupied;
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

		// nothing here touches the occupancy, and that is a statement rather than an
		// omission. The repair leaves a blank *this grid painted*, so the cell has
		// to stay occupied -- and it already is: the only thing that writes a
		// `CONTINUATION` is `put()`, which occupies both halves of a cluster, so a
		// cell this function reaches was occupied before it got here. An assignment
		// was written for each branch and both were deleted for failing a sabotage:
		// neither could change an answer. What the behaviour comes to is asserted
		// instead, because it is the answer that matters rather than the line.

		if (this.#chars[index] === CONTINUATION) {
			// this is the right-hand half; the lead is the cell before it. Found
			// through `#onGrid()` rather than `#at()`, for the reason that method
			// gives: the repair is the grid's own and a clip must not be able to
			// leave half a glyph behind
			const lead = this.#onGrid(x - 1, y);
			if (lead >= 0) {
				this.#chars[lead] = BLANK;
				this.#styles[lead] = styleIndex;
			}
			return;
		}

		if (cellWidth(this.#chars[index]) === 2) {
			// this is the lead; its continuation follows
			const tail = this.#onGrid(x + 1, y);
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

		if (width === 2 && !this.inside(x + 1, y)) {
			// no room for the second half, whether that is the grid's edge or a clip
			// one column in. Half a wide glyph is worse than none, so a blank takes
			// the column -- which is the whole of what "clipping happens in cell
			// terms" asks for, and is why the clip lives down here
			this.#breakCluster(x, y, styleIndex);
			this.#chars[index] = BLANK;
			this.#styles[index] = styleIndex;
			// painted, deliberately, as a blank: a caller asked for a glyph here and
			// this is what a grid can represent, so the cell is this grid's
			this.#occupied[index] = 1;
			return 1;
		}

		this.#breakCluster(x, y, styleIndex);
		if (width === 2) {
			this.#breakCluster(x + 1, y, styleIndex);
		}

		this.#chars[index] = cluster;
		this.#styles[index] = styleIndex;
		this.#occupied[index] = 1;

		if (width === 2) {
			this.#chars[index + 1] = CONTINUATION;
			this.#styles[index + 1] = styleIndex;
			this.#occupied[index + 1] = 1;
		}

		return width;
	}

	/**
	 * Re-styles the cluster occupying a cell, leaving what it holds alone.
	 *
	 * The **cluster** rather than the cell, and that is the whole of why this is
	 * the grid's rather than a caller's: `put()` writes one style index to both
	 * halves of a wide cluster, and the diff draws the lead and skips the
	 * continuation -- so a style written to one half alone is a style the terminal
	 * is never told about, and the glyph comes out in the other half's. Reading it
	 * from either half gives the same answer for the same reason, so a caller may
	 * ask about whichever one it reached.
	 *
	 * What this is for is transient state over a frame somebody else painted: a
	 * selection highlight is a reverse-video pass over cells the tree drew, and it
	 * must not be able to change *what* they hold.
	 *
	 * Which is why it leaves the occupancy exactly as it found it. Whether a cell
	 * holds anything is part of what it holds, so a re-style cannot create
	 * content: highlighting a region nothing painted leaves it transparent, and in
	 * a layer those cells go on letting what is underneath through. That is the
	 * line that keeps the sentence above true.
	 *
	 * It is not reached over a layer either, and the reason is the opposite of
	 * what this comment used to claim: a selection is painted *inside*
	 * `canvas.paint()`'s callback, so it lands on the canvas's own grid **before**
	 * the layers composite over it rather than after. A layer therefore overwrites
	 * the highlight wherever it lands, which is the recorded decision -- a
	 * selection belongs to the live tree and a layer is a photograph -- and
	 * `restyle()` is never asked about a layer's cells at all. Found by a review
	 * round reading this sentence against the frame.
	 *
	 * @param x - The column.
	 * @param y - The row.
	 * @param styleIndex - The interned style to leave the cluster in.
	 */
	restyle(x: number, y: number, styleIndex: number): void {
		const index = this.#at(x, y);
		if (index < 0) {
			return;
		}

		this.#styles[index] = styleIndex;

		// the other half is found on the grid rather than through the clip, which
		// is `#breakCluster()`'s argument said for the style: the diff draws the
		// lead and skips the continuation, so a style written to one half alone is
		// a style the terminal is never told about -- and a clip one column inside
		// a cluster made that the ordinary case rather than the exotic one, since
		// `Painter.overlay()` asks `inside()` before it gets here
		if (this.#chars[index] === CONTINUATION) {
			const lead = this.#onGrid(x - 1, y);
			if (lead >= 0) {
				this.#styles[lead] = styleIndex;
			}
			return;
		}

		if (cellWidth(this.#chars[index]) === 2) {
			const tail = this.#onGrid(x + 1, y);
			if (tail >= 0) {
				this.#styles[tail] = styleIndex;
			}
		}
	}

	/**
	 * Paints a string, cluster by cluster, stopping at the right edge.
	 *
	 * @param x - The starting column.
	 * @param y - The row.
	 * @param text - The text. Split into clusters, so combining marks and emoji
	 * sequences stay whole.
	 * @param styleIndex - The interned style.
	 * @returns How far the cursor advanced from `x`, which is not the same as how
	 * many cells were painted: a run starting left of the grid advances over the
	 * columns it could not land in, so `x + returned` is where the next run goes
	 * whichever edge clipped this one. It stops at the right edge, because nothing
	 * can be painted past it.
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

			if (column < 0) {
				// left of the grid, which is not the answer the right edge gives:
				// advancing from here walks *into* it, so the run is clipped rather
				// than abandoned -- `fill()` already clips this way and the two are
				// painting the same thing. A wide cluster straddling column zero is
				// still refused, because a survivor is half a glyph, but only that
				// cluster and not the rest of the string
				column += cellWidth(cluster);
				continue;
			}

			const consumed = this.put(column, y, cluster, styleIndex);
			if (consumed === 0 && cellWidth(cluster) > 0) {
				// off the grid rather than zero-width: the row is not one, so nothing
				// further will land
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
	 * The occupancy travels with the contents, which is what makes a snapshot of
	 * the presented frame usable as a layer: a copy that kept the characters and
	 * lost which of them were painted would composite as a grid of transparent
	 * blanks wherever the frame had nothing on it, and the whole point of taking
	 * one is that it occludes exactly where the frame did.
	 *
	 * @param other - The buffer to copy from. A different size is taken on rather
	 * than refused: this grid is rebuilt at the other's and holds its contents,
	 * which is what `resize()` plus a copy would have come to. Said plainly
	 * because the sentence here used to read "must be the same size" over a body
	 * that reallocates -- true of both callers in the library, `present()` and
	 * `snapshot()`, and not a constraint the method has.
	 */
	copyFrom(other: CellBuffer): void {
		if (other.#width !== this.#width || other.#height !== this.#height) {
			this.#width = other.#width;
			this.#height = other.#height;
			// eslint-disable-next-line unicorn/no-new-array
			this.#chars = new Array<string>(other.#chars.length).fill(BLANK);
			this.#styles = new Int32Array(other.#styles.length);
			this.#occupied = new Uint8Array(other.#occupied.length);
		}
		for (let i = 0; i < this.#chars.length; i++) {
			this.#chars[i] = other.#chars[i];
		}
		this.#styles.set(other.#styles);
		this.#occupied.set(other.#occupied);
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

	/**
	 * Re-styles a run of cells that have already been painted.
	 *
	 * A **style override at paint time**, which is what a selection highlight has
	 * to be. The alternative is to write the highlight into the cells as though
	 * something had painted it there, and then it survives into the next frame's
	 * diff: a selection is transient state nobody drew, so it is recomputed from
	 * the live selection every frame and `paint()`'s own `clear()` is what removes
	 * the last one. Nothing here can change what a cell *holds*.
	 *
	 * A **run** rather than a rectangle, because the one rule this needs is about
	 * a row. A wide cluster's two cells share a style index and `restyle()`
	 * carries the change to both, so visiting the continuation after its lead
	 * would apply the transform twice -- and a transform that inverts is not
	 * idempotent, so a selected wide cluster came out *not* highlighted. A
	 * continuation is therefore skipped unless it is the run's first cell, where
	 * its lead sits outside the run and `restyle()` is what reaches it: a cluster
	 * is highlighted as a whole from whichever half the selection touched.
	 *
	 * Which is why the transform is asked **once per cluster, at its lead**: a run
	 * starting on a continuation is asked about the column one to the left, since
	 * that is where the character is and is what every other reader of those cells
	 * keys on.
	 *
	 * @param x - The first column.
	 * @param y - The row.
	 * @param length - How many columns.
	 * @param transform - The style to leave a cell in, or `undefined` to leave it
	 *   exactly as it is -- which is how a caller excludes a cell rather than
	 *   having to split the run around it. Its `x` is the cluster's lead.
	 */
	overlay(
		x: number,
		y: number,
		length: number,
		transform: (style: Style, x: number, y: number) => Partial<Style> | undefined
	): void {
		for (let column = x; column < x + length; column++) {
			if (!this.#buffer.inside(column, y)) {
				continue;
			}
			if (column > x && this.#buffer.charAt(column, y) === CONTINUATION) {
				// its lead was in this run and took it along
				continue;
			}

			// a run that *begins* on a continuation is asked about the lead that sits
			// outside it, because a cluster is one character and the lead is where it
			// is: `restyle()` already carries the style to both halves from either,
			// and anything else reading the run cell by cell -- `selectionText()`
			// grows left onto the lead for exactly this reason -- would otherwise be
			// answering about the other column. Two readers of one cluster that ask
			// at two cells is the divergence this file keeps rediscovering
			const at =
				column === x && column > 0 && this.#buffer.charAt(column, y) === CONTINUATION
					? column - 1
					: column;

			const current = this.#styles.get(this.#buffer.styleAt(column, y));
			const next = transform(current, at, y);
			if (next === undefined) {
				continue;
			}
			this.#buffer.restyle(column, y, this.#styles.intern(next));
		}
	}

	/**
	 * Draws with everything outside a rectangle left alone.
	 *
	 * Intersected with whatever clip is already in effect rather than replacing
	 * it, because a clipping box inside another one cannot paint where its parent
	 * could not: nesting is what `overflow: hidden` on a panel inside a scrolling
	 * pane means, and a clip that replaced would let the inner one paint back out
	 * over the outer one's edge.
	 *
	 * @param box - The rectangle to draw inside.
	 * @param draw - What to draw.
	 */
	clip(box: Clip, draw: (painter: Painter) => void): void {
		const previous = this.#buffer.clipTo(undefined);
		this.#buffer.clipTo(intersect(previous, box));
		try {
			draw(this);
		} finally {
			this.#buffer.clipTo(previous);
		}
	}
}

/**
 * The rectangle two clips both allow.
 *
 * @param outer - The clip already in effect, if any.
 * @param inner - The one being added.
 * @returns The overlap, which may be empty.
 */
function intersect(outer: Clip | undefined, inner: Clip): Clip {
	if (!outer) {
		return inner;
	}
	const x = Math.max(outer.x, inner.x);
	const y = Math.max(outer.y, inner.y);
	return {
		height: Math.max(0, Math.min(outer.y + outer.height, inner.y + inner.height) - y),
		width: Math.max(0, Math.min(outer.x + outer.width, inner.x + inner.width) - x),
		x,
		y,
	};
}
