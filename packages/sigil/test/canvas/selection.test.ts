import {
	ATTR,
	type Cell,
	CellBuffer,
	createSelection,
	inSelection,
	paintSelection,
	Painter,
	palette,
	type Selectable,
	selectedStyle,
	type Selection,
	selectionRuns,
	selectionText,
	StyleTable,
} from '../../src/canvas/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A selection over cells: which cells it covers, what text they come to, and
 * what the highlight does to them.
 *
 * Nothing here knows about elements. The `selectable` predicate is what the
 * element tree would hand over, and a literal stands in for it -- which is the
 * whole point of taking it as an argument.
 */

/** A grid with one line per row written at column zero. */
function grid(lines: string[], width = Math.max(...lines.map((l) => l.length))): CellBuffer {
	const buffer = new CellBuffer(width, lines.length);
	for (const [y, line] of lines.entries()) {
		buffer.write(0, y, line, StyleTable.DEFAULT);
	}
	return buffer;
}

/** The attributes each cell of a row ended up with. */
function attrsOf(buffer: CellBuffer, styles: StyleTable, y: number): number[] {
	const out: number[] = [];
	for (let x = 0; x < buffer.width; x++) {
		out.push(styles.get(buffer.styleAt(x, y)).attrs);
	}
	return out;
}

/** Highlights a selection over a grid, the way the renderer's paint pass does. */
function highlight(
	buffer: CellBuffer,
	sel: Selection,
	selectable?: Selectable
): { styles: StyleTable } {
	const styles = new StyleTable();
	// re-paint through a painter so the grid's styles are this table's
	const painter = new Painter(buffer, styles);
	paintSelection(painter, sel, { height: buffer.height, selectable, width: buffer.width });
	return { styles };
}

describe('selectionRuns', () => {
	it('should cover one cell for an anchor and focus on the same cell', () => {
		const sel = createSelection({ x: 3, y: 1 });
		expect(selectionRuns(sel, 10, 4)).toEqual([{ length: 1, x: 3, y: 1 }]);
	});

	it('should read the two cells in reading order whichever way round they were made', () => {
		const forwards = selectionRuns(createSelection({ x: 2, y: 0 }, { x: 5, y: 0 }), 10, 4);
		const backwards = selectionRuns(createSelection({ x: 5, y: 0 }, { x: 2, y: 0 }), 10, 4);
		expect(backwards).toEqual(forwards);
		expect(forwards).toEqual([{ length: 4, x: 2, y: 0 }]);
	});

	it('should run a linear selection to the edge and back from it', () => {
		const sel = createSelection({ x: 7, y: 0 }, { x: 2, y: 2 });
		expect(selectionRuns(sel, 10, 4)).toEqual([
			{ length: 3, x: 7, y: 0 },
			{ length: 10, x: 0, y: 1 },
			{ length: 3, x: 0, y: 2 },
		]);
	});

	it('should keep a block selection inside its own columns', () => {
		const sel = createSelection({ x: 6, y: 0 }, { x: 2, y: 2 }, 'block');
		expect(selectionRuns(sel, 10, 4)).toEqual([
			{ length: 5, x: 2, y: 0 },
			{ length: 5, x: 2, y: 1 },
			{ length: 5, x: 2, y: 2 },
		]);
	});

	it('should clamp a focus the capture let wander off the canvas', () => {
		// a press captures the pointer, so a drag's focus really can be outside --
		// and what the user means by it is the edge
		const sel = createSelection({ x: 2, y: 1 }, { x: 40, y: 99 });
		expect(selectionRuns(sel, 10, 4)).toEqual([
			{ length: 8, x: 2, y: 1 },
			{ length: 10, x: 0, y: 2 },
			{ length: 10, x: 0, y: 3 },
		]);
	});

	it('should cover nothing on a grid with no cells', () => {
		expect(selectionRuns(createSelection({ x: 0, y: 0 }), 0, 0)).toEqual([]);
	});
});

describe('inSelection', () => {
	const grid = { height: 4, width: 10 };

	/** Every cell of the grid, asked of both readers. */
	function agrees(anchor: Cell, focus: Cell): void {
		for (const mode of ['linear', 'block'] as const) {
			const sel = createSelection(anchor, focus, mode);
			const covered = new Set<string>();
			for (const run of selectionRuns(sel, grid.width, grid.height)) {
				for (let x = run.x; x < run.x + run.length; x++) {
					covered.add(`${x},${run.y}`);
				}
			}

			const where = `${mode} (${anchor.x},${anchor.y})-(${focus.x},${focus.y})`;
			for (let y = 0; y < grid.height; y++) {
				for (let x = 0; x < grid.width; x++) {
					expect(inSelection(sel, { x, y }, grid), `${where} at ${x},${y}`).toBe(
						covered.has(`${x},${y}`)
					);
				}
			}
		}
	}

	it('should agree with the runs it is the per-cell form of', () => {
		agrees({ x: 7, y: 0 }, { x: 2, y: 2 });
	});

	it('should agree with the runs about an endpoint off the grid, which a captured drag reaches', () => {
		// a focus above the grid: the clamp makes row 0 the selection's *first*
		// row, so it starts at a column rather than filling edge to edge
		agrees({ x: 5, y: 2 }, { x: 3, y: -5 });
		// and below it, which is the same thing about the last row
		agrees({ x: 2, y: 1 }, { x: 7, y: 99 });
		// one row, with both ends past the right edge -- the clamp lands them
		// both on the last column, which is a cell rather than none
		agrees({ x: 20, y: 0 }, { x: 30, y: 0 });
		// and past the left edge
		agrees({ x: -9, y: 1 }, { x: -3, y: 1 });
		// both ends off, opposite corners
		agrees({ x: -4, y: -4 }, { x: 40, y: 40 });
	});

	it('should read a cell the way a selection reads its own', () => {
		const sel = createSelection({ x: 2, y: 0 }, { x: 4, y: 0 });
		expect(inSelection(sel, { x: 3.9, y: 0.9 }, grid)).toBe(true);
		expect(inSelection(sel, { x: 1.9, y: 0 }, grid)).toBe(false);
		expect(inSelection(sel, { x: Number.NaN, y: 0 }, grid)).toBe(false);
	});
});

describe('selectionText', () => {
	it('should read the cells between the two ends', () => {
		const buffer = grid(['hello world', 'second line'], 11);
		const sel = createSelection({ x: 6, y: 0 }, { x: 5, y: 1 });
		expect(selectionText(buffer, sel)).toBe('world\nsecond');
	});

	it('should drop trailing blanks per line', () => {
		// a region padded out to the pane's width is one nobody can paste anywhere
		// useful, which is the reason `renderToString()` already gives
		const buffer = grid(['ab', 'a longer line'], 13);
		const sel = createSelection({ x: 0, y: 0 }, { x: 12, y: 1 });
		expect(selectionText(buffer, sel)).toBe('ab\na longer line');
	});

	it('should keep a blank line a selection crossed', () => {
		const buffer = grid(['one', '', 'two'], 3);
		const sel = createSelection({ x: 0, y: 0 }, { x: 2, y: 2 });
		expect(selectionText(buffer, sel)).toBe('one\n\ntwo');
	});

	it('should copy a wide cluster whole from either half', () => {
		const buffer = grid(['a漢b'], 4);
		// the continuation is column 2, so this run starts on it
		expect(buffer.charAt(2, 0)).toBe('');
		expect(selectionText(buffer, createSelection({ x: 2, y: 0 }, { x: 3, y: 0 }))).toBe('漢b');
		expect(selectionText(buffer, createSelection({ x: 1, y: 0 }, { x: 1, y: 0 }))).toBe('漢');
	});

	it('should blank a cell nothing may copy rather than dropping it', () => {
		// dropping would pull the text on either side together and misalign every
		// line that crossed one; a blank keeps the shape
		const buffer = grid(['ab##cd'], 6);
		const selectable: Selectable = (x) => x < 2 || x > 3;
		const sel = createSelection({ x: 0, y: 0 }, { x: 5, y: 0 });
		expect(selectionText(buffer, sel, { selectable })).toBe('ab  cd');
	});

	it('should blank both columns of a wide cluster nothing may copy', () => {
		const buffer = grid(['a漢b'], 4);
		const sel = createSelection({ x: 0, y: 0 }, { x: 3, y: 0 });
		expect(selectionText(buffer, sel, { selectable: (x) => x !== 1 })).toBe('a  b');
	});

	it('should copy one pane of a two-pane row in block mode', () => {
		// which is what block mode is the answer to, and the reason a selection is
		// not scoped to a clipping box
		const buffer = grid(['left  right', 'one   two  '], 11);
		const sel = createSelection({ x: 0, y: 0 }, { x: 4, y: 1 }, 'block');
		expect(selectionText(buffer, sel)).toBe('left\none');
	});
});

describe('selectedStyle', () => {
	it('should toggle inverse rather than setting it', () => {
		// setting it would make a selection over an inverse run invisible, which is
		// the one case the highlight exists for
		expect(selectedStyle({ attrs: ATTR.bold, bg: -1, fg: -1, link: '' }).attrs).toBe(
			ATTR.bold | ATTR.inverse
		);
		expect(selectedStyle({ attrs: ATTR.inverse, bg: -1, fg: -1, link: '' }).attrs).toBe(ATTR.none);
	});

	it('should leave the colours and the link alone', () => {
		const style = { attrs: ATTR.none, bg: palette(4), fg: palette(2), link: 'https://x' };
		expect(selectedStyle(style)).toEqual({ ...style, attrs: ATTR.inverse });
	});
});

describe('paintSelection', () => {
	it('should invert the cells it covers and nothing else', () => {
		const buffer = grid(['abcdef'], 6);
		const { styles } = highlight(buffer, createSelection({ x: 1, y: 0 }, { x: 3, y: 0 }));
		expect(attrsOf(buffer, styles, 0)).toEqual([
			ATTR.none,
			ATTR.inverse,
			ATTR.inverse,
			ATTR.inverse,
			ATTR.none,
			ATTR.none,
		]);
	});

	it('should not invert a wide cluster twice', () => {
		// both halves of a cluster share one style index and `restyle()` writes
		// both, so visiting the continuation after its lead applied the transform
		// twice -- and inverting twice is not inverting
		const buffer = grid(['a漢b'], 4);
		const { styles } = highlight(buffer, createSelection({ x: 0, y: 0 }, { x: 3, y: 0 }));
		expect(attrsOf(buffer, styles, 0)).toEqual([
			ATTR.inverse,
			ATTR.inverse,
			ATTR.inverse,
			ATTR.inverse,
		]);
	});

	it('should highlight a wide cluster from the half the selection touched', () => {
		// the run starts on the continuation and the lead is outside it; a cluster
		// is highlighted as a whole or the terminal is never told at all, since the
		// diff draws the lead and skips the continuation
		const buffer = grid(['a漢b'], 4);
		const { styles } = highlight(buffer, createSelection({ x: 2, y: 0 }, { x: 3, y: 0 }));
		expect(attrsOf(buffer, styles, 0)).toEqual([
			ATTR.none,
			ATTR.inverse,
			ATTR.inverse,
			ATTR.inverse,
		]);
	});

	it('should leave a cell nothing may copy unhighlighted', () => {
		// a highlight over something that will not copy is a lie about what a copy
		// would give you
		const buffer = grid(['ab##cd'], 6);
		const { styles } = highlight(
			buffer,
			createSelection({ x: 0, y: 0 }, { x: 5, y: 0 }),
			(x) => x < 2 || x > 3
		);
		expect(attrsOf(buffer, styles, 0)).toEqual([
			ATTR.inverse,
			ATTR.inverse,
			ATTR.none,
			ATTR.none,
			ATTR.inverse,
			ATTR.inverse,
		]);
	});

	it('should ask selectable where the copy asks it, for a run starting on a continuation', () => {
		// the two readers of one cluster: the copy grows the run left onto its lead
		// and asks there, while the highlight used to ask at the continuation the
		// run began on -- so a mask whose two halves disagree had the cluster
		// copied and not highlighted, or the reverse. Asserted as the agreement
		// rather than as either answer, because which cell is asked is the claim
		for (const lead of [true, false]) {
			const selectable: Selectable = (x) => (x === 1 ? lead : !lead);
			const sel = createSelection({ x: 2, y: 0 }, { x: 3, y: 0 });

			const buffer = grid(['a漢b'], 4);
			expect(buffer.charAt(2, 0)).toBe('');
			const copied = selectionText(buffer, sel, { selectable });
			const { styles } = highlight(buffer, sel, selectable);
			const drawn = attrsOf(buffer, styles, 0)[1] === ATTR.inverse;

			expect(drawn, `lead selectable: ${lead}`).toBe(copied.includes('漢'));
		}
	});

	it('should not change what any cell holds', () => {
		const buffer = grid(['hello', 'world'], 5);
		const before = buffer.toLines();
		highlight(buffer, createSelection({ x: 0, y: 0 }, { x: 4, y: 1 }));
		expect(buffer.toLines()).toEqual(before);
	});
});

describe('Painter.overlay', () => {
	it('should leave a cell alone where the transform declines', () => {
		const buffer = grid(['abc'], 3);
		const styles = new StyleTable();
		const painter = new Painter(buffer, styles);
		painter.overlay(0, 0, 3, (style, x) => (x === 1 ? { ...style, attrs: ATTR.bold } : undefined));
		expect(attrsOf(buffer, styles, 0)).toEqual([ATTR.none, ATTR.bold, ATTR.none]);
	});

	it('should ask about the lead where the run begins on a continuation', () => {
		const buffer = grid(['a漢b'], 4);
		const styles = new StyleTable();
		const painter = new Painter(buffer, styles);
		const asked: number[] = [];
		painter.overlay(2, 0, 2, (style, x) => {
			asked.push(x);
			return { ...style, attrs: ATTR.bold };
		});
		// 1 is the cluster's lead and sits outside the run; 3 is the `b` after it
		expect(asked).toEqual([1, 3]);
	});

	it('should ignore a run that reaches off the grid', () => {
		const buffer = grid(['abc'], 3);
		const styles = new StyleTable();
		const painter = new Painter(buffer, styles);
		painter.overlay(-2, 0, 10, (style) => ({ ...style, attrs: ATTR.bold }));
		expect(attrsOf(buffer, styles, 0)).toEqual([ATTR.bold, ATTR.bold, ATTR.bold]);
		expect(buffer.toLines()).toEqual(['abc']);
	});
});

describe('CellBuffer.restyle', () => {
	it('should carry a style to the other half of a wide cluster', () => {
		const buffer = new CellBuffer(4, 1);
		const styles = new StyleTable();
		buffer.write(0, 0, '漢', StyleTable.DEFAULT);
		const bold = styles.intern({ attrs: ATTR.bold });
		buffer.restyle(1, 0, bold);
		expect(buffer.styleAt(0, 0)).toBe(bold);
		expect(buffer.styleAt(1, 0)).toBe(bold);
	});

	it('should do nothing off the grid', () => {
		const buffer = new CellBuffer(2, 1);
		expect(() => buffer.restyle(9, 9, 1)).not.toThrow();
	});
});
