import {
	CellBuffer,
	cellWidth,
	composite,
	compositeAll,
	createCanvas,
	dissolveMask,
	type Layer,
	MASK_MAX,
	masked,
	maskThreshold,
	openMask,
	Painter,
	palette,
	rgb,
	seeded,
	StyleTable,
	wipeMask,
} from '../../src/canvas/index.js';
import { ESC, replay } from './fake-terminal.js';
import { describe, expect, it } from 'vitest';

/** One wide cluster, as an escape so no source file carries a surprise. */
const WIDE = '漢';

/** A grid with something on it, painted through a given table. */
function grid(
	width: number,
	height: number,
	styles: StyleTable,
	draw: (painter: Painter) => void
): CellBuffer {
	const cells = new CellBuffer(width, height);
	draw(new Painter(cells, styles));
	return cells;
}

/** A layer at an origin. */
function layerAt(cells: CellBuffer, x = 0, y = 0, mask?: Layer['mask']): Layer {
	return { cells, mask, x, y };
}

/**
 * Composites onto a base and replays the result against the model terminal.
 *
 * Through `replay()` rather than by reading the grid, because the claim a
 * composite makes is the diff's own said one layer up: these bytes turn what is
 * on screen into what should be, and a composite reaches the screen through the
 * diff and through nothing else. It also gets `checkClusters()` and the cursor
 * assertion for nothing, which is the invariant the whole wide-cluster argument
 * is about -- no frame may *end* with half a glyph on screen.
 */
function compositeAndReplay(base: CellBuffer, styles: StyleTable, layers: Layer[]) {
	const previous = new CellBuffer(base.width, base.height);
	compositeAll(base, layers);
	return replay(previous, base, styles);
}

describe('a layer composite', () => {
	it('should occlude with a panel of blanks, which is the case there is no char for', () => {
		// the case anybody writes first, and the reason occupancy exists at all:
		// `clear()` fills with a blank in the default style, so a space painted in
		// the terminal's own colours is indistinguishable from a cell nothing
		// painted -- and a panel filled with a background colour is *opaque* while
		// being made entirely of blanks
		const styles = new StyleTable();
		const base = grid(10, 1, styles, (p) => p.text(0, 0, 'abcdefghij'));
		const panel = grid(10, 1, styles, (p) => p.fill(2, 0, 4, 1, { bg: palette(4) }));

		const { lines, styles: shown } = compositeAndReplay(base, styles, [layerAt(panel)]);
		expect(lines).toEqual(['ab    ghij']);
		// and it is the panel's style the blanks are wearing, not the default: the
		// occlusion is a fill somebody asked for rather than a hole
		expect(styles.get(shown[0][3]).bg).toBe(palette(4));
		expect(styles.get(shown[0][0]).bg).not.toBe(palette(4));
	});

	it('should carry each cell its own style, not a neighbour\u2019s', () => {
		// a composite that read the style one index along leaves every character
		// where it belongs and draws it in the wrong colour, which the lines cannot
		// see and the replay cannot either -- `replay()` compares the model against
		// the grid, and both sides read the style the composite wrote. So this is
		// asserted against an **expected** value, three different styles side by
		// side. A review round pointed at the gap by noting the replay compares
		// `toLines()` alone; the style comparison written for it was deleted again
		// for the reason above, and this is what replaced it
		const styles = new StyleTable();
		const base = grid(3, 1, styles, (p) => p.text(0, 0, '...'));
		const over = grid(3, 1, styles, (p) => {
			p.text(0, 0, 'A', { fg: palette(1) });
			p.text(1, 0, 'B', { fg: palette(2) });
			p.text(2, 0, 'C', { fg: palette(3) });
		});

		compositeAll(base, [layerAt(over)]);
		expect([0, 1, 2].map((x) => styles.get(base.styleAt(x, 0)).fg)).toEqual([
			palette(1),
			palette(2),
			palette(3),
		]);
	});

	it('should let a cell nothing painted through', () => {
		const styles = new StyleTable();
		const base = grid(6, 1, styles, (p) => p.text(0, 0, 'abcdef'));
		// written at column 2 only, so columns 0-1 and 3-5 were never painted
		const over = grid(6, 1, styles, (p) => p.text(2, 0, 'X'));

		const { lines } = compositeAndReplay(base, styles, [layerAt(over)]);
		expect(lines).toEqual(['abXdef']);
	});

	it('should let every cell through after a clear, which is what makes occupancy mean anything', () => {
		const styles = new StyleTable();
		const base = grid(5, 1, styles, (p) => p.text(0, 0, 'abcde'));
		const over = grid(5, 1, styles, (p) => p.text(0, 0, 'XXXXX'));
		over.clear();

		const { lines } = compositeAndReplay(base, styles, [layerAt(over)]);
		expect(lines).toEqual(['abcde']);
	});

	it('should answer occupancy for a blank it painted and not for one it did not', () => {
		const styles = new StyleTable();
		const cells = grid(4, 1, styles, (p) => p.fill(1, 0, 2, 1, { bg: palette(2) }));
		expect([0, 1, 2, 3].map((x) => cells.occupiedAt(x, 0))).toEqual([false, true, true, false]);
		// and off the grid holds nothing by definition
		expect(cells.occupiedAt(-1, 0)).toBe(false);
		expect(cells.occupiedAt(4, 0)).toBe(false);
		expect(cells.occupiedAt(0, 1)).toBe(false);
	});

	it('should occupy both halves of a wide cluster', () => {
		// `occupiedAt()` answers "has anything been painted into this cell", and a
		// cluster paints two of them. The composite never asks about the
		// continuation -- a cluster is written once, by its lead -- so this is the
		// public answer rather than something the composite depends on, and it is
		// the invariant `#breakCluster()` rests on: the only thing that writes a
		// continuation is `put()`, so a repair can never meet an unoccupied cell
		const styles = new StyleTable();
		const cells = grid(4, 1, styles, (p) => p.text(1, 0, WIDE));
		expect([0, 1, 2, 3].map((x) => cells.occupiedAt(x, 0))).toEqual([false, true, true, false]);
	});

	it('should keep the orphaned half of a broken cluster occupied', () => {
		// the repair leaves a blank *this grid painted*, so the cell stays the
		// grid's: a layer that drew a wide cluster and then overwrote half of it is
		// still holding both columns, and letting the orphan go transparent would
		// show whatever is underneath beside the surviving character
		const styles = new StyleTable();
		const over = grid(4, 1, styles, (p) => {
			p.text(1, 0, WIDE);
			p.text(2, 0, 'X');
		});
		expect(over.charAt(1, 0)).toBe(' ');
		expect(over.occupiedAt(1, 0)).toBe(true);

		const base = grid(4, 1, styles, (p) => p.text(0, 0, 'abcd'));
		const { lines } = compositeAndReplay(base, styles, [layerAt(over)]);
		expect(lines).toEqual(['a Xd']);
	});

	it('should carry occupancy through a copy that resizes', () => {
		// `copyFrom()` across sizes rebuilds its arrays, and one it forgot would be
		// the wrong length: a shorter source leaves a stale tail and a longer one
		// throws out of `Uint8Array.set()`. No frame reaches it -- `present()` and
		// `snapshot()` are both same-size -- so it is a claim about the method
		// rather than about a path
		const styles = new StyleTable();
		const wide = grid(6, 2, styles, (p) => p.text(1, 1, 'XX'));
		const small = new CellBuffer(2, 1);
		small.copyFrom(wide);

		expect([small.width, small.height]).toEqual([6, 2]);
		expect(small.occupiedAt(1, 1)).toBe(true);
		expect(small.occupiedAt(0, 0)).toBe(false);

		const big = new CellBuffer(9, 4);
		big.copyFrom(wide);
		expect([big.width, big.height]).toEqual([6, 2]);
		expect(big.occupiedAt(2, 1)).toBe(true);
	});

	it('should answer occupancy against the size a resize left', () => {
		// the array goes with the grid, or the indices address a rectangle that is
		// no longer there -- out of bounds on a typed array is a silent `undefined`
		// on the way out and a dropped write on the way in, so every cell would
		// read as holding nothing
		const styles = new StyleTable();
		const cells = grid(2, 1, styles, (p) => p.text(0, 0, 'ab'));
		cells.resize(6, 2);
		expect(cells.occupiedAt(0, 0)).toBe(false);

		new Painter(cells, styles).text(4, 1, 'Z');
		expect(cells.occupiedAt(4, 1)).toBe(true);
		expect(cells.occupiedAt(3, 1)).toBe(false);
	});

	it('should repair a cluster whose other half a clip excludes', () => {
		// the clip governs what may be *painted*; repairing a cluster is the grid
		// un-painting a cell it wrote itself. Asked through the clip, overwriting
		// half of a wide cluster whose other half sat one column outside it blanked
		// nothing -- and the diff then drew the surviving lead over both columns,
		// so the cell inside the clip had changed and the glyph on screen had not.
		// Reachable through the element tree's own `overflow: hidden` rather than
		// only through a stray `clipTo()`, and found by review
		const styles = new StyleTable();

		// the continuation inside the clip, the lead outside it
		const right = grid(4, 1, styles, (p) => p.text(0, 0, WIDE));
		right.clipTo({ height: 1, width: 3, x: 1, y: 0 });
		right.put(1, 0, 'a', 0);
		right.clipTo(undefined);
		expect(right.toLines()).toEqual([' a  ']);

		// and the lead inside, the continuation outside
		const left = grid(4, 1, styles, (p) => p.text(0, 0, WIDE));
		left.clipTo({ height: 1, width: 1, x: 0, y: 0 });
		left.put(0, 0, 'a', 0);
		left.clipTo(undefined);
		expect(left.toLines()).toEqual(['a   ']);
	});

	it('should re-style a cluster whose other half a clip excludes', () => {
		// the same argument for the style: the diff draws the lead and skips the
		// continuation, so a style written to one half alone is one the terminal is
		// never told about -- and a selection run is `Painter.overlay()`, which asks
		// `inside()` before it gets here
		const styles = new StyleTable();
		const cells = grid(4, 1, styles, (p) => p.text(0, 0, WIDE));
		const marked = styles.intern({ bg: palette(5) });

		// the continuation inside the clip, the lead outside it
		cells.clipTo({ height: 1, width: 3, x: 1, y: 0 });
		cells.restyle(1, 0, marked);
		cells.clipTo(undefined);
		expect(cells.styleAt(0, 0)).toBe(marked);
		expect(cells.styleAt(1, 0)).toBe(marked);

		// and the other direction, which the first version of this test left out --
		// a sabotage of the tail lookup survived it, because a clip excluding the
		// *continuation* is a different branch from one excluding the lead
		const other = grid(4, 1, styles, (p) => p.text(0, 0, WIDE));
		const second = styles.intern({ bg: palette(6) });
		other.clipTo({ height: 1, width: 1, x: 0, y: 0 });
		other.restyle(0, 0, second);
		other.clipTo(undefined);
		expect(other.styleAt(0, 0)).toBe(second);
		expect(other.styleAt(1, 0)).toBe(second);
	});

	it('should refuse to composite a grid onto itself', () => {
		// the walk reads and writes the same arrays left to right, so a layer at
		// `x: 1` reads the cell it wrote one column ago and smears the row. A copy
		// per row would make the aliasing work, which is inventing a feature
		const styles = new StyleTable();
		const cells = grid(3, 1, styles, (p) => p.text(0, 0, 'ABC'));
		expect(() => compositeAll(cells, [layerAt(cells, 1)])).toThrow(/composite a grid onto itself/);
		expect(cells.toLines()).toEqual(['ABC']);
	});

	it('should leave occupancy alone when a cell is only re-styled', () => {
		// whether a cell holds anything is part of what it holds, so a re-style
		// cannot create content -- which is what keeps `restyle()`'s own promise
		// that nothing there can change what a cell holds
		const styles = new StyleTable();
		const cells = new CellBuffer(3, 1);
		cells.restyle(0, 0, styles.intern({ bg: palette(5) }));
		expect(cells.occupiedAt(0, 0)).toBe(false);

		const base = grid(3, 1, styles, (p) => p.text(0, 0, 'abc'));
		const { lines } = compositeAndReplay(base, styles, [layerAt(cells)]);
		expect(lines).toEqual(['abc']);
	});

	describe('over a wide cluster', () => {
		it('should take the other half of a cluster it lands on the lead of', () => {
			// the sharp edge of the whole feature. A raw `set()` on the typed arrays
			// leaves the continuation behind, and the terminal is told to draw half a
			// glyph with every column after it on the row shifted
			const styles = new StyleTable();
			const base = grid(6, 1, styles, (p) => p.text(0, 0, `ab${WIDE}ef`));
			const over = grid(6, 1, styles, (p) => p.text(2, 0, 'X'));

			const { lines } = compositeAndReplay(base, styles, [layerAt(over)]);
			expect(lines).toEqual(['abX ef']);
		});

		it('should take the other half of a cluster it lands on the continuation of', () => {
			const styles = new StyleTable();
			const base = grid(6, 1, styles, (p) => p.text(0, 0, `ab${WIDE}ef`));
			const over = grid(6, 1, styles, (p) => p.text(3, 0, 'X'));

			const { lines } = compositeAndReplay(base, styles, [layerAt(over)]);
			expect(lines).toEqual(['ab Xef']);
		});

		it('should take both halves of a cluster its own wide cluster lands across', () => {
			// a two-column layer cell landing on the right-hand column of one wide
			// cluster and the left-hand column of the next: three columns of base
			// content gone, two to the cluster and one to the repair
			const styles = new StyleTable();
			const base = grid(6, 1, styles, (p) => p.text(0, 0, `a${WIDE}${WIDE}f`));
			const over = grid(6, 1, styles, (p) => p.text(2, 0, WIDE));

			const { lines } = compositeAndReplay(base, styles, [layerAt(over)]);
			expect(lines).toEqual([`a ${WIDE} f`]);
		});

		it('should carry its own wide cluster whole', () => {
			const styles = new StyleTable();
			const base = grid(6, 1, styles, (p) => p.text(0, 0, 'abcdef'));
			const over = grid(6, 1, styles, (p) => p.text(2, 0, WIDE));

			const { lines } = compositeAndReplay(base, styles, [layerAt(over)]);
			expect(lines).toEqual([`ab${WIDE}ef`]);
		});

		it('should refuse its own wide cluster where there is no room for the continuation', () => {
			// `put()`'s rule, inherited rather than restated: half a wide glyph is
			// worse than none, so a blank takes the column
			const styles = new StyleTable();
			const base = grid(4, 1, styles, (p) => p.text(0, 0, 'abcd'));
			const over = grid(4, 1, styles, (p) => p.text(3, 0, WIDE));

			const { lines } = compositeAndReplay(base, styles, [layerAt(over)]);
			expect(lines).toEqual(['abc ']);
		});

		it('should refuse a wide cluster its origin pushed half off the left edge', () => {
			// the lead lands at -1, so nothing is painted and the continuation's
			// column keeps what was underneath. A survivor would be half a glyph,
			// which is the rule `write()` already keeps at column zero
			const styles = new StyleTable();
			const base = grid(5, 1, styles, (p) => p.text(0, 0, 'abcde'));
			const over = grid(5, 1, styles, (p) => p.text(0, 0, WIDE));

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, -1)]);
			expect(lines).toEqual(['abcde']);
		});

		it('should refuse a wide cluster its origin pushed half off the right edge', () => {
			const styles = new StyleTable();
			const base = grid(5, 1, styles, (p) => p.text(0, 0, 'abcde'));
			const over = grid(2, 1, styles, (p) => p.text(0, 0, WIDE));

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, 4)]);
			expect(lines).toEqual(['abcd ']);
		});
	});

	describe('clipped at an edge', () => {
		it('should clip at the right', () => {
			const styles = new StyleTable();
			const base = grid(6, 1, styles, (p) => p.text(0, 0, '......'));
			const over = grid(4, 1, styles, (p) => p.text(0, 0, 'WXYZ'));

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, 4)]);
			expect(lines).toEqual(['....WX']);
		});

		it('should clip at the left', () => {
			const styles = new StyleTable();
			const base = grid(6, 1, styles, (p) => p.text(0, 0, '......'));
			const over = grid(4, 1, styles, (p) => p.text(0, 0, 'WXYZ'));

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, -2)]);
			expect(lines).toEqual(['YZ....']);
		});

		it('should clip at the bottom', () => {
			const styles = new StyleTable();
			const base = grid(3, 3, styles, (p) => {
				for (let y = 0; y < 3; y++) {
					p.text(0, y, '...');
				}
			});
			const over = grid(3, 3, styles, (p) => {
				p.text(0, 0, 'AAA');
				p.text(0, 1, 'BBB');
				p.text(0, 2, 'CCC');
			});

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, 0, 2)]);
			expect(lines).toEqual(['...', '...', 'AAA']);
		});

		it('should clip at the top', () => {
			const styles = new StyleTable();
			const base = grid(3, 3, styles, (p) => {
				for (let y = 0; y < 3; y++) {
					p.text(0, y, '...');
				}
			});
			const over = grid(3, 3, styles, (p) => {
				p.text(0, 0, 'AAA');
				p.text(0, 1, 'BBB');
				p.text(0, 2, 'CCC');
			});

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, 0, -2)]);
			expect(lines).toEqual(['CCC', '...', '...']);
		});

		it('should clip at a corner, which is both edges at once', () => {
			// `put()` asks about the column and the row independently, so a corner is
			// not its own path -- asserted anyway, because "it is just both" is the
			// kind of claim that is true until an index is computed from one of them
			const styles = new StyleTable();
			const base = grid(3, 3, styles, (p) => {
				for (let y = 0; y < 3; y++) {
					p.text(0, y, '...');
				}
			});
			const over = grid(3, 3, styles, (p) => {
				p.text(0, 0, 'ABC');
				p.text(0, 1, 'DEF');
				p.text(0, 2, 'GHI');
			});

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, -2, -2)]);
			expect(lines).toEqual(['I..', '...', '...']);
		});

		it('should paint nothing from a layer entirely off the grid', () => {
			const styles = new StyleTable();
			const over = grid(3, 2, styles, (p) => {
				p.text(0, 0, 'XXX');
				p.text(0, 1, 'XXX');
			});

			for (const [x, y] of [
				[3, 0],
				[-3, 0],
				[0, 2],
				[0, -2],
			]) {
				const base = grid(3, 2, styles, (p) => {
					p.text(0, 0, 'abc');
					p.text(0, 1, 'def');
				});
				compositeAll(base, [layerAt(over, x, y)]);
				expect(base.toLines(), `${x},${y}`).toEqual(['abc', 'def']);
			}
		});

		it('should take a layer bigger than the canvas and keep the overlap', () => {
			const styles = new StyleTable();
			const base = grid(4, 1, styles, (p) => p.text(0, 0, '....'));
			const over = grid(10, 3, styles, (p) => {
				p.text(0, 0, 'ABCDEFGHIJ');
				p.text(0, 1, '----------');
			});

			const { lines } = compositeAndReplay(base, styles, [layerAt(over)]);
			expect(lines).toEqual(['ABCD']);
		});

		it('should paint nothing from an origin that is not a whole number', () => {
			// a fractional origin names no cell, which is the same answer as one past
			// the edge. It used to *crash*: `y * width + 0.5` is a fractional index,
			// `#chars[0.5]` is `undefined`, and `cellWidth(undefined)` throws out of
			// `graphemeWidth()` three frames inside `put()`. A `Layer` origin is the
			// first coordinate a caller fills in as a plain field rather than getting
			// from a loop, which is what made it reachable
			const styles = new StyleTable();
			const over = grid(4, 1, styles, (p) => p.text(0, 0, 'XXXX'));

			for (const [x, y] of [
				[0.5, 0],
				[0, 0.5],
				[Number.NaN, 0],
				[0, Number.NaN],
				[Number.POSITIVE_INFINITY, 0],
				[Number.NEGATIVE_INFINITY, 0],
			]) {
				const base = grid(4, 1, styles, (p) => p.text(0, 0, 'abcd'));
				compositeAll(base, [layerAt(over, x, y)]);
				expect(base.toLines(), `${x},${y}`).toEqual(['abcd']);
			}
		});
	});

	describe('a mask', () => {
		it('should composite only the cells it reveals', () => {
			const styles = new StyleTable();
			const base = grid(4, 1, styles, (p) => p.text(0, 0, '....'));
			const over = grid(4, 1, styles, (p) => p.text(0, 0, 'ABCD'));
			const mask = wipeMask(4, 1, 'right');
			mask.threshold = 64;

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, 0, 0, mask)]);
			expect(lines).toEqual(['AB..']);
		});

		it('should composite nothing at the bottom of the ramp and all of it at the top', () => {
			const styles = new StyleTable();
			const over = grid(4, 1, styles, (p) => p.text(0, 0, 'ABCD'));
			const mask = wipeMask(4, 1, 'right');

			mask.threshold = maskThreshold(0);
			const none = grid(4, 1, styles, (p) => p.text(0, 0, '....'));
			compositeAll(none, [layerAt(over, 0, 0, mask)]);
			expect(none.toLines()).toEqual(['....']);

			mask.threshold = maskThreshold(1);
			const all = grid(4, 1, styles, (p) => p.text(0, 0, '....'));
			compositeAll(all, [layerAt(over, 0, 0, mask)]);
			expect(all.toLines()).toEqual(['ABCD']);
		});

		it('should take a wide cluster whole or not at all, sampled at its lead', () => {
			// a cluster is atomic, because revealing one of its columns is revealing
			// half a character. The field is built so the threshold falls *between*
			// the cluster's two cells, which is the only arrangement that can tell a
			// per-cell reading from a per-cluster one
			const styles = new StyleTable();
			const over = grid(4, 1, styles, (p) => p.text(1, 0, WIDE));
			const mask = openMask(4, 1);

			// the lead in, the continuation out: the cluster shows whole
			mask.values.set([0, 10, 200, 0]);
			mask.threshold = 10;
			const shown = grid(4, 1, styles, (p) => p.text(0, 0, '....'));
			compositeAll(shown, [layerAt(over, 0, 0, mask)]);
			expect(shown.toLines()).toEqual([`.${WIDE}.`]);

			// and the other way round. The continuation is never written by itself,
			// so nothing shows at all
			mask.values.set([0, 200, 10, 0]);
			mask.threshold = 10;
			const hidden = grid(4, 1, styles, (p) => p.text(0, 0, '....'));
			compositeAll(hidden, [layerAt(over, 0, 0, mask)]);
			expect(hidden.toLines()).toEqual(['....']);
		});

		it('should read the mask in the layer\u2019s own coordinates, not the canvas\u2019s', () => {
			// so that moving a layer does not invalidate its mask
			const styles = new StyleTable();
			const base = grid(6, 1, styles, (p) => p.text(0, 0, '......'));
			const over = grid(3, 1, styles, (p) => p.text(0, 0, 'ABC'));
			const mask = openMask(3, 1);
			mask.values.set([0, 200, 0]);
			mask.threshold = 0;

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, 3, 0, mask)]);
			expect(lines).toEqual(['...A.C']);
		});

		it('should reveal nothing where the mask is smaller than the layer', () => {
			// a mask says nothing about a cell outside its own rectangle, and the
			// other reading would silently reveal the whole right-hand side
			const styles = new StyleTable();
			const base = grid(6, 1, styles, (p) => p.text(0, 0, '......'));
			const over = grid(6, 1, styles, (p) => p.text(0, 0, 'ABCDEF'));
			const mask = openMask(2, 1);

			const { lines } = compositeAndReplay(base, styles, [layerAt(over, 0, 0, mask)]);
			expect(lines).toEqual(['AB....']);
		});
	});

	describe('a stack', () => {
		it('should paint the last entry on top', () => {
			const styles = new StyleTable();
			const base = grid(4, 1, styles, (p) => p.text(0, 0, '....'));
			const lower = grid(4, 1, styles, (p) => p.text(0, 0, 'LLLL'));
			const upper = grid(4, 1, styles, (p) => p.text(1, 0, 'UU'));

			const { lines } = compositeAndReplay(base, styles, [layerAt(lower), layerAt(upper)]);
			expect(lines).toEqual(['LUUL']);
		});

		it('should let a hole in an upper layer show the lower one', () => {
			const styles = new StyleTable();
			const base = grid(4, 1, styles, (p) => p.text(0, 0, '....'));
			const lower = grid(4, 1, styles, (p) => p.text(0, 0, 'LLLL'));
			const upper = grid(4, 1, styles, (p) => {
				p.text(0, 0, 'U');
				p.text(3, 0, 'U');
			});

			const { lines } = compositeAndReplay(base, styles, [layerAt(lower), layerAt(upper)]);
			expect(lines).toEqual(['ULLU']);
		});

		it('should composite one layer the same way the stack does', () => {
			const styles = new StyleTable();
			const over = grid(3, 1, styles, (p) => p.text(0, 0, 'ABC'));
			const one = grid(3, 1, styles, (p) => p.text(0, 0, '...'));
			const stack = grid(3, 1, styles, (p) => p.text(0, 0, '...'));

			composite(one, layerAt(over));
			compositeAll(stack, [layerAt(over)]);
			expect(one.toLines()).toEqual(stack.toLines());
		});
	});

	describe('replayed over several frames', () => {
		it('should reconcile the terminal with every step of a dissolve', () => {
			// the composite reaches the screen through the diff and through nothing
			// else, so the claim is the diff's: these bytes turn what is on screen
			// into what should be. Each frame is replayed against the one the
			// terminal is actually showing, so a composite that left half a glyph
			// behind or moved the cursor wrong fails inside `replay()`
			const styles = new StyleTable();
			const front = new CellBuffer(8, 2);
			const back = new CellBuffer(8, 2);
			const painter = new Painter(back, styles);

			const drawOld = (): void => {
				back.clear();
				painter.text(0, 0, `OL${WIDE}LDOL`, { fg: palette(1) });
				painter.text(0, 1, 'DLODLODL', { fg: palette(1) });
			};
			const drawNew = (): void => {
				back.clear();
				painter.text(0, 0, 'newnewne', { fg: palette(2) });
				painter.text(0, 1, `we${WIDE}wenw`, { fg: palette(2) });
			};

			drawOld();
			replay(front, back, styles, true);
			front.copyFrom(back);

			const snapshot = new CellBuffer(8, 2);
			snapshot.copyFrom(front);
			const mask = wipeMask(8, 2, 'left');
			const over = layerAt(snapshot, 0, 0, mask);

			for (let step = 8; step >= 0; step--) {
				mask.threshold = maskThreshold(step / 8);
				drawNew();
				compositeAll(back, [over]);
				const shown = replay(front, back, styles);
				expect(shown.lines, `step ${step}`).toEqual(back.toLines());
				front.copyFrom(back);
			}

			expect(front.toLines()).toEqual(['newnewne', `we${WIDE}wenw`]);
		});
	});
});

describe('a composite, fuzzed', () => {
	/**
	 * Clusters a base or a layer can be made of.
	 *
	 * Two wide ones, two narrow, and a blank -- the blank matters because a blank
	 * somebody painted is the case occupancy exists for, and a wide cluster is
	 * where every off-by-one lives.
	 */
	const CLUSTERS = ['a', 'b', ' ', WIDE, '\uFF21'];

	/**
	 * What a fuzz run met, so that it cannot go vacuous without saying so.
	 *
	 * This is the whole reason the counters exist. The first version of this
	 * fuzzer built a fresh `seeded(seed)` per iteration, and xorshift32 cold-
	 * starts small -- the first draw is very nearly linear in the seed, 6.30e-5 at
	 * seed 1 and 1.51e-2 at seed 240 -- so `1 + floor(random() * 7)` was **1 for
	 * every one of the 240 seeds**. Every base was one column wide, which is too
	 * narrow to hold a wide cluster at all, so not one was ever written. It passed,
	 * it passed with the cluster repair deleted, and nothing said a word.
	 * One generator across the loop is what the layout fuzzer already does for the
	 * same reason -- only its first tree is cold -- and asserting the coverage is
	 * what stops the next change to the shape quietly emptying it again.
	 */
	interface Seen {
		/**
		 * Composites where a layer cell landed on a cell of a wide cluster in the
		 * base, which is the case the whole cluster repair exists for.
		 *
		 * The sharpest of the four, and the one the first set of counters was
		 * missing: `wide` and `overlapped` between them say a wide cluster was
		 * generated and that *something* overlapped, which is not the same as the
		 * overlap having met the cluster.
		 */
		ontoWide: number;
		/** Composites where the layer overlapped the base at all. */
		overlapped: number;
		/** Grids that held a surviving wide cluster when they were composited. */
		wide: number;
		/** Composites where a mask kept at least one occupied cell out. */
		withheld: number;
	}

	/** A grid with a random scatter on it, and some cells left untouched. */
	function scatter(
		width: number,
		height: number,
		styles: StyleTable,
		random: () => number
	): CellBuffer {
		const cells = new CellBuffer(width, height);
		const painter = new Painter(cells, styles);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				// a third of the cells are left alone, so the layer has holes and the
				// base has gaps for the composite to show through -- and a cell skipped
				// after a wide cluster is what lets one survive to be composited over
				if (random() < 0.34) {
					continue;
				}
				const cluster = CLUSTERS[Math.floor(random() * CLUSTERS.length)];
				painter.text(x, y, cluster, { bg: palette(Math.floor(random() * 8)) });
				// stepped past the continuation a wide cluster just left, so that the
				// cluster *survives* to be composited over. Written left to right
				// without this, the next column overwrites the continuation two thirds
				// of the time and takes the lead with it -- and the counters say what
				// that cost: **14** of 240 composites landed on a wide cluster, where
				// the repair is the sharpest thing the composite does. A base of whole
				// wide clusters is also the realistic one, since that is what a text
				// painted into a grid looks like
				if (cellWidth(cluster) === 2) {
					x++;
				}
			}
		}
		return cells;
	}

	/** How many surviving wide clusters a grid holds. */
	function wideCount(cells: CellBuffer): number {
		let count = 0;
		for (let y = 0; y < cells.height; y++) {
			for (let x = 0; x < cells.width; x++) {
				if (cellWidth(cells.charAt(x, y)) === 2) {
					count++;
				}
			}
		}
		return count;
	}

	/**
	 * Every wide cluster still has its continuation, and no continuation has lost
	 * its lead.
	 *
	 * The invariant the whole wide-cluster argument is about, asked of the grid
	 * rather than of the model terminal -- `replay()` asks the same question of
	 * the screen, and asking it here as well is what says the grid was right
	 * before the diff had a chance to paper over it.
	 */
	function checkClusters(cells: CellBuffer, where: string): void {
		for (let y = 0; y < cells.height; y++) {
			for (let x = 0; x < cells.width; x++) {
				const cell = cells.charAt(x, y);
				if (cell === '') {
					const lead = x > 0 ? cells.charAt(x - 1, y) : undefined;
					expect(
						lead !== undefined && cellWidth(lead) === 2,
						`orphaned continuation at ${x},${y} (${where})`
					).toBe(true);
					continue;
				}
				if (cellWidth(cell) === 2) {
					expect(
						x + 1 < cells.width && cells.charAt(x + 1, y) === '',
						`wide cluster at ${x},${y} lost its continuation (${where})`
					).toBe(true);
				}
			}
		}
	}

	it('should leave no half a glyph behind, over any layer at any origin', () => {
		// 240 random composites: a scattered base, a scattered layer of its own
		// size at an origin that may hang off any edge, and a field that may be
		// open, a wipe, a dissolve or arbitrary bytes. Each one is checked on the
		// grid *and* replayed against the model terminal, which asserts the
		// clusters and the cursor again from the other side
		const random = seeded(20_260_103);
		const seen: Seen = { ontoWide: 0, overlapped: 0, wide: 0, withheld: 0 };

		for (let round = 1; round <= 240; round++) {
			const styles = new StyleTable();
			const width = 1 + Math.floor(random() * 7);
			const height = 1 + Math.floor(random() * 3);
			const base = scatter(width, height, styles, random);
			const over = scatter(
				1 + Math.floor(random() * 7),
				1 + Math.floor(random() * 3),
				styles,
				random
			);

			// biased towards the grid rather than uniform over a wide range: the
			// counters below are what said the first spelling -- plus or minus two
			// past each edge -- missed the base entirely on more than three quarters
			// of its rounds, so most of the corpus was asserting that nothing
			// composites nothing. One column and one row past each edge is enough to
			// reach every clipping case and leaves the overlap the common one
			const x = Math.floor(random() * (width + 2)) - 1;
			const y = Math.floor(random() * (height + 2)) - 1;

			let mask: Layer['mask'];
			const kind = Math.floor(random() * 4);
			if (kind === 1) {
				mask = wipeMask(over.width, over.height, 'right');
			} else if (kind === 2) {
				mask = dissolveMask(over.width, over.height, random);
			} else if (kind === 3) {
				mask = openMask(over.width, over.height);
				for (let i = 0; i < mask.values.length; i++) {
					mask.values[i] = Math.floor(random() * (MASK_MAX + 1));
				}
			}
			if (mask) {
				mask.threshold = Math.floor(random() * (MASK_MAX + 3)) - 1;
			}

			seen.wide += wideCount(base) > 0 ? 1 : 0;
			seen.wide += wideCount(over) > 0 ? 1 : 0;

			let reached = 0;
			let kept = 0;
			let ontoWide = 0;
			for (let ly = 0; ly < over.height; ly++) {
				for (let lx = 0; lx < over.width; lx++) {
					if (!over.occupiedAt(lx, ly)) {
						continue;
					}
					if (base.inside(lx + x, ly + y)) {
						reached++;
						if (!mask || masked(mask, lx, ly)) {
							kept++;
							// what the cell underneath is, before anything writes to it:
							// either half of a wide cluster is a repair the composite is
							// about to have to make
							const under = base.charAt(lx + x, ly + y);
							if (under === '' || cellWidth(under) === 2) {
								ontoWide++;
							}
						}
					}
				}
			}
			seen.overlapped += kept > 0 ? 1 : 0;
			seen.withheld += reached > kept ? 1 : 0;
			seen.ontoWide += ontoWide > 0 ? 1 : 0;

			const where = `round ${round}`;
			checkClusters(base, `${where}, base`);
			compositeAll(base, [{ cells: over, mask, x, y }]);
			checkClusters(base, where);

			// and through the diff, which checks the clusters on the screen and the
			// three fields a backend positions itself by
			const previous = new CellBuffer(width, height);
			const shown = replay(previous, base, styles);
			expect(shown.lines, where).toEqual(base.toLines());
		}

		// the corpus is not vacuous, which is a claim about this test rather than
		// about the composite -- and is the one the first version of it failed.
		// Measured at 323 / 82 / 37 / 33, so the floors sit clear of what the run
		// produces and still catch each collapse this has actually had: the
		// one-column corpus the cold-started generator gave had **zero** wide
		// clusters in 240 rounds, the uniform origin missed the base on 187 of
		// them, and a base that overwrote its own wide clusters landed on one 14
		// times rather than 33. `wide` counts per grid and the other three per
		// composite, so its ceiling is 480 where theirs is 240
		expect(seen.wide, 'grids with a surviving wide cluster').toBeGreaterThan(250);
		expect(seen.overlapped, 'composites that painted something').toBeGreaterThan(60);
		expect(seen.withheld, 'composites a mask withheld a cell from').toBeGreaterThan(25);
		expect(seen.ontoWide, 'composites that landed on a wide cluster').toBeGreaterThan(20);
	});

	it('should composite twice to the same answer as once', () => {
		// idempotence, which is the property that says the repair does not keep
		// eating neighbours: the second pass meets a base already holding the
		// layer's content, so `#breakCluster()` has to make the same decisions
		const random = seeded(7919);
		let wide = 0;

		for (let round = 1; round <= 120; round++) {
			const styles = new StyleTable();
			const width = 1 + Math.floor(random() * 7);
			const height = 1 + Math.floor(random() * 3);
			const once = scatter(width, height, styles, random);
			const twice = new CellBuffer(width, height);
			twice.copyFrom(once);
			const over = scatter(width, height, styles, random);
			const layer: Layer = {
				cells: over,
				x: Math.floor(random() * 5) - 2,
				y: Math.floor(random() * 3) - 1,
			};
			wide += wideCount(once) + wideCount(over) > 0 ? 1 : 0;

			compositeAll(once, [layer]);
			compositeAll(twice, [layer]);
			compositeAll(twice, [layer]);
			expect(twice.toLines(), `round ${round}`).toEqual(once.toLines());
		}

		// measured at 75 of 120, for the reason the counters above exist
		expect(wide, 'rounds with a wide cluster in them').toBeGreaterThan(50);
	});

	it('should only ever reveal more as a threshold rises', () => {
		// what makes a ramp a ramp. Monotone cell by cell: a cell the layer showed
		// at one threshold cannot go back to the base at a higher one, or a dissolve
		// would flicker rather than resolve
		const random = seeded(31);

		for (let round = 1; round <= 60; round++) {
			const styles = new StyleTable();
			const base = scatter(6, 3, styles, random);
			const over = scatter(6, 3, styles, random);
			const mask = dissolveMask(6, 3, random);

			let last = -1;
			for (let step = 0; step <= 16; step++) {
				mask.threshold = maskThreshold(step / 16);
				const frame = new CellBuffer(6, 3);
				frame.copyFrom(base);
				compositeAll(frame, [{ cells: over, mask, x: 0, y: 0 }]);

				let shown = 0;
				for (let y = 0; y < 3; y++) {
					for (let x = 0; x < 6; x++) {
						if (masked(mask, x, y) && over.occupiedAt(x, y)) {
							shown++;
						}
					}
				}
				expect(shown, `round ${round} step ${step}`).toBeGreaterThanOrEqual(last);
				last = shown;
			}
			// and it finishes with every occupied cell of the layer shown, or the
			// ramp stopped short of its own end
			expect(last, `round ${round} at the top of the ramp`).toBe(
				[...Array.from({ length: 18 }).keys()].reduce(
					(n, i) => n + (over.occupiedAt(i % 6, Math.trunc(i / 6)) ? 1 : 0),
					0
				)
			);
		}
	});
});

describe('a canvas with layers', () => {
	it('should composite them over what the frame drew', () => {
		const canvas = createCanvas({ height: 1, width: 6 });
		const over = new CellBuffer(6, 1);
		canvas.painter(over).text(2, 0, 'XX');
		canvas.layers.push({ cells: over, x: 0, y: 0 });

		canvas.paint((p) => p.text(0, 0, 'abcdef'));
		expect(canvas.toString()).toBe('abXXef');
	});

	it('should report the composite rather than the base, from cells and from toString', () => {
		// `cells` is what a selection reads and `toString()` is what a snapshot
		// reads, so both have to describe the frame that will be presented
		const canvas = createCanvas({ height: 1, width: 4 });
		const over = new CellBuffer(4, 1);
		canvas.painter(over).text(0, 0, 'ZZZZ');
		canvas.layers.push({ cells: over, x: 0, y: 0 });

		canvas.paint((p) => p.text(0, 0, 'abcd'));
		expect(canvas.toString()).toBe('ZZZZ');
		expect(canvas.cells.charAt(0, 0)).toBe('Z');
	});

	it('should composite after the callback, so the draw cannot paint over a layer', () => {
		// the one thing the ordering decides, and the only shape that can see it:
		// the draw and the layer both claim the same cell. Composited first, the
		// draw wins and a layer is a thing the frame paints over; composited last,
		// the layer wins, which is what "in front of what was drawn" means
		const canvas = createCanvas({ height: 1, width: 4 });
		const over = new CellBuffer(4, 1);
		canvas.painter(over).text(0, 0, 'LL');
		canvas.layers.push({ cells: over, x: 0, y: 0 });

		canvas.paint((p) => p.text(0, 0, 'abcd'));
		expect(canvas.toString()).toBe('LLcd');
	});

	it('should composite nothing when the stack is empty', () => {
		const canvas = createCanvas({ height: 1, width: 4 });
		canvas.paint((p) => p.text(0, 0, 'abcd'));
		expect(canvas.toString()).toBe('abcd');
		expect(canvas.layers).toEqual([]);
	});

	it('should hand a painter over any grid that interns into its own table', () => {
		// a grid painted through a table of its own holds indices that mean
		// something else here, which is a wrong colour on screen rather than an
		// error. `{ fg: palette(5) }` is index 1 in a fresh table and something else
		// in one that has interned anything
		const canvas = createCanvas({ height: 1, width: 3 });
		canvas.paint((p) => {
			p.text(0, 0, 'a', { fg: palette(1) });
			p.text(1, 0, 'b', { fg: palette(2) });
			p.text(2, 0, 'c', { fg: palette(3) });
		});
		canvas.present();

		const over = new CellBuffer(3, 1);
		canvas.painter(over).text(0, 0, 'X', { fg: palette(5) });
		canvas.layers.push({ cells: over, x: 0, y: 0 });
		canvas.paint((p) => p.text(0, 0, 'abc'));

		const output = canvas.present({ full: true }).output;
		expect(output).toContain(`${ESC}[35m`);
	});

	it('should recomposite every frame rather than once', () => {
		// a threshold moved between frames has to reach the screen, which is what
		// makes the composite a pass inside `paint()` rather than a thing that
		// happened when the layer was pushed
		const canvas = createCanvas({ height: 1, width: 4 });
		const over = new CellBuffer(4, 1);
		canvas.painter(over).text(0, 0, 'ABCD');
		const mask = wipeMask(4, 1, 'right');
		canvas.layers.push({ cells: over, mask, x: 0, y: 0 });

		const seen: string[] = [];
		for (const threshold of [-1, 0, 64, 128, 192, MASK_MAX]) {
			mask.threshold = threshold;
			canvas.paint((p) => p.text(0, 0, '....'));
			seen.push(canvas.toString());
		}
		expect(seen).toEqual(['....', 'A...', 'AB..', 'ABC.', 'ABCD', 'ABCD']);
	});

	it('should show a layer pushed after the paint on the next frame, not this one', () => {
		// the composite is a pass inside `paint()`, so pushing after one is pushing
		// for the frame after it -- which is also the window the `layers` doc is
		// about, since the sweep runs in `present()` and does see it
		const canvas = createCanvas({ height: 1, width: 4 });
		canvas.paint((p) => p.text(0, 0, 'abcd'));

		const over = new CellBuffer(4, 1);
		canvas.painter(over).text(0, 0, 'ZZ');
		canvas.layers.push({ cells: over, x: 0, y: 0 });

		expect(canvas.toString()).toBe('abcd');
		canvas.present();
		expect(canvas.toString()).toBe('abcd');

		canvas.paint((p) => p.text(0, 0, 'abcd'));
		expect(canvas.toString()).toBe('ZZcd');
	});

	it('should write nothing for a second present of the same frame', () => {
		const canvas = createCanvas({ height: 1, width: 4 });
		const over = new CellBuffer(4, 1);
		canvas.painter(over).text(0, 0, 'ZZ');
		canvas.layers.push({ cells: over, x: 0, y: 0 });

		canvas.paint((p) => p.text(0, 0, 'abcd'));
		expect(canvas.present().output).not.toBe('');
		expect(canvas.present().output).toBe('');
	});

	it('should drop the layers on a resize', () => {
		// a transition spanning a resize is undefined because both grids are
		// discarded, and a layer that survived one would be a rectangle sized for a
		// screen that no longer exists -- with style indices pointing into the table
		// the resize empties
		const canvas = createCanvas({ height: 1, width: 4 });
		const over = new CellBuffer(4, 1);
		canvas.painter(over).text(0, 0, 'ZZZZ');
		canvas.layers.push({ cells: over, x: 0, y: 0 });

		canvas.resize(6, 1);
		expect(canvas.layers).toEqual([]);
		canvas.paint((p) => p.text(0, 0, 'abcdef'));
		expect(canvas.toString()).toBe('abcdef');
	});

	it('should clear only the base, leaving the stack for the next frame', () => {
		// `clear()` drops what was painted; it is not a frame, so it composites
		// nothing and takes nothing away
		const canvas = createCanvas({ height: 1, width: 4 });
		const over = new CellBuffer(4, 1);
		canvas.painter(over).text(0, 0, 'ZZ');
		canvas.layers.push({ cells: over, x: 0, y: 0 });

		canvas.paint((p) => p.text(0, 0, 'abcd'));
		canvas.clear();
		expect(canvas.toString()).toBe('');
		expect(canvas.layers).toHaveLength(1);
		canvas.paint((p) => p.text(0, 0, 'abcd'));
		expect(canvas.toString()).toBe('ZZcd');
	});

	describe('a snapshot', () => {
		it('should hold what was presented', () => {
			const canvas = createCanvas({ height: 1, width: 4 });
			canvas.paint((p) => p.text(0, 0, 'abcd'));
			canvas.present();
			expect(canvas.snapshot().toString()).toBe('abcd');
		});

		it('should hold nothing before anything was presented', () => {
			const canvas = createCanvas({ height: 1, width: 4 });
			canvas.paint((p) => p.text(0, 0, 'abcd'));
			// painted but not presented, so the screen is still blank
			expect(canvas.snapshot().toString()).toBe('');
		});

		it('should be a copy rather than the grid the next frame writes into', () => {
			// handing the live `front` over would give a layer that tracked the
			// screen it is supposed to be a snapshot of, which composites as a no-op
			const canvas = createCanvas({ height: 1, width: 4 });
			canvas.paint((p) => p.text(0, 0, 'abcd'));
			canvas.present();
			const snap = canvas.snapshot();

			canvas.paint((p) => p.text(0, 0, 'wxyz'));
			canvas.present();
			expect(snap.toString()).toBe('abcd');
		});

		it('should carry which cells were painted, not only what they held', () => {
			// a copy that kept the characters and lost the occupancy would composite
			// as a grid of transparent blanks wherever the frame had nothing on it,
			// and the whole point of taking one is that it occludes exactly where the
			// frame did
			const canvas = createCanvas({ height: 1, width: 6 });
			canvas.paint((p) => p.text(1, 0, 'XX'));
			canvas.present();
			const snap = canvas.snapshot();

			expect([0, 1, 2, 3].map((x) => snap.occupiedAt(x, 0))).toEqual([false, true, true, false]);

			canvas.layers.push({ cells: snap, x: 0, y: 0 });
			canvas.paint((p) => p.text(0, 0, 'abcdef'));
			expect(canvas.toString()).toBe('aXXdef');
		});
	});

	describe('the cheap path: a dissolve over a snapshot', () => {
		it('should give way from the old frame to the new one as the threshold falls', () => {
			// the thing that survives if the ticket is cut down, end to end: snapshot
			// the screen, push it as a layer with a mask, ramp the threshold to -1
			// and drop it. Nothing else can do this -- a transition needs the
			// previous screen's content, and by the time anybody wants one the state
			// that produced it is gone
			const canvas = createCanvas({ height: 1, width: 4 });
			canvas.paint((p) => p.text(0, 0, 'OLD!'));
			canvas.present();

			const mask = wipeMask(4, 1, 'left');
			canvas.layers.push({ cells: canvas.snapshot(), mask, x: 0, y: 0 });

			const frames: string[] = [];
			for (const step of [4, 3, 2, 1, 0]) {
				mask.threshold = maskThreshold(step / 4);
				canvas.paint((p) => p.text(0, 0, 'new.'));
				canvas.present();
				frames.push(canvas.toString());
			}
			canvas.layers.length = 0;
			canvas.paint((p) => p.text(0, 0, 'new.'));

			expect(frames).toEqual(['OLD!', 'nLD!', 'neD!', 'new!', 'new.']);
			expect(canvas.toString()).toBe('new.');
		});
	});

	describe('the style table sweep', () => {
		/**
		 * Paints enough distinct styles to carry the table past `SWEEP_MIN` and
		 * past twice what the last sweep left.
		 *
		 * The number is the point: the sweep fires only when the table has both
		 * grown past 256 entries **and** doubled, so a demo painting a dozen styles
		 * never reaches it. Seven frames of forty distinct truecolour cells is 281
		 * entries, which is the first frame that qualifies.
		 */
		const growPastSweep = (canvas: ReturnType<typeof createCanvas>): void => {
			for (let frame = 1; frame <= 7; frame++) {
				canvas.paint((p) => {
					for (let x = 0; x < 40; x++) {
						p.text(x, 0, '#', { fg: rgb(frame, x, 7) });
					}
				});
				canvas.present();
			}
		};

		/** The index a fresh style lands on, which says how big the table is. */
		const freshIndex = (canvas: ReturnType<typeof createCanvas>, colour: number): number => {
			const probe = new CellBuffer(1, 1);
			canvas.painter(probe).text(0, 0, 'x', { fg: colour });
			return probe.styleAt(0, 0);
		};

		it('should keep a persistent layer’s styles meaning what they meant', () => {
			// the half a layer stack changed, and the one the ticket calls most
			// likely to ship as a heisenbug: the live set used to be read off `front`
			// alone, which is right while the canvas owns exactly two grids and wrong
			// the moment one persists across frames. A dissolve is exactly that --
			// paint both states once and ramp for thirty frames -- so the layer holds
			// indices across a `compact()` and would have them remapped to garbage
			const canvas = createCanvas({ height: 2, width: 40 });
			const over = new CellBuffer(40, 1);
			canvas.painter(over).text(0, 0, 'L', { fg: rgb(1, 2, 3) });
			canvas.layers.push({ cells: over, x: 0, y: 1 });

			growPastSweep(canvas);

			// the layer's cell still names the style it was painted with, which is
			// what a re-intern of the same style answers once the table kept it
			const again = freshIndex(canvas, rgb(1, 2, 3));
			expect(canvas.cells.styleAt(0, 1)).toBe(again);

			// and the terminal is told that colour rather than whatever moved into
			// the slot the index used to name
			canvas.paint((p) => p.text(0, 0, 'base'));
			expect(canvas.present({ full: true }).output).toContain(`${ESC}[38;2;1;2;3m`);
		});

		it('should actually have swept, which is what the test above rests on', () => {
			// without this the test above passes over a table that never compacted,
			// which is the vacuous version of it: every index still means what it
			// meant because nothing moved. A fresh style landing on a low index is
			// what says the table shrank
			const canvas = createCanvas({ height: 2, width: 40 });
			const over = new CellBuffer(40, 1);
			canvas.painter(over).text(0, 0, 'L', { fg: rgb(1, 2, 3) });
			canvas.layers.push({ cells: over, x: 0, y: 1 });

			growPastSweep(canvas);
			// 281 entries were interned; a sweep leaves the forty the last frame
			// named, the layer's one, and the default
			expect(freshIndex(canvas, rgb(9, 9, 9))).toBeLessThan(64);
		});

		it('should drop a style only the base named, which is what the sweep is for', () => {
			// the other direction: the sweep has to still *reclaim*. A colour the
			// first frame painted and nothing has named since must be gone
			const canvas = createCanvas({ height: 2, width: 40 });
			const over = new CellBuffer(40, 1);
			canvas.painter(over).text(0, 0, 'L', { fg: rgb(1, 2, 3) });
			canvas.layers.push({ cells: over, x: 0, y: 1 });

			growPastSweep(canvas);
			// `rgb(1, 0, 7)` was frame one's first cell and has not been painted
			// since, so a re-intern of it is a new entry rather than a survivor
			const kept = freshIndex(canvas, rgb(1, 2, 3));
			const dropped = freshIndex(canvas, rgb(1, 0, 7));
			expect(dropped).toBeGreaterThan(kept);
		});

		it('should remap a buffer two layers share exactly once', () => {
			// `remap()` rewrites an index through the move map, so a grid rewritten
			// twice is read through the map twice and lands on `moved[moved[i]]`. Two
			// layers legitimately share one buffer -- the same sprite at two origins
			// is two `Layer`s over one grid -- so the duplicate is reachable rather
			// than pathological
			const canvas = createCanvas({ height: 3, width: 40 });
			const sprite = new CellBuffer(2, 1);
			canvas.painter(sprite).text(0, 0, 'SS', { fg: rgb(4, 5, 6) });
			canvas.layers.push({ cells: sprite, x: 0, y: 1 });
			canvas.layers.push({ cells: sprite, x: 10, y: 2 });

			growPastSweep(canvas);

			const again = freshIndex(canvas, rgb(4, 5, 6));
			expect(canvas.cells.styleAt(0, 1)).toBe(again);
			expect(canvas.cells.styleAt(10, 2)).toBe(again);
		});
	});
});
