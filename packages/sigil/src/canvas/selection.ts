/**
 * A selection, which is two cells and a mode.
 *
 * **Over the painted grid rather than over the element tree**, and that is the
 * decision the whole feature rests on. The tree version is to walk the texts
 * between two elements and concatenate them, which gives semantically tidy text
 * and needs a *reading order* for a flexbox tree -- which flexbox does not have.
 * A `row-reverse` of three texts has no answer, and an absolutely positioned
 * overlay sitting on top of a paragraph has a worse one. The grid is the thing
 * the user is actually pointing at; it already knows what a wide cluster is and
 * where its continuation went; `toLines()` was already here; and one cell pair
 * gives both a linear and a rectangular selection with no second model.
 *
 * What it costs is that the text is **laid-out** text: a paragraph that wrapped
 * copies with its wrap points in it, and a row of two columns copies both
 * columns' cells on each line. That is what selecting from a terminal has always
 * given you, and the rectangular mode is the answer to the second half of it.
 *
 * Nothing here knows about colour levels, elements, or the clipboard. The level
 * is the renderer's, because that is where it already lives; what a cell may be
 * copied *from* is the element tree's, and arrives as the `selectable`
 * predicate; and OSC 52 is `src/terminal/clipboard.ts`.
 */

import { BLANK, type CellBuffer, cellWidth, CONTINUATION, type Painter } from './buffer.js';
import { ATTR, type Style } from './style.js';

/** A cell, in the canvas's own zero-based coordinates. */
export interface Cell {
	readonly x: number;
	readonly y: number;
}

/**
 * How the two cells are read.
 *
 * `linear` is a terminal's ordinary selection: from the anchor to the end of its
 * row, every row between, and the start of the focus's row up to it. `block` is
 * the rectangle they span, which is what copies one column of a two-pane layout
 * without the other -- the reason selection is not scoped to a clipping box.
 */
export type SelectionMode = 'block' | 'linear';

export interface Selection {
	readonly anchor: Cell;
	readonly focus: Cell;
	readonly mode: SelectionMode;
}

/** One row's worth of a selection: where it starts and how many columns. */
export interface SelectionRun {
	readonly length: number;
	readonly x: number;
	readonly y: number;
}

/**
 * Whether a cell may be copied, which the element tree answers.
 *
 * Passed in rather than asked for, so that this module stays testable with a
 * literal and knows nothing about elements.
 */
export type Selectable = (x: number, y: number) => boolean;

/**
 * A selection over two cells.
 *
 * Inclusive of both ends, like a terminal's: an anchor and a focus on the same
 * cell is one cell selected rather than none. Which is why a plain click does
 * not make one -- a driver clears on the press and sets this on the first drag
 * report, so a click with no drag leaves nothing selected, exactly as a terminal
 * does.
 *
 * @param anchor - Where the selection started.
 * @param focus - Where it has got to. The anchor, if omitted.
 * @param mode - Linear, by default.
 * @returns The selection.
 */
export function createSelection(
	anchor: Cell,
	focus: Cell = anchor,
	mode: SelectionMode = 'linear'
): Selection {
	return Object.freeze({
		anchor: Object.freeze({ x: Math.trunc(anchor.x), y: Math.trunc(anchor.y) }),
		focus: Object.freeze({ x: Math.trunc(focus.x), y: Math.trunc(focus.y) }),
		mode,
	});
}

/** The two cells in reading order, whichever way round they were made. */
function ordered(sel: Selection): [Cell, Cell] {
	const { anchor, focus } = sel;
	const after = focus.y > anchor.y || (focus.y === anchor.y && focus.x >= anchor.x);
	return after ? [anchor, focus] : [focus, anchor];
}

/** A number clamped into a half-open range. */
function clamp(value: number, limit: number): number {
	return Math.max(0, Math.min(limit - 1, value));
}

/**
 * Which cells a selection covers, one run per row.
 *
 * Clamped to the grid rather than refused: a drag that wandered off the canvas
 * is the ordinary case -- a press captures the pointer, so the focus really can
 * be outside -- and what the user means by it is the edge.
 *
 * @param sel - The selection.
 * @param width - The grid's width.
 * @param height - The grid's height.
 * @returns One run per row, top to bottom. Empty for a grid with no cells.
 */
export function selectionRuns(
	sel: Selection,
	width: number,
	height: number
): readonly SelectionRun[] {
	if (width <= 0 || height <= 0) {
		return [];
	}

	const [start, end] = ordered(sel);
	const top = clamp(start.y, height);
	const bottom = clamp(end.y, height);
	const runs: SelectionRun[] = [];

	if (sel.mode === 'block') {
		// the rectangle the two cells span, which reads the columns independently of
		// the rows -- so the anchor being the *lower* of the two says nothing about
		// which column it is
		const left = Math.min(clamp(sel.anchor.x, width), clamp(sel.focus.x, width));
		const right = Math.max(clamp(sel.anchor.x, width), clamp(sel.focus.x, width));
		for (let y = top; y <= bottom; y++) {
			runs.push({ length: right - left + 1, x: left, y });
		}
		return runs;
	}

	const from = clamp(start.x, width);
	const to = clamp(end.x, width);

	if (top === bottom) {
		return [{ length: to - from + 1, x: from, y: top }];
	}

	runs.push({ length: width - from, x: from, y: top });
	for (let y = top + 1; y < bottom; y++) {
		runs.push({ length: width, x: 0, y });
	}
	runs.push({ length: to + 1, x: 0, y: bottom });
	return runs;
}

/**
 * Whether a selection covers a cell, asked of `selectionRuns()` rather than
 * worked out again.
 *
 * It had its own arithmetic over the raw endpoints once, and the two readers
 * disagreed the moment an endpoint was off the grid -- which a captured drag
 * reaches as a matter of course. There is one implementation of what a
 * selection covers now, so they cannot.
 *
 * Takes a whole grid rather than a width because membership is
 * `selectionRuns()`'s answer and that needs both: the height is what decides
 * which row is the selection's first, and a row the clamp promoted is a row
 * whose run starts at a column rather than at zero. The cell is truncated the
 * way `createSelection()` truncates its own, so a `Cell` means the same thing
 * at both entry points.
 *
 * @param sel - The selection.
 * @param cell - The cell.
 * @param grid - The grid's size.
 * @returns Whether it is in.
 */
export function inSelection(
	sel: Selection,
	cell: Cell,
	grid: { height: number; width: number }
): boolean {
	const x = Math.trunc(cell.x);
	const y = Math.trunc(cell.y);

	// one run per row, so the row that matches is the whole answer
	for (const run of selectionRuns(sel, grid.width, grid.height)) {
		if (run.y === y) {
			return x >= run.x && x < run.x + run.length;
		}
	}
	return false;
}

/**
 * The text a selection covers, read off the grid.
 *
 * Three rules, each of which is somebody's bug report waiting to happen:
 *
 * - **a wide cluster comes out whole.** A continuation holds nothing, so it
 *   contributes nothing -- and a run that *begins* on one takes the lead that
 *   sits outside it, which is the same rule the highlight keeps through
 *   `restyle()`. Half a character is not a character.
 * - **trailing blanks go, per line.** The reason `renderToString()` already
 *   gives: a region padded out to the pane's width is one nobody can paste
 *   anywhere useful. Per line rather than over the whole text, because the lines
 *   between two long ones are legitimately short.
 * - **a cell nothing may copy comes out as a blank**, not as nothing. A
 *   sparkline's columns are not characters anybody wants, and dropping them
 *   would pull the text on either side together and misalign every line that
 *   crossed one. A blank keeps the shape, and the trailing-blank rule above
 *   drops it where it was at the end anyway.
 *
 * @param buffer - The grid, which is the frame last painted.
 * @param sel - The selection.
 * @param opts - `selectable` is what the element tree says about each cell.
 * @returns The text, rows joined by newlines.
 */
export function selectionText(
	buffer: CellBuffer,
	sel: Selection,
	opts: { selectable?: Selectable } = {}
): string {
	const { selectable } = opts;
	const lines: string[] = [];

	for (const run of selectionRuns(sel, buffer.width, buffer.height)) {
		let line = '';
		let from = run.x;
		if (from > 0 && buffer.charAt(from, run.y) === CONTINUATION) {
			from--;
		}

		for (let x = from; x < run.x + run.length; x++) {
			const cell = buffer.charAt(x, run.y);
			if (cell === CONTINUATION) {
				continue;
			}
			line +=
				selectable && !selectable(x, run.y) ? BLANK.repeat(Math.max(1, cellWidth(cell))) : cell;
		}

		lines.push(line.replace(/ +$/, ''));
	}

	return lines.join('\n');
}

/**
 * The style a selected cell is shown in.
 *
 * Reverse video, and **toggled rather than set**: a cell an app already drew
 * inverse comes out un-inverted when it is selected, which is what a terminal's
 * own selection does to one and is the only reading under which the highlight is
 * visible on every cell. Setting the bit would make a selection over an inverse
 * run invisible, which is the one case the highlight exists for.
 *
 * @param style - What the cell is painted in.
 * @returns What it should look like while selected.
 */
export function selectedStyle(style: Style): Partial<Style> {
	return { ...style, attrs: style.attrs ^ ATTR.inverse };
}

/**
 * Draws a selection over a frame, as a style override and nothing else.
 *
 * Called **after** the tree has been painted and inside the same `render()`, so
 * that it is over everything drawn and is gone the moment the next frame clears
 * the grid. Nothing is written into the cells: see `Painter.overlay()`.
 *
 * A cell `selectable` refuses is left alone rather than highlighted, because a
 * highlight over something that will not copy is a lie about what Ctrl-C-equivalent
 * would give you.
 *
 * @param painter - The painter the frame was drawn through.
 * @param sel - The selection.
 * @param opts - The grid's size, and what may be copied.
 */
export function paintSelection(
	painter: Painter,
	sel: Selection,
	opts: { height: number; selectable?: Selectable; width: number }
): void {
	const { selectable } = opts;
	for (const run of selectionRuns(sel, opts.width, opts.height)) {
		painter.overlay(run.x, run.y, run.length, (style, x, y) =>
			selectable && !selectable(x, y) ? undefined : selectedStyle(style)
		);
	}
}
