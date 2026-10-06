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
 *
 * A frame may also have **layers** composited over it: a second grid plus where
 * its top-left sits relative to the canvas's, with a mask saying which of its
 * cells show. A layer's position is canvas-relative, which is exactly the thing
 * the canvas is allowed to know -- the screen position it refuses to know is a
 * backend's. What that buys is a transition, because `snapshot()` is the frame
 * that is already on screen and nothing else can reach it.
 *
 * ```js
 * import { maskThreshold, wipeMask } from '@ttylabs/sigil/canvas';
 *
 * const mask = wipeMask(canvas.width, canvas.height);
 * canvas.layers.push({ cells: canvas.snapshot(), mask, x: 0, y: 0 });
 * for (let frame = 30; frame >= 0; frame--) {
 *   mask.threshold = maskThreshold(frame / 30);
 *   canvas.paint(drawTheNewState);
 *   process.stdout.write(canvas.present().output);
 * }
 * canvas.layers.length = 0;
 * ```
 */

import { CellBuffer, Painter } from './buffer.js';
import { diff, type DiffResult } from './diff.js';
import { compositeAll, type Layer } from './layer.js';
import { StyleTable } from './style.js';

export {
	type CanvasBackend,
	createFullscreenCanvas,
	createInlineCanvas,
	type CursorProbe,
	type Draw,
	type FullscreenCanvasOptions,
	type InlineCanvasOptions,
} from './backend.js';
export { BLANK, CellBuffer, cellWidth, type Clip, CONTINUATION, Painter } from './buffer.js';
export { diff, type DiffOptions, type DiffResult } from './diff.js';
export { composite, compositeAll, type Layer } from './layer.js';
export {
	blueNoiseMask,
	dissolveMask,
	irisMask,
	type IrisOptions,
	type Mask,
	MASK_MAX,
	masked,
	maskThreshold,
	openMask,
	type Random,
	seeded,
	wipeMask,
	type WipeDirection,
} from './mask.js';
export {
	type Cell,
	createSelection,
	inSelection,
	paintSelection,
	type Selectable,
	type Selection,
	type SelectionMode,
	type SelectionRun,
	selectedStyle,
	selectionRuns,
	selectionText,
} from './selection.js';
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
	/**
	 * The grid the last frame was painted into, for reading.
	 *
	 * Exposed because a selection is text read back off the painted frame, and
	 * `toString()` is the wrong shape for that: it trims and joins, where
	 * extracting a region has to ask cell by cell and know which half of a wide
	 * cluster it is looking at. It is the **back** buffer, which `paint()` clears,
	 * fills and composites the layers over, so between frames it is what is on
	 * screen -- the composite included, which is what a selection over a frame
	 * mid-transition has to read.
	 *
	 * For reading rather than for painting. Nothing stops a caller writing to it
	 * -- the grid is a class with public methods -- and what that costs is a frame
	 * the next `paint()` wipes without the diff ever having been told, which is
	 * the trap `present()` copying forward rather than swapping already records.
	 * `paint()` is where drawing goes.
	 */
	readonly cells: CellBuffer;
	/** Drops what was painted, leaving a grid of blanks to paint onto. */
	clear(): void;
	readonly height: number;
	/**
	 * The grids composited over each frame, bottom first.
	 *
	 * Mutable, and the array `paint()` reads at the end of every frame: push a
	 * layer and it is in front of what was drawn, splice it out and it is gone.
	 * The last entry is on top, which is the reading document order already has
	 * everywhere else here.
	 *
	 * **A layer is live for exactly as long as it is in this array**, and that is
	 * not a style note -- it is what keeps its style indices meaning anything. The
	 * sweep reads the live set off `front` *and* off every layer here, so a grid
	 * that is not in it when a sweep runs is a grid whose indices moved underneath
	 * it. Two shapes reach that, and both are a window of exactly one
	 * `present()`: a layer taken out and put back, and a buffer painted or
	 * snapshotted *before* the `present()` that pushes it. Push in the same breath
	 * as the snapshot, which is what every transition does anyway, and park a
	 * layer by leaving it in with its mask's threshold at `-1` -- which composites
	 * nothing, because the mask already means "which cells show", so there is no
	 * second mechanism for hiding one.
	 */
	readonly layers: Layer[];
	/**
	 * Paints a frame. The buffer is cleared first, because a frame describes the
	 * whole canvas rather than a change to it -- leaving the last frame underneath
	 * would make anything that shrank leave a tail behind.
	 *
	 * The layers are composited at the end, so `cells` and `toString()` report the
	 * frame as it will be presented rather than the base somebody drew. A
	 * threshold moved without a `paint()` therefore changes nothing: a frame is a
	 * `paint()`, and the composite is a pass inside one.
	 *
	 * @param draw - Called with a painter over the back buffer.
	 */
	paint(draw: (painter: Painter, canvas: Canvas) => void): void;
	/**
	 * A painter over any grid, interning into this canvas's styles.
	 *
	 * Which is the one thing a caller building a layer cannot get from outside,
	 * and the reason it is a method rather than a note. A cell holds a style
	 * *index*, so a grid painted through a table of its own holds indices that
	 * mean something else here: `{ fg: palette(1) }` interned as 1 in one table
	 * and as 7 in another composites as whatever this canvas's 7 happens to be.
	 * `snapshot()` is already correct because the canvas painted it; anything else
	 * has to be painted through this.
	 *
	 * The table itself is deliberately not handed out. Only something that owns
	 * both the table and every grid painted with it can say when a `compact()` is
	 * safe, which is why nothing in `style.ts` calls one -- and a caller holding
	 * the table could.
	 *
	 * @param cells - The grid, whose own size is the layer's size.
	 * @returns A painter over it.
	 */
	painter(cells: CellBuffer): Painter;
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
	/**
	 * A copy of the frame that is on screen, to composite back over a later one.
	 *
	 * This is what makes layers worth having, and the only thing here that cannot
	 * be done from outside. A dissolve can be faked inside the `paint()` callback
	 * by painting conditionally -- but a transition needs the *previous* screen's
	 * content, and by the time anybody wants one the state that produced it is
	 * gone. `front` is exactly that snapshot and nothing else can reach it.
	 *
	 * The cheapest useful transition is three lines over this: snapshot, push it
	 * as a layer with a mask, ramp the threshold down to `-1` across the frames
	 * and then drop the layer. What the new frame paints shows through as the
	 * snapshot gives way.
	 *
	 * ```js
	 * const over = { cells: canvas.snapshot(), mask, x: 0, y: 0 };
	 * canvas.layers.push(over);
	 * // per frame
	 * over.mask.threshold = maskThreshold(1 - progress);
	 * canvas.paint(drawTheNewState);
	 * ```
	 *
	 * A copy rather than the buffer itself, because `present()` writes into
	 * `front` on every frame: handing the live one over would give a layer that
	 * tracked the screen it is supposed to be a snapshot of, which composites as
	 * a no-op.
	 *
	 * **Nothing presented is nothing on screen**, and that is what makes a
	 * transition do the right thing into a pipe for free. A backend with no
	 * terminal writes text and deliberately returns before `canvas.present()` --
	 * `render()` does call `backend.present()`, and that is the method which skips
	 * the diff rather than one nobody called -- there is
	 * nothing to repaint -- so `front` stays blank, a layer over the snapshot has
	 * no occupied cell to composite, and every frame of the ramp is the new state.
	 * One line of log and the end state, from the same code that dissolves on a
	 * terminal. That is the reduced-motion rule said one layer down: an animation
	 * with no screen to play on is one that has already finished.
	 *
	 * @returns A new grid holding what was last presented.
	 */
	snapshot(): CellBuffer;
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
	const layers: Layer[] = [];

	// set after a resize, so the next present repaints rather than diffing
	// against a grid that described a different screen
	let invalidated = true;

	// how big the table was left by the last sweep, which is what the next one
	// measures growth against
	let sweptSize = styles.size;

	/**
	 * Drops the styles nothing the canvas holds names any more.
	 *
	 * `paint()` clears the back buffer and interns again, and nothing drops an
	 * index, so the table only grows -- `Pixels.blit()` interning a style per
	 * cell turns that into a new entry per distinct pixel colour per frame. Once
	 * `present()` has copied back over front, `front` is what is on screen and
	 * the next `paint()` re-interns `back` from scratch.
	 *
	 * **And every layer, which is the half a layer stack changed.** This used to
	 * read the live set off `front` alone, on the argument that nothing else held
	 * an index worth keeping -- true while the canvas owned exactly two grids, and
	 * false the moment one persists across frames. A layer is the whole point of a
	 * dissolve: paint both states once and ramp for thirty frames, so it holds
	 * style indices across a `compact()` and would have them remapped to garbage
	 * underneath it. It is the shape of bug that ships: it fires only once the
	 * table has passed `SWEEP_MIN` **and** doubled, so a demo painting a dozen
	 * styles never reaches it and what it looks like when it does is a transition
	 * whose old frame turns the wrong colour part way through.
	 */
	const sweepStyles = (): void => {
		if (styles.size < SWEEP_MIN || styles.size < sweptSize * SWEEP_GROWTH) {
			return;
		}

		// a set rather than a list, because `remap()` is not idempotent: it rewrites
		// an index through `moved`, so a grid rewritten twice is read through the
		// map twice and lands on `moved[moved[i]]`. Two layers legitimately share
		// one buffer -- the same sprite at two origins is two `Layer`s over one grid
		// -- so the duplicate is reachable rather than pathological
		const grids = new Set<CellBuffer>([front, back]);
		for (const layer of layers) {
			grids.add(layer.cells);
		}

		const live = new Set<number>();
		for (const grid of grids) {
			for (const index of grid.rawStyles()) {
				live.add(index);
			}
		}

		const moved = styles.compact(live);

		// every grid whose indices have to keep meaning something, not just the one
		// that was read. `back` is what the next `present()` diffs against `front`
		// whether or not anything repainted it, and an index that moved under it
		// would make an unchanged frame differ; a layer is read by the next
		// composite and by every one after it
		for (const grid of grids) {
			remap(grid, moved);
		}
		sweptSize = styles.size;
	};

	const canvas: Canvas = {
		get cells() {
			return back;
		},

		clear(): void {
			back.clear();
		},

		get height() {
			return back.height;
		},

		layers,

		paint(draw): void {
			back.clear();
			draw(painter, canvas);
			// after the callback, so the layers are in front of what it drew, and
			// inside `paint()` rather than at the top of `present()` so that `cells`
			// and `toString()` report the frame that will be presented. The clip the
			// callback may have set is already back: `Painter.clip()` restores it in
			// a `finally`
			compositeAll(back, layers);
		},

		painter(cells): Painter {
			return new Painter(cells, styles);
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

			// the layers go with the grids, and that is the honest answer rather
			// than a convenience: a transition spanning a resize is undefined
			// because both grids are discarded, so a layer that survived one would
			// be a rectangle sized for a screen that no longer exists -- and worse,
			// its style indices would point into the table the line below empties.
			// Keeping them and sweeping them instead would mean compositing the old
			// screen's content over the new layout, which is the fragment-of-the-old
			// -frame failure a full repaint exists to prevent
			layers.length = 0;

			// every grid comes back blank, so nothing names a style: the one moment
			// the whole table is known to be garbage, and the only sweep that needs
			// no walk and no remapping
			styles.compact([]);
			sweptSize = styles.size;
			invalidated = true;
		},

		snapshot(): CellBuffer {
			const copy = new CellBuffer(front.width, front.height);
			copy.copyFrom(front);
			return copy;
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
