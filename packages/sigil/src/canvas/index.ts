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
 * import { createCanvas, palette } from '@ttylabs/sigil/canvas';
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
export { Dots, Pixels } from './subcell.js';
export {
	ATTR,
	type Color,
	DEFAULT_COLOR,
	DEFAULT_STYLE,
	LINK_OFF,
	palette,
	RESET,
	rgb,
	type Style,
	StyleTable,
	transition,
} from './style.js';

/**
 * How many styles the table has to hold before a sweep is worth the walk, and
 * by what factor it has to have outgrown what survived the last one.
 *
 * Both halves are the same point from different ends. Reading the live set means
 * walking every cell of the front buffer, and an ordinary TUI would be paying
 * that every frame to reclaim nothing: its table settles at a couple of dozen
 * entries and never moves again. Measured at 80x24, a sweep of such a grid is
 * 0.013ms against a frame that costs 0.10ms to paint and present -- an eighth of
 * the frame, every frame, to free nothing at all. A canvas that legitimately
 * paints two thousand styles a frame would be paying to free nothing either,
 * which is what the growth factor answers: it bounds the table at twice what a
 * frame actually uses, and costs one integer comparison in the case that never
 * needs it. The same measurement on a truecolour frame -- 1,920 live styles --
 * is 0.22ms of a 3.5ms frame, and the growth factor spends it every other frame.
 */
const SWEEP_MIN = 256;
const SWEEP_GROWTH = 2;

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
 * Rewrites a grid's style indices through what a compaction moved.
 *
 * @param buffer - The grid.
 * @param moved - Where each old index went.
 */
function remap(buffer: CellBuffer, moved: Int32Array): void {
	const indices = buffer.rawStyles();
	for (let i = 0; i < indices.length; i++) {
		indices[i] = moved[indices[i]];
	}
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

	// how big the table was left by the last sweep, which is what the next one
	// measures growth against
	let sweptSize = styles.size;

	/**
	 * Drops the styles the presented frame stopped naming.
	 *
	 * `paint()` clears the back buffer and interns again, and nothing drops an
	 * index, so the table only grows -- `Pixels.blit()` interning a style per
	 * cell turns that into a new entry per distinct pixel colour per frame. Once
	 * `present()` has copied back over front, the live set is whatever `front`
	 * names: the next `paint()` clears `back` and interns from scratch, so no
	 * other grid's indices have to keep meaning anything.
	 */
	const sweepStyles = (): void => {
		if (styles.size < SWEEP_MIN || styles.size < sweptSize * SWEEP_GROWTH) {
			return;
		}

		const live = new Set<number>();
		for (const index of front.rawStyles()) {
			live.add(index);
		}

		const moved = styles.compact(live);

		// both grids, not just the one that was read: `back` is what the next
		// `present()` diffs against `front`, whether or not anything repainted it,
		// and an index that moved under it would make an unchanged frame differ
		remap(front, moved);
		remap(back, moved);
		sweptSize = styles.size;
	};

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
			sweepStyles();

			return result;
		},

		resize(width, height): void {
			back.resize(width, height);
			front.resize(width, height);

			// both grids come back blank, so nothing names a style: the one moment
			// the whole table is known to be garbage, and the only sweep that needs
			// no walk and no remapping
			styles.compact([]);
			sweptSize = styles.size;
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
