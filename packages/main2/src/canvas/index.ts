/**
 * A cell-addressable drawing surface, and the diff that puts it on screen.
 *
 * A canvas is a rect of cells plus a way to reconcile it with what the terminal
 * is already showing. It is deliberately not a rect plus a *position*: where the
 * rect sits is a backend's business -- inline at the bottom of a scrolling log,
 * or the whole alternate screen -- and nothing above the canvas should know
 * which. Everything here is relative to the canvas's own top-left.
 *
 * ```js
 * import { createCanvas, palette } from 'main2/canvas';
 *
 * const canvas = createCanvas({ width: 20, height: 1 });
 * canvas.paint((p) => p.text(0, 0, 'Loading...', { fg: palette(4) }));
 * process.stdout.write(canvas.present().output);
 * ```
 */

import { CellBuffer, Painter } from './buffer.js';
import { diff, type DiffResult } from './diff.js';
import { StyleTable } from './style.js';

export { BLANK, CellBuffer, cellWidth, CONTINUATION, Painter } from './buffer.js';
export { diff, type DiffOptions, type DiffResult } from './diff.js';
export {
	ATTR,
	type Color,
	DEFAULT_COLOR,
	DEFAULT_STYLE,
	palette,
	RESET,
	rgb,
	type Style,
	StyleTable,
	transition,
} from './style.js';

export interface CanvasOptions {
	height: number;
	width: number;
}

export interface Canvas {
	/** Drops what was painted, leaving a grid of blanks to paint onto. */
	clear(): void;
	readonly height: number;
	/**
	 * Paints a frame. The buffer is cleared first, because a frame describes the
	 * whole canvas rather than a change to it -- leaving the last frame underneath
	 * would make anything that shrank leave a tail behind.
	 *
	 * @param draw - Called with a painter over the back buffer.
	 */
	paint(draw: (painter: Painter, canvas: Canvas) => void): void;
	/**
	 * Reconciles the terminal with what was last painted.
	 *
	 * The cursor is assumed to be at the canvas's top-left when the returned
	 * sequence is written, and the result says where it ends up.
	 *
	 * @param opts - `full` repaints every cell rather than diffing.
	 * @returns The sequence to write, and the final cursor position.
	 */
	present(opts?: { full?: boolean }): DiffResult;
	/**
	 * Resizes, discarding both frames.
	 *
	 * The next `present()` is a full repaint whatever it is asked for: the grid
	 * that was on screen described a terminal that no longer exists, so there is
	 * nothing meaningful to diff against.
	 *
	 * @param width - The new width.
	 * @param height - The new height.
	 */
	resize(width: number, height: number): void;
	/** What the last painted frame says, as plain text. For tests. */
	toString(): string;
	readonly width: number;
}

/**
 * Builds a canvas.
 *
 * @param opts - The size.
 * @returns The canvas.
 */
export function createCanvas(opts: CanvasOptions): Canvas {
	const styles = new StyleTable();
	let back = new CellBuffer(opts.width, opts.height);
	let front = new CellBuffer(opts.width, opts.height);
	let painter = new Painter(back, styles);

	// set after a resize, so the next present repaints rather than diffing
	// against a grid that described a different screen
	let invalidated = true;

	const canvas: Canvas = {
		clear(): void {
			back.clear();
		},

		get height() {
			return back.height;
		},

		paint(draw): void {
			back.clear();
			draw(painter, canvas);
		},

		present(presentOpts = {}): DiffResult {
			const result = diff(front, back, {
				full: presentOpts.full || invalidated,
				styles,
			});
			invalidated = false;

			// the frame just written becomes what the next one is compared against.
			// Copied rather than swapped: swapping would leave `back` holding the
			// frame before last, and `back` is what the canvas reports as its
			// current contents. A grid this size copies in microseconds, and a
			// canvas whose `toString()` lies is a debugging trap
			front.copyFrom(back);

			return result;
		},

		resize(width, height): void {
			back.resize(width, height);
			front.resize(width, height);
			invalidated = true;
		},

		toString(): string {
			return back.toString();
		},

		get width() {
			return back.width;
		},
	};

	return canvas;
}
