/**
 * Drawing at finer than one cell, by picking the character that looks like it.
 *
 * A cell is the smallest thing the grid can address, and a chart drawn at that
 * resolution is a staircase. Unicode has two families of characters that let a
 * cell stand in for a small grid of its own, and they trade against each other:
 *
 * | family     | resolution | colour                | support    |
 * | ---------- | ---------- | --------------------- | ---------- |
 * | braille    | 2x4        | one per cell          | very wide  |
 * | half block | 1x2        | one per half          | universal  |
 *
 * So braille is for shape -- plots, sparklines, anything where the line matters
 * more than the colour -- and half blocks are for pictures, where two pixels per
 * cell with their own colours beats eight without.
 *
 * Neither needs anything from the cell model: a braille pattern and a half block
 * are ordinary single-width clusters, which is the whole reason this is the tier
 * that works everywhere rather than the one that needs a protocol.
 */
import { type Painter } from './buffer.js';
import { DEFAULT_COLOR, type Color, type Style } from './style.js';

/** Columns of dots in one braille cell. */
const DOT_COLUMNS = 2;

/** Rows of dots in one braille cell. */
const DOT_ROWS = 4;

/** The base of the braille block; adding a dot mask to it names the character. */
const BRAILLE_BASE = 0x2800;

/**
 * Which bit each dot position sets.
 *
 * Indexed `[row][column]`. The numbering is not the obvious one: braille was six
 * dots read down the left column then down the right, and the two-dot eighth row
 * was appended later, so rows 0-2 are bits 0-2 and 5-7 while the bottom row is
 * bits 3 and 7. Writing the table out beats deriving it and getting it subtly
 * wrong.
 */
const DOT_BITS: readonly (readonly number[])[] = [
	[0x01, 0x08],
	[0x02, 0x10],
	[0x04, 0x20],
	[0x40, 0x80],
];

/** Vertical half blocks: nothing, upper, lower, full. */
const UPPER_HALF = '▀';
const LOWER_HALF = '▄';
const FULL_BLOCK = '█';

/**
 * A grid of dots, two across and four down per cell, drawn in braille.
 *
 * Monochrome by construction: a braille cell is one character, so it carries one
 * foreground. That is the trade -- eight times the resolution for one colour per
 * cell -- and it is the right one for a plot, where the shape is the data.
 */
export class Dots {
	readonly #cells: Uint8Array;
	readonly #width: number;
	readonly #height: number;

	/**
	 * @param width - Width in **cells**, not dots.
	 * @param height - Height in **cells**, not dots.
	 */
	constructor(width: number, height: number) {
		this.#width = Math.max(0, Math.trunc(width));
		this.#height = Math.max(0, Math.trunc(height));
		this.#cells = new Uint8Array(this.#width * this.#height);
	}

	/** Width in cells. */
	get width(): number {
		return this.#width;
	}

	/** Height in cells. */
	get height(): number {
		return this.#height;
	}

	/** Width in dots. */
	get dotWidth(): number {
		return this.#width * DOT_COLUMNS;
	}

	/** Height in dots. */
	get dotHeight(): number {
		return this.#height * DOT_ROWS;
	}

	/** Turns every dot off. */
	clear(): void {
		this.#cells.fill(0);
	}

	/**
	 * Turns a dot on.
	 *
	 * Out of range is ignored rather than refused: a plot clips at its box, and
	 * making every caller bounds-check before every point is how a plot ends up
	 * with the check in the wrong place.
	 *
	 * @param x - Dot column.
	 * @param y - Dot row.
	 */
	set(x: number, y: number): void {
		this.#poke(x, y, true);
	}

	/**
	 * Turns a dot off.
	 *
	 * @param x - Dot column.
	 * @param y - Dot row.
	 */
	unset(x: number, y: number): void {
		this.#poke(x, y, false);
	}

	/**
	 * Whether a dot is on.
	 *
	 * @param x - Dot column.
	 * @param y - Dot row.
	 * @returns Whether it is set. Out of range is `false`.
	 */
	get(x: number, y: number): boolean {
		const at = this.#locate(x, y);
		return at !== undefined && (this.#cells[at.index] & at.bit) !== 0;
	}

	/**
	 * Draws a straight line of dots between two points.
	 *
	 * Bresenham, in integers, because a plot is mostly lines between samples and
	 * the alternative is every caller writing this loop again.
	 *
	 * @param x0 - Start dot column.
	 * @param y0 - Start dot row.
	 * @param x1 - End dot column.
	 * @param y1 - End dot row.
	 */
	line(x0: number, y0: number, x1: number, y1: number): void {
		let x = Math.trunc(x0);
		let y = Math.trunc(y0);
		const endX = Math.trunc(x1);
		const endY = Math.trunc(y1);

		// a missing sample is the ordinary way a plot reaches this, and the loop
		// below ends only by arriving at the end point. `NaN === NaN` is false and
		// a step towards an infinity never arrives, so a non-finite endpoint spins
		// forever -- and paints nothing while it does, since `set()` ignores what
		// is out of range. A finite point outside the grid is a different thing and
		// still clips, which is what a plot wants
		if (
			!Number.isFinite(x) ||
			!Number.isFinite(y) ||
			!Number.isFinite(endX) ||
			!Number.isFinite(endY)
		) {
			return;
		}

		const dx = Math.abs(endX - x);
		const dy = -Math.abs(endY - y);
		const stepX = x < endX ? 1 : -1;
		const stepY = y < endY ? 1 : -1;
		let error = dx + dy;

		for (;;) {
			this.set(x, y);
			if (x === endX && y === endY) {
				return;
			}
			const doubled = 2 * error;
			if (doubled >= dy) {
				error += dy;
				x += stepX;
			}
			if (doubled <= dx) {
				error += dx;
				y += stepY;
			}
		}
	}

	/**
	 * The braille character for one cell.
	 *
	 * @param x - Cell column.
	 * @param y - Cell row.
	 * @returns The character, or `undefined` when no dot in it is set.
	 */
	charAt(x: number, y: number): string | undefined {
		if (x < 0 || y < 0 || x >= this.#width || y >= this.#height) {
			return undefined;
		}
		const mask = this.#cells[y * this.#width + x];
		return mask === 0 ? undefined : String.fromCodePoint(BRAILLE_BASE + mask);
	}

	/**
	 * Paints onto a canvas.
	 *
	 * A cell with no dots set is left alone rather than painted blank. The braille
	 * blank is a real character that some fonts draw the dot frame for, and
	 * leaving it out is what lets a plot sit on top of a background someone else
	 * drew.
	 *
	 * @param painter - Where to paint.
	 * @param x - The canvas column of this grid's left edge.
	 * @param y - The canvas row of its top edge.
	 * @param style - How the dots look.
	 */
	blit(painter: Painter, x: number, y: number, style: Partial<Style> = {}): void {
		for (let row = 0; row < this.#height; row++) {
			// a run of set cells goes out as one string; a gap ends it, because the
			// point of skipping blanks is not painting them
			let run = '';
			let runStart = 0;
			for (let column = 0; column <= this.#width; column++) {
				const cell = column < this.#width ? this.charAt(column, row) : undefined;
				if (cell === undefined) {
					if (run) {
						painter.text(x + runStart, y + row, run, style);
						run = '';
					}
					continue;
				}
				if (!run) {
					runStart = column;
				}
				run += cell;
			}
		}
	}

	/**
	 * The cell and bit a dot lives in.
	 *
	 * @param x - Dot column.
	 * @param y - Dot row.
	 * @returns The cell index and bit, or `undefined` when out of range.
	 */
	#locate(x: number, y: number): { bit: number; index: number } | undefined {
		const dotX = Math.trunc(x);
		const dotY = Math.trunc(y);
		// a point that is not a number is out of range, and the comparisons below
		// cannot say so: every one of them is false for `NaN`, so it reached
		// `DOT_BITS[NaN]` -- `undefined` -- and the row lookup threw a `TypeError`
		// from inside a method whose whole contract is to ignore what it cannot
		// place
		if (
			!Number.isFinite(dotX) ||
			!Number.isFinite(dotY) ||
			dotX < 0 ||
			dotY < 0 ||
			dotX >= this.dotWidth ||
			dotY >= this.dotHeight
		) {
			return undefined;
		}
		const cellX = Math.floor(dotX / DOT_COLUMNS);
		const cellY = Math.floor(dotY / DOT_ROWS);
		return {
			bit: DOT_BITS[dotY % DOT_ROWS][dotX % DOT_COLUMNS],
			index: cellY * this.#width + cellX,
		};
	}

	/**
	 * @param x - Dot column.
	 * @param y - Dot row.
	 * @param on - Whether to set or clear.
	 */
	#poke(x: number, y: number, on: boolean): void {
		const at = this.#locate(x, y);
		if (at === undefined) {
			return;
		}
		if (on) {
			this.#cells[at.index] |= at.bit;
		} else {
			this.#cells[at.index] &= ~at.bit;
		}
	}
}

/**
 * A grid of coloured pixels, one across and two down per cell.
 *
 * Each cell becomes an upper half block whose foreground is the top pixel and
 * whose background is the bottom one, so both halves keep their own colour. That
 * is half the vertical resolution braille gives and all of the colour, which is
 * the trade a picture wants.
 */
export class Pixels {
	readonly #colors: Int32Array;
	readonly #width: number;
	readonly #height: number;

	/**
	 * @param width - Width in **cells**, which is also the width in pixels.
	 * @param height - Height in **cells**, not pixels.
	 */
	constructor(width: number, height: number) {
		this.#width = Math.max(0, Math.trunc(width));
		this.#height = Math.max(0, Math.trunc(height));
		this.#colors = new Int32Array(this.#width * this.#height * 2).fill(DEFAULT_COLOR);
	}

	/** Width in cells, which is also the width in pixels. */
	get width(): number {
		return this.#width;
	}

	/** Height in cells. */
	get height(): number {
		return this.#height;
	}

	/** Height in pixels. */
	get pixelHeight(): number {
		return this.#height * 2;
	}

	/** Puts every pixel back to the terminal's own colour. */
	clear(): void {
		this.#colors.fill(DEFAULT_COLOR);
	}

	/**
	 * Colours a pixel. Out of range is ignored, as it is for `Dots`.
	 *
	 * @param x - Pixel column.
	 * @param y - Pixel row.
	 * @param color - What colour.
	 */
	set(x: number, y: number, color: Color): void {
		const index = this.#index(x, y);
		if (index !== undefined) {
			this.#colors[index] = color;
		}
	}

	/**
	 * A pixel's colour.
	 *
	 * @param x - Pixel column.
	 * @param y - Pixel row.
	 * @returns The colour, or the default when out of range.
	 */
	get(x: number, y: number): Color {
		const index = this.#index(x, y);
		return index === undefined ? DEFAULT_COLOR : this.#colors[index];
	}

	/**
	 * Paints onto a canvas.
	 *
	 * A cell whose halves are both the terminal's own colour is skipped, for the
	 * reason `Dots.blit` skips an empty cell: nothing was drawn there.
	 *
	 * @param painter - Where to paint.
	 * @param x - The canvas column of this grid's left edge.
	 * @param y - The canvas row of its top edge.
	 */
	blit(painter: Painter, x: number, y: number): void {
		for (let row = 0; row < this.#height; row++) {
			for (let column = 0; column < this.#width; column++) {
				const top = this.get(column, row * 2);
				const bottom = this.get(column, row * 2 + 1);

				if (top === DEFAULT_COLOR && bottom === DEFAULT_COLOR) {
					continue;
				}

				// one character per case rather than always the upper half: a solid
				// cell as `█` in one colour survives a terminal that renders the half
				// blocks a pixel short, which several do at small font sizes
				if (top === bottom) {
					painter.text(x + column, y + row, FULL_BLOCK, { fg: top });
				} else if (bottom === DEFAULT_COLOR) {
					painter.text(x + column, y + row, UPPER_HALF, { fg: top });
				} else if (top === DEFAULT_COLOR) {
					painter.text(x + column, y + row, LOWER_HALF, { fg: bottom });
				} else {
					painter.text(x + column, y + row, UPPER_HALF, { bg: bottom, fg: top });
				}
			}
		}
	}

	/**
	 * @param x - Pixel column.
	 * @param y - Pixel row.
	 * @returns The index into the colour array, or `undefined` when out of range.
	 */
	#index(x: number, y: number): number | undefined {
		const pixelX = Math.trunc(x);
		const pixelY = Math.trunc(y);
		// out of range for the reason `Dots.#locate()` gives. It does not throw
		// here, which is worse rather than better: the index came out `NaN`, a
		// write to it was silently dropped, and `get()` handed back `undefined`
		// with `Color` written on it
		if (
			!Number.isFinite(pixelX) ||
			!Number.isFinite(pixelY) ||
			pixelX < 0 ||
			pixelY < 0 ||
			pixelX >= this.#width ||
			pixelY >= this.pixelHeight
		) {
			return undefined;
		}
		return pixelY * this.#width + pixelX;
	}
}
