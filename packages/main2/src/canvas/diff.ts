import { cursorDown, cursorRight, cursorUp } from '../terminal/sequences.js';
import { type CellBuffer, cellWidth, CONTINUATION } from './buffer.js';
import { DEFAULT_STYLE, RESET, type Style, StyleTable, transition } from './style.js';

/**
 * Turning two grids into the fewest bytes that reconcile them.
 *
 * This is the point of the whole module. Redrawing every cell on every frame
 * flickers locally and is unusable over ssh, and a terminal is the one display
 * where the wire between the renderer and the screen is narrow enough to be the
 * bottleneck.
 *
 * Movement is **relative** to where the cursor started, never absolute. The
 * canvas does not know where on the screen it sits -- the inline backend parks
 * it at the bottom of a scrolling log and the full-screen backend puts it at the
 * origin -- so everything here is expressed as "from the top-left of the canvas"
 * and the backend is what decides where that is.
 *
 * That relativity carries a precondition the backend has to meet: **every row
 * of the canvas must already exist below the cursor.** Downward movement is CUD,
 * which stops at the bottom margin and never scrolls, so a canvas rendered with
 * the cursor on the last row of the screen paints every one of its rows onto
 * that one line. The inline backend's first frame is exactly that case, and its
 * recipe is to write `height - 1` newlines and then walk back up before the
 * first present.
 */

/**
 * How many cells of skipped-but-unchanged content are worth redrawing rather
 * than jumping over.
 *
 * A cursor move costs about four bytes, so a gap shorter than that is cheaper
 * to paint through than to skip -- and painting through it avoids a move, which
 * some terminals handle worse than a write.
 */
const GAP = 4;

export interface DiffOptions {
	/**
	 * Ignore the previous frame and repaint every cell.
	 *
	 * What a resize needs: the grid that was on screen described a terminal that
	 * no longer exists, so there is nothing to diff against and pretending
	 * otherwise leaves fragments of the old layout behind.
	 */
	full?: boolean;
	/** The styles both grids were painted with. */
	styles: StyleTable;
}

/** Where the cursor is left, so the caller can put it somewhere sensible. */
export interface DiffResult {
	/**
	 * The column, relative to the canvas's left edge, and never past the last
	 * one. A terminal writing the final column does not advance the cursor past
	 * it -- it sets a pending-wrap flag instead and stays put -- so reporting
	 * `width` would name a column that does not exist and put any backend
	 * computing a relative move one out.
	 */
	column: number;
	/** The row, relative to the canvas's top edge. */
	row: number;
	/** The sequence that reconciles the two grids. Empty when nothing changed. */
	output: string;
	/**
	 * Whether the last thing written was the final column of a row, leaving the
	 * terminal's deferred wrap armed.
	 *
	 * It is cleared by any cursor movement, so a backend that repositions before
	 * writing anything can ignore this. One that writes straight after -- a
	 * newline, or the app's own output -- cannot: on a terminal that wraps
	 * immediately rather than deferring, that write lands on the next row.
	 */
	wrapPending: boolean;
}

/**
 * Whether a cell differs between two grids.
 *
 * A continuation is compared like any other cell. It never carries a grapheme,
 * but it does carry a style, and a wide character whose background changed has
 * to repaint both of its columns.
 *
 * @param a - The previous grid.
 * @param b - The next grid.
 * @param index - The cell.
 * @returns Whether it changed.
 */
function changed(a: CellBuffer, b: CellBuffer, index: number): boolean {
	return (
		a.rawChars()[index] !== b.rawChars()[index] || a.rawStyles()[index] !== b.rawStyles()[index]
	);
}

/**
 * The first column of the cluster occupying a cell.
 *
 * A continuation cannot be drawn on its own -- writing at its column would put
 * the cursor in the middle of a glyph -- so a run that begins on one has to
 * start at the lead cell instead.
 *
 * @param buffer - The grid.
 * @param x - The column.
 * @param y - The row.
 * @returns The column the cluster starts at.
 */
function clusterStart(buffer: CellBuffer, x: number, y: number): number {
	return x > 0 && buffer.charAt(x, y) === CONTINUATION ? x - 1 : x;
}

/**
 * The sequence that turns `previous` into `next`.
 *
 * The cursor is assumed to start at the canvas's top-left, and is left wherever
 * the last run ended -- `DiffResult` says where that is.
 *
 * @param previous - What is on screen.
 * @param next - What should be.
 * @param opts - The style table, and whether to ignore the previous frame.
 * @returns The sequence and the final cursor position.
 */
export function diff(previous: CellBuffer, next: CellBuffer, opts: DiffOptions): DiffResult {
	const { styles } = opts;
	const width = next.width;
	const height = next.height;
	const full = opts.full || previous.width !== width || previous.height !== height;

	let output = '';
	let cursorRow = 0;
	let cursorColumn = 0;
	let style: Style = DEFAULT_STYLE;
	let styleIndex = StyleTable.DEFAULT;

	/** Moves the cursor to a cell, by the shortest route. */
	const moveTo = (row: number, column: number): void => {
		if (row !== cursorRow) {
			output += row > cursorRow ? cursorDown(row - cursorRow) : cursorUp(cursorRow - row);
			cursorRow = row;
		}
		if (column !== cursorColumn) {
			// a carriage return then a jump right is shorter than a long jump left,
			// and is understood by terminals that do not implement CHA
			if (column < cursorColumn) {
				output += '\r';
				cursorColumn = 0;
			}
			output += cursorRight(column - cursorColumn);
			cursorColumn = column;
		}
	};

	/** Applies a style, emitting only the difference from what is in effect. */
	const useStyle = (index: number): void => {
		if (index === styleIndex) {
			return;
		}
		const wanted = styles.get(index);
		output += transition(style, wanted);
		style = wanted;
		styleIndex = index;
	};

	for (let y = 0; y < height; y++) {
		let x = 0;

		while (x < width) {
			if (!full && !changed(previous, next, y * width + x)) {
				x++;
				continue;
			}

			// a run begins at the start of whatever cluster this cell belongs to
			let runStart = clusterStart(next, x, y);
			if (runStart < x) {
				// the lead may itself be unchanged; it still has to be rewritten,
				// because the half of it that did change cannot be drawn alone
				x = runStart;
			}

			// extend through changed cells, hopping gaps too short to be worth a
			// cursor move
			let runEnd = x;
			let scan = x;
			let gap = 0;
			while (scan < width) {
				if (full || changed(previous, next, y * width + scan)) {
					runEnd = scan;
					gap = 0;
				} else if (++gap > GAP) {
					break;
				}
				scan++;
			}

			// never stop in the middle of a wide cluster
			if (next.charAt(runEnd, y) !== CONTINUATION && cellWidth(next.charAt(runEnd, y)) === 2) {
				runEnd++;
			}

			moveTo(y, runStart);

			for (let column = runStart; column <= runEnd && column < width;) {
				const cell = next.charAt(column, y);
				if (cell === CONTINUATION) {
					// drawn by its lead in the previous iteration
					column++;
					continue;
				}

				useStyle(next.styleAt(column, y));
				output += cell;

				const consumed = Math.max(1, cellWidth(cell));
				cursorColumn += consumed;
				column += consumed;
			}

			x = runEnd + 1;
		}
	}

	if (output && styleIndex !== StyleTable.DEFAULT) {
		// never hand the terminal back with a style still open: the next thing
		// written is the app's own output, and it did not ask to be coloured
		output += RESET;
		style = DEFAULT_STYLE;
		styleIndex = StyleTable.DEFAULT;
	}

	const wrapPending = cursorColumn >= width && width > 0;
	return {
		column: wrapPending ? width - 1 : cursorColumn,
		output,
		row: cursorRow,
		wrapPending,
	};
}
