import {
	ATTR,
	CellBuffer,
	createCanvas,
	createSelection,
	diff,
	paintSelection,
	Painter,
	palette,
	rgb,
	type Selection,
	StyleTable,
} from '../../src/canvas/index.js';
import { stringWidth } from '../../src/width/index.js';
import { ESC, FakeTerminal, replay, style, written } from './fake-terminal.js';
import { describe, expect, it, vi } from 'vitest';

describe('diff', () => {
	it('should write nothing when nothing changed', () => {
		const styles = new StyleTable();
		const a = new CellBuffer(10, 2);
		const b = new CellBuffer(10, 2);
		a.write(0, 0, 'hello', 0);
		b.write(0, 0, 'hello', 0);

		expect(diff(a, b, { styles }).output).toBe('');
	});

	it('should write everything on a full repaint', () => {
		const styles = new StyleTable();
		const a = new CellBuffer(5, 1);
		const b = new CellBuffer(5, 1);
		b.write(0, 0, 'hi', 0);

		const { lines } = replay(a, b, styles, true);
		expect(lines).toEqual(['hi   ']);
	});

	it('should reconcile a one-cell change', () => {
		const styles = new StyleTable();
		const a = new CellBuffer(10, 1);
		const b = new CellBuffer(10, 1);
		a.write(0, 0, 'hello', 0);
		b.write(0, 0, 'hallo', 0);

		const { lines, output } = replay(a, b, styles);
		expect(lines).toEqual(['hallo     ']);
		// one cell changed, so at most one cell is written
		expect(written(output)).toBe('a');
	});

	it('should reach a later row without repainting the ones between', () => {
		const styles = new StyleTable();
		const a = new CellBuffer(10, 4);
		const b = new CellBuffer(10, 4);
		for (const buffer of [a, b]) {
			buffer.write(0, 0, 'row zero', 0);
			buffer.write(0, 1, 'row one', 0);
			buffer.write(0, 2, 'row two', 0);
		}
		b.write(0, 3, 'row three', 0);

		const { lines, output } = replay(a, b, styles);
		expect(lines[3]).toBe('row three ');
		expect(output).not.toContain('row zero');
	});

	it('should paint through a gap too short to be worth a cursor move', () => {
		const styles = new StyleTable();
		const a = new CellBuffer(20, 1);
		const b = new CellBuffer(20, 1);
		a.write(0, 0, 'aXbbbbbbXc', 0);
		b.write(0, 0, 'aYbbbbbbYc', 0);

		const { lines, output } = replay(a, b, styles);
		expect(lines).toEqual(['aYbbbbbbYc          ']);
		// six unchanged cells between two changes is more than the threshold, so
		// the cursor jumps rather than repainting them
		expect(output).toContain(`${ESC}[`);
	});

	it('should leave the cursor where it says it did', () => {
		const styles = new StyleTable();
		const a = new CellBuffer(10, 3);
		const b = new CellBuffer(10, 3);
		b.write(2, 1, 'hi', 0);

		const terminal = new FakeTerminal(10, 3);
		terminal.prime(a);
		const result = diff(a, b, { styles });
		terminal.apply(result.output, () => 0);

		expect({ column: terminal.column, row: terminal.row }).toEqual({
			column: result.column,
			row: result.row,
		});
	});

	// the model used to walk the cursor off the right edge, which agreed with
	// neither the diff nor a terminal -- so asserting either of these would have
	// failed the harness, and the two fields went untested instead
	describe('the deferred wrap', () => {
		it('should leave it armed after filling the last column', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(6, 2);
			const b = new CellBuffer(6, 2);
			b.write(0, 0, 'abcdef', 0);

			// writing the last column does not advance the cursor past it: there is
			// nowhere to go, so the cursor stays and the wrap waits for the next
			// character
			const { result, terminal } = replay(a, b, styles);
			expect(result.wrapPending).toBe(true);
			expect(result.column).toBe(5);
			expect({ column: terminal.column, row: terminal.row }).toEqual({ column: 5, row: 0 });
		});

		it('should arm it for a wide cluster that ends at the edge', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(4, 1);
			const b = new CellBuffer(4, 1);
			b.write(0, 0, 'ab漢', 0);

			const { result } = replay(a, b, styles);
			expect(result.wrapPending).toBe(true);
			expect(result.column).toBe(3);
		});

		it('should not let a filled row push the next one down a line', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(4, 2);
			const b = new CellBuffer(4, 2);
			b.write(0, 0, 'abcd', 0);
			b.write(0, 1, 'efgh', 0);

			// the move to the next row disarms the wrap, so the row below is written
			// where it was asked for rather than one further down
			const { lines, result } = replay(a, b, styles);
			expect(lines).toEqual(['abcd', 'efgh']);
			expect({ row: result.row, wrapPending: result.wrapPending }).toEqual({
				row: 1,
				wrapPending: true,
			});
		});

		// the diff never emits either of these -- it moves before it writes again --
		// but the model is what stands in for a terminal, and these are the halves
		// of the deferred wrap that everything above is relying on
		it('should take the wrap on the next character rather than when it was armed', () => {
			const terminal = new FakeTerminal(3, 2);
			terminal.apply('abcd', () => 0);

			expect(terminal.toLines()).toEqual(['abc', 'd  ']);
			expect({
				column: terminal.column,
				row: terminal.row,
				wrapPending: terminal.wrapPending,
			}).toEqual({ column: 1, row: 1, wrapPending: false });
		});

		it('should disarm it on a carriage return', () => {
			const terminal = new FakeTerminal(3, 2);
			terminal.apply('abc\rx', () => 0);

			// the wrap was armed and then thrown away, so `x` lands back on this row
			expect(terminal.toLines()).toEqual(['xbc', '   ']);
			expect(terminal.row).toBe(0);
		});

		it('should leave it clear when the last run stopped short of the edge', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(6, 1);
			const b = new CellBuffer(6, 1);
			b.write(0, 0, 'abc', 0);

			const { result } = replay(a, b, styles);
			expect(result.wrapPending).toBe(false);
			expect(result.column).toBe(3);
		});
	});

	describe('styles', () => {
		it('should emit a style only when it changes', () => {
			const styles = new StyleTable();
			const bold = styles.intern(style({ attrs: ATTR.bold }));
			const a = new CellBuffer(10, 1);
			const b = new CellBuffer(10, 1);
			b.write(0, 0, 'abcd', bold);

			const { output } = replay(a, b, styles);
			// one opening sequence for the run, and one reset at the end
			expect(output.match(new RegExp(`${ESC}\\[[\\d;:]*m`, 'g'))?.length).toBe(2);
		});

		it('should carry styles across the replayed frame', () => {
			const styles = new StyleTable();
			const bold = styles.intern(style({ attrs: ATTR.bold }));
			const a = new CellBuffer(6, 1);
			const b = new CellBuffer(6, 1);
			b.write(0, 0, 'ab', bold);
			b.write(2, 0, 'cd', 0);

			const terminal = new FakeTerminal(6, 1);
			terminal.prime(a);
			const result = diff(a, b, { styles });
			const byParams = new Map([
				['1', bold],
				['0', 0],
				['22', 0],
			]);
			terminal.apply(result.output, (p) => byParams.get(p) ?? 0);

			expect(terminal.styles[0].slice(0, 4)).toEqual([bold, bold, 0, 0]);
		});

		it('should reset before handing the terminal back', () => {
			const styles = new StyleTable();
			const red = styles.intern(style({ fg: palette(1) }));
			const a = new CellBuffer(4, 1);
			const b = new CellBuffer(4, 1);
			b.write(0, 0, 'x', red);

			// the next thing written is the app's own output, and it did not ask to
			// be coloured
			expect(diff(a, b, { styles }).output.endsWith(`${ESC}[0m`)).toBe(true);
		});

		it('should repaint a cell whose only change is its style', () => {
			const styles = new StyleTable();
			const red = styles.intern(style({ fg: palette(1) }));
			const a = new CellBuffer(4, 1);
			const b = new CellBuffer(4, 1);
			a.write(0, 0, 'ab', 0);
			b.write(0, 0, 'ab', red);

			expect(diff(a, b, { styles }).output).not.toBe('');
		});

		it('should emit colours the way the styler does', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(8, 1);
			const b = new CellBuffer(8, 1);
			b.write(0, 0, 'x', styles.intern(style({ fg: rgb(255, 128, 0) })));
			b.write(2, 0, 'y', styles.intern(style({ bg: palette(200) })));

			// the semicolon form, which is what every terminal that does 256 or
			// 24-bit colour accepts. The colon form is what the specification says
			// and a strict subset of terminals implement
			const output = diff(a, b, { styles }).output;
			expect(output).toContain('38;2;255;128;0');
			expect(output).toContain('48;5;200');
		});

		it('should use the short codes for the basic sixteen', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(8, 1);
			const b = new CellBuffer(8, 1);
			b.write(0, 0, 'x', styles.intern(style({ fg: palette(1) })));
			b.write(2, 0, 'y', styles.intern(style({ fg: palette(9) })));

			// understood by terminals that do not do 256 colour at all
			const output = diff(a, b, { styles }).output;
			expect(output).toContain('31');
			expect(output).toContain('91');
		});

		it('should reopen an attribute a shared closing code took down', () => {
			const styles = new StyleTable();
			const both = styles.intern(style({ attrs: ATTR.bold | ATTR.dim }));
			const dimOnly = styles.intern(style({ attrs: ATTR.dim }));
			const a = new CellBuffer(6, 1);
			const b = new CellBuffer(6, 1);
			// two adjacent runs in one frame: the transition is between them, not
			// between frames. A frame always starts from the default style, because
			// the one before it handed the terminal back reset
			b.write(0, 0, 'xy', both);
			b.write(2, 0, 'zw', dimOnly);

			// 22 closes bold and dim together, so dim has to be opened again after
			expect(diff(a, b, { styles }).output).toContain('22;2');
		});

		it('should start each frame from the default style', () => {
			const styles = new StyleTable();
			const bold = styles.intern(style({ attrs: ATTR.bold }));
			const italic = styles.intern(style({ attrs: ATTR.italic }));
			const a = new CellBuffer(4, 1);
			const b = new CellBuffer(4, 1);
			a.write(0, 0, 'xy', bold);
			b.write(0, 0, 'xy', italic);

			// the previous frame ended with a reset, so there is no bold to close.
			// Diffing against the old cell's style instead would emit a stray 22
			const output = diff(a, b, { styles }).output;
			expect(output).not.toContain('22');
			expect(output).toContain('3');
		});
	});

	describe('hyperlinks', () => {
		it('should link the cells it was painted on and no others', () => {
			const styles = new StyleTable();
			const linked = styles.intern(style({ link: 'https://a.dev' }));
			const a = new CellBuffer(10, 1);
			const b = new CellBuffer(10, 1);
			b.write(0, 0, 'no', 0);
			b.write(2, 0, 'yes', linked);
			b.write(5, 0, 'no', 0);

			const { links } = replay(a, b, styles);
			expect(links[0].slice(0, 7)).toEqual([
				'',
				'',
				'https://a.dev',
				'https://a.dev',
				'https://a.dev',
				'',
				'',
			]);
		});

		it('should not paint the URL as text', () => {
			// the whole failure mode this guards: an OSC sequence the terminal does
			// not consume is just characters, and they land on screen
			const styles = new StyleTable();
			const linked = styles.intern(style({ link: 'https://example.dev/path' }));
			const a = new CellBuffer(12, 1);
			const b = new CellBuffer(12, 1);
			b.write(0, 0, 'click', linked);

			const { lines } = replay(a, b, styles);
			expect(lines[0]).toBe('click       ');
		});

		it('should close a link the frame ended inside', () => {
			// `RESET` does not close OSC 8 -- SGR and OSC are separate state -- so a
			// frame that ends mid-link hands the terminal back with it still open and
			// swallows the application's next line into the last cell's URL
			const styles = new StyleTable();
			const linked = styles.intern(style({ link: 'https://a.dev' }));
			const a = new CellBuffer(4, 1);
			const b = new CellBuffer(4, 1);
			b.write(0, 0, 'abcd', linked);

			const { output } = replay(a, b, styles);
			expect(output.endsWith(`${ESC}]8;;${ESC}\\${ESC}[0m`)).toBe(true);
		});

		it('should treat a changed link as a changed cell', () => {
			// same glyph, same colours, different target: the style index moved, so
			// the cell has to be repainted or the link points at the old place
			const styles = new StyleTable();
			const before = styles.intern(style({ link: 'https://a.dev' }));
			const after = styles.intern(style({ link: 'https://b.dev' }));
			const a = new CellBuffer(4, 1);
			const b = new CellBuffer(4, 1);
			a.write(0, 0, 'abcd', before);
			b.write(0, 0, 'abcd', after);

			const { links, output } = replay(a, b, styles);
			expect(output).not.toBe('');
			expect(links[0][0]).toBe('https://b.dev');
		});
	});

	describe('wide characters', () => {
		it('should redraw the whole cluster when only its continuation changed', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(6, 1);
			const b = new CellBuffer(6, 1);
			a.write(0, 0, '漢', 0);
			b.write(0, 0, '漢', styles.intern(style({ attrs: ATTR.bold })));

			const { lines } = replay(a, b, styles);
			expect(lines[0].startsWith('漢')).toBe(true);
		});

		it('should never start a run on a continuation cell', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(8, 1);
			const b = new CellBuffer(8, 1);
			a.write(0, 0, 'ab漢cd', 0);
			b.write(0, 0, 'ab漢cd', 0);
			// change only the continuation's style, which is the second half
			b.write(2, 0, '漢', styles.intern(style({ attrs: ATTR.bold })));

			// the replay throws if the diff ever writes a cluster at a column that
			// would split one, so getting a result at all is the assertion
			const { lines } = replay(a, b, styles);
			expect(lines[0]).toBe('ab漢cd  ');
		});

		it('should clear the orphan when a wide cluster becomes narrow', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(6, 1);
			const b = new CellBuffer(6, 1);
			a.write(0, 0, '漢字', 0);
			b.write(0, 0, 'ab', 0);

			const { lines } = replay(a, b, styles);
			expect(lines).toEqual(['ab    ']);
		});

		// `graphemeWidth()` sums what a cluster contains and comes to three for a
		// CJK character with a spacing mark; the grid holds it in two cells and the
		// diff advances the cursor by two, because `cellWidth()` is the only width
		// either asks about. The model asked `graphemeWidth()` instead, so it ended
		// a column further right than the diff said it did -- and at the edge it
		// refused a cluster the grid had already fitted
		it('should advance by the cells a cluster takes, not by what it contains', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(8, 1);
			const b = new CellBuffer(8, 1);
			b.write(0, 0, '漢ःx', 0);

			const { lines, result } = replay(a, b, styles);
			expect(lines[0]).toBe('漢ःx     ');
			expect(result.column).toBe(3);
		});

		it('should fit one at the last column it has cells for', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(2, 1);
			const b = new CellBuffer(2, 1);
			b.write(0, 0, '漢ः', 0);

			// two cells is all it ever needed, so the row is full and the wrap is
			// armed rather than the write being refused
			const { result } = replay(a, b, styles);
			expect({ column: result.column, wrapPending: result.wrapPending }).toEqual({
				column: 1,
				wrapPending: true,
			});
		});

		it('should never write past the right edge', () => {
			const styles = new StyleTable();
			const a = new CellBuffer(5, 1);
			const b = new CellBuffer(5, 1);
			b.write(0, 0, '漢字', 0);
			// the fifth column cannot hold half of a third wide cluster
			b.write(4, 0, '漢', 0);

			const { lines } = replay(a, b, styles);
			expect(stringWidth(lines[0])).toBe(5);
		});
	});

	describe('a canvas end to end', () => {
		it('should present a frame and then only its changes', () => {
			const canvas = createCanvas({ height: 2, width: 12 });

			canvas.paint((p) => {
				p.text(0, 0, 'hello');
				p.text(0, 1, 'world');
			});
			const first = canvas.present();
			expect(first.output).not.toBe('');
			expect(canvas.toString()).toBe('hello\nworld');

			canvas.paint((p) => {
				p.text(0, 0, 'hello');
				p.text(0, 1, 'w0rld');
			});
			const second = canvas.present();

			expect(written(second.output)).toBe('0');
		});

		it('should write nothing for an unchanged frame', () => {
			const canvas = createCanvas({ height: 1, width: 8 });
			const draw = (p: { text: (x: number, y: number, t: string) => unknown }) => {
				p.text(0, 0, 'steady');
			};

			canvas.paint(draw);
			canvas.present();
			canvas.paint(draw);

			expect(canvas.present().output).toBe('');
		});

		it('should repaint in full after a resize', () => {
			const canvas = createCanvas({ height: 1, width: 8 });
			canvas.paint((p) => p.text(0, 0, 'abc'));
			canvas.present();

			canvas.resize(12, 2);
			canvas.paint((p) => p.text(0, 0, 'abc'));

			// the grid that was on screen described a different terminal, so there
			// is nothing meaningful to diff against
			const { output } = canvas.present();
			expect(output).toContain('abc');
		});

		// `paint()` clears the back buffer and interns again, and nothing dropped an
		// index -- so a canvas painting a colour per cell added a table entry per
		// distinct colour per frame, for as long as the process ran
		it('should stop the style table growing for the life of the canvas', () => {
			const compact = vi.spyOn(StyleTable.prototype, 'compact');

			try {
				const canvas = createCanvas({ height: 8, width: 40 });
				const cells = 8 * 40;

				const paintFrame = (frame: number) =>
					canvas.paint((p) => {
						for (let y = 0; y < 8; y++) {
							for (let x = 0; x < 40; x++) {
								// a colour no other frame uses, which is what an animation over
								// a photograph looks like to the table
								p.text(x, y, 'x', { fg: rgb(frame, y, x) });
							}
						}
					});

				for (let frame = 0; frame < 20; frame++) {
					paintFrame(frame);
					canvas.present();
				}

				const table = compact.mock.instances[0] as unknown as StyleTable;
				expect(compact).toHaveBeenCalled();
				// twenty frames of three hundred and twenty distinct colours is six
				// thousand four hundred entries in a table that never drops one. What
				// is left is bounded by what a frame uses, not by how many were drawn
				expect(table.size).toBeLessThan(cells * 4);

				// and the sweep did not renumber the grids out from under each other:
				// the same frame again is still the same frame
				paintFrame(19);
				expect(canvas.present().output).toBe('');

				// nor lose what a surviving index meant
				canvas.paint((p) => p.text(0, 0, 'z', { fg: rgb(19, 0, 0) }));
				expect(canvas.present().output).toContain('38;2;19;0;0');
			} finally {
				compact.mockRestore();
			}
		});

		it('should drop every style a resize made unreachable', () => {
			const compact = vi.spyOn(StyleTable.prototype, 'compact');

			try {
				const canvas = createCanvas({ height: 1, width: 8 });
				canvas.paint((p) => p.text(0, 0, 'abc', { fg: palette(1) }));
				canvas.present();
				canvas.resize(12, 2);

				// both grids come back blank, so nothing names a style and the whole
				// table is known to be garbage -- the one sweep that needs no walk
				const table = compact.mock.instances[0] as unknown as StyleTable;
				expect(table.size).toBe(1);
			} finally {
				compact.mockRestore();
			}
		});

		it('should clear what a shrinking frame left behind', () => {
			const canvas = createCanvas({ height: 1, width: 10 });
			canvas.paint((p) => p.text(0, 0, 'a long line'));
			canvas.present();

			canvas.paint((p) => p.text(0, 0, 'short'));
			canvas.present();

			expect(canvas.toString()).toBe('short');
		});
	});
});

describe('a selection overlay, replayed', () => {
	/**
	 * The claim no unit test can make: the bytes a highlighted frame produces turn
	 * what is on screen into a screen with those cells reversed. Replayed against
	 * the model rather than asserted as a sequence, which is the rule this file is
	 * built on -- and it is the one place the overlay meets the diff, which is
	 * where a style written to one half of a wide cluster would be lost, since the
	 * diff draws a cluster's lead and skips its continuation.
	 */
	const highlighted = (lines: string[], sel: Selection) => {
		const width = Math.max(...lines.map((line) => stringWidth(line)));
		const styles = new StyleTable();
		const before = new CellBuffer(width, lines.length);
		const after = new CellBuffer(width, lines.length);
		for (const [y, line] of lines.entries()) {
			before.write(0, y, line, StyleTable.DEFAULT);
			after.write(0, y, line, StyleTable.DEFAULT);
		}
		paintSelection(new Painter(after, styles), sel, {
			height: after.height,
			width: after.width,
		});
		// the table beside the replay, because `replay()` hands back the model's
		// per-cell indices under `styles` and the attributes live in the table
		return { ...replay(before, after, styles), table: styles };
	};

	/** Which cells the model ended up showing in reverse video. */
	const reversed = (styles: number[][], table: StyleTable, y: number) =>
		styles[y].map((index) => ((table.get(index).attrs & ATTR.inverse) === 0 ? '.' : '#')).join('');

	it('should reverse exactly the cells the selection covers', () => {
		const out = highlighted(['hello world'], createSelection({ x: 6, y: 0 }, { x: 10, y: 0 }));
		expect(out.lines).toEqual(['hello world']);
		expect(reversed(out.terminal.styles, out.table, 0)).toBe('......#####');
	});

	it('should reverse both columns of a wide cluster, from either half', () => {
		for (const x of [1, 2]) {
			const out = highlighted(['a漢b'], createSelection({ x, y: 0 }, { x, y: 0 }));
			expect(out.lines).toEqual(['a漢b']);
			expect(reversed(out.terminal.styles, out.table, 0)).toBe('.##.');
		}
	});

	it('should reverse a block selection down one column range', () => {
		const out = highlighted(
			['left  right', 'one   two  '],
			createSelection({ x: 0, y: 0 }, { x: 3, y: 1 }, 'block')
		);
		expect(reversed(out.terminal.styles, out.table, 0)).toBe('####.......');
		expect(reversed(out.terminal.styles, out.table, 1)).toBe('####.......');
	});

	it('should put the terminal back where the selection is taken off again', () => {
		// the frame after a selection is the frame before it, so the diff has to
		// turn the reverse video off -- which is the half a one-way test misses
		const width = 11;
		const styles = new StyleTable();
		const plain = new CellBuffer(width, 1);
		const marked = new CellBuffer(width, 1);
		plain.write(0, 0, 'hello world', StyleTable.DEFAULT);
		marked.write(0, 0, 'hello world', StyleTable.DEFAULT);
		paintSelection(new Painter(marked, styles), createSelection({ x: 0, y: 0 }, { x: 4, y: 0 }), {
			height: 1,
			width,
		});

		const on = replay(plain, marked, styles);
		expect(reversed(on.terminal.styles, styles, 0)).toBe('#####......');

		const off = replay(marked, plain, styles);
		expect(reversed(off.terminal.styles, styles, 0)).toBe('...........');
	});
});

describe('Canvas.stats', () => {
	/**
	 * What the diff drew, counted in the loop that already walks the cells.
	 *
	 * `output.length` is bytes and counts the cursor moves and the SGR transitions
	 * along with the glyphs, so it cannot stand in for this -- and a wide cluster
	 * is **one** cell, because one glyph was written and the continuation beside it
	 * is drawn by its lead.
	 */
	it('should count the cells the diff drew, a wide cluster once', () => {
		const canvas = createCanvas({ height: 1, width: 10 });

		// the first present is a full repaint, so it draws every cell of the grid:
		// ten columns, of which `a漢b` is three glyphs over four of them and the
		// six after it are blanks
		canvas.paint((painter) => painter.text(0, 0, 'a漢b'));
		const first = canvas.present();
		expect(first.cells).toBe(9);
		expect(canvas.stats.cells).toBe(9);
		expect(canvas.stats.bytes).toBe(first.output.length);

		// and nothing for a frame that is the frame before it
		canvas.paint((painter) => painter.text(0, 0, 'a漢b'));
		expect(canvas.present().cells).toBe(0);
		expect(canvas.stats.cells).toBe(0);
		expect(canvas.stats.bytes).toBe(0);

		// the wide cluster counted once, which a full repaint cannot show: one glyph
		// moved, and the continuation beside it is drawn by its lead
		canvas.paint((painter) => painter.text(0, 0, 'a漢c'));
		expect(canvas.present().cells).toBe(1);
	});

	/**
	 * A resize takes the last frame's cost with it, because it takes the grid.
	 *
	 * Reported by review: `sweeps` and `styles` are read as of now while `bytes`
	 * and `cells` described the last `present()`, so a `stats` read between a
	 * resize and the next frame reported a pre-resize frame's cells beside a
	 * post-resize style table -- two frames in one object.
	 */
	it('should not report a pre-resize frame beside a post-resize table', () => {
		const canvas = createCanvas({ height: 1, width: 10 });
		canvas.paint((painter) => painter.text(0, 0, 'hello'));
		canvas.present();
		expect(canvas.stats.cells).toBe(10);

		const before = canvas.stats.sweeps;
		canvas.resize(20, 2);

		expect(canvas.stats.cells).toBe(0);
		expect(canvas.stats.bytes).toBe(0);
		// the resize is the one sweep that needs no walk, and it still counts
		expect(canvas.stats.sweeps).toBe(before + 1);
	});

	it('should hand back a snapshot rather than a view of the next frame', () => {
		const canvas = createCanvas({ height: 1, width: 10 });
		canvas.paint((painter) => painter.text(0, 0, 'hello'));
		canvas.present();

		const kept = canvas.stats;
		canvas.paint((painter) => painter.text(0, 0, 'hi   '));
		canvas.present();

		expect(kept.cells).toBe(10);
		expect(canvas.stats.cells).not.toBe(10);
	});
});
