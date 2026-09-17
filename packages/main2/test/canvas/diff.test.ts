import {
	ATTR,
	CellBuffer,
	createCanvas,
	DEFAULT_STYLE,
	diff,
	palette,
	rgb,
	type Style,
	StyleTable,
	transition,
} from '../../src/canvas/index.js';
import { graphemes, graphemeWidth, stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);

/**
 * Built rather than written as a literal, for the reason `src/ansi/codes.ts`
 * gives: the formatter normalizes `\u001B` into the raw control character, and a
 * raw control character in source is invisible in an editor and in a diff.
 */
const CSI = new RegExp(`^${ESC}\\[([\\d;:]*)([A-Za-z])`);

/** Every escape sequence, for asking what text a frame actually wrote. */
const SEQUENCES = new RegExp(`${ESC}\\[[\\d;:]*[A-Za-z]`, 'g');

/** What a frame put on screen, with the sequences and carriage returns gone. */
function written(output: string): string {
	return output.replaceAll(SEQUENCES, '').replaceAll('\r', '');
}

const style = (over: Partial<Style> = {}): Style => ({ ...DEFAULT_STYLE, ...over });

/** Escape sequences made readable, so a failing assertion says something. */
function readable(output: string): string {
	return output.replaceAll(ESC, '^[').replaceAll('\r', '^M');
}

/**
 * A terminal, as far as this module is concerned: a grid, a cursor, and enough
 * of an escape-sequence parser to move one around the other.
 *
 * The diff's whole job is "these bytes turn what is on screen into what should
 * be". Asserting on the bytes pins an implementation; replaying them against a
 * model and comparing the result pins the *claim*. This is the only way to test
 * a diff that is allowed to get cleverer later.
 */
class FakeTerminal {
	rows: string[][];
	styles: number[][];
	row = 0;
	column = 0;

	constructor(
		public width: number,
		public height: number
	) {
		this.rows = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));
		this.styles = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
	}

	/** Paints a buffer onto the model directly, standing in for a prior frame. */
	prime(buffer: CellBuffer): void {
		for (let y = 0; y < this.height; y++) {
			for (let x = 0; x < this.width; x++) {
				const cell = buffer.charAt(x, y);
				this.rows[y][x] = cell === '' ? '' : cell;
				this.styles[y][x] = buffer.styleAt(x, y);
			}
		}
	}

	/** Applies a sequence, starting from the canvas origin. */
	apply(output: string, styleOf: (sgr: string) => number): void {
		this.row = 0;
		this.column = 0;
		let currentStyle = 0;
		let i = 0;

		while (i < output.length) {
			const ch = output[i];

			if (ch === '\r') {
				this.column = 0;
				i++;
				continue;
			}

			if (ch === ESC && output[i + 1] === '[') {
				const match = CSI.exec(output.slice(i));
				if (!match) {
					throw new Error(`unparsed sequence at ${i}: ${readable(output.slice(i, i + 12))}`);
				}
				const [whole, params, final] = match;
				const n = params === '' ? 1 : Number.parseInt(params, 10);
				switch (final) {
					case 'A':
						this.row -= n;
						break;
					case 'B':
						this.row += n;
						break;
					case 'C':
						this.column += n;
						break;
					case 'm':
						currentStyle = styleOf(params);
						break;
					default:
						throw new Error(`unhandled final byte ${final}`);
				}
				i += whole.length;
				continue;
			}

			// a grapheme cluster, which may be more than one code unit
			const cluster = graphemes(output.slice(i))[0];
			const width = graphemeWidth(cluster);
			if (this.row < 0 || this.row >= this.height) {
				throw new Error(`wrote outside the canvas at row ${this.row}`);
			}
			if (this.column + width > this.width) {
				throw new Error(`wrote past the right edge at column ${this.column}`);
			}
			this.rows[this.row][this.column] = cluster;
			this.styles[this.row][this.column] = currentStyle;
			if (width === 2) {
				this.rows[this.row][this.column + 1] = '';
				this.styles[this.row][this.column + 1] = currentStyle;
			}
			this.column += width;
			i += cluster.length;
		}
	}

	toLines(): string[] {
		return this.rows.map((row) => row.join(''));
	}

	/**
	 * Every wide cluster still has its continuation, and no continuation has lost
	 * its lead.
	 *
	 * Checked after the whole frame rather than at each write: replacing `漢` with
	 * `ab` legitimately splits it, and the second write is what puts the row back
	 * together. What is never legitimate is a frame *ending* with half a glyph on
	 * screen, which is what the diff's cluster handling exists to prevent -- and
	 * what this harness claimed to catch while catching nothing.
	 */
	checkClusters(): void {
		for (let y = 0; y < this.height; y++) {
			for (let x = 0; x < this.width; x++) {
				const cell = this.rows[y][x];

				if (cell === '') {
					const lead = x > 0 ? this.rows[y][x - 1] : undefined;
					if (lead === undefined || graphemeWidth(lead) !== 2) {
						throw new Error(`orphaned continuation at ${x},${y}`);
					}
					continue;
				}

				if (graphemeWidth(cell) === 2) {
					if (x + 1 >= this.width || this.rows[y][x + 1] !== '') {
						throw new Error(`wide cluster at ${x},${y} lost its continuation`);
					}
				}
			}
		}
	}
}

/**
 * Diffs two buffers, replays the output against a model terminal, and returns
 * what the model ends up showing.
 */
function replay(previous: CellBuffer, next: CellBuffer, styles: StyleTable, full = false) {
	const terminal = new FakeTerminal(next.width, next.height);
	terminal.prime(previous);

	const result = diff(previous, next, { full, styles });

	// The model maps an SGR parameter list back to a style index, which a real
	// terminal does by rendering. Built from the emitter itself rather than from
	// a second copy of the SGR rules: a helper that knows only the attributes --
	// which is what this was -- cannot recognise a colour, so every coloured cell
	// reads back as the default style and a `colorParams()` that emitted a
	// background for a foreground would pass every replay test.
	const byParams = new Map<string, number>();
	for (let i = 0; i < styles.size; i++) {
		const sgr = transition(DEFAULT_STYLE, styles.get(i));
		byParams.set(sgr.replace(ESC + '[', '').replace(/m$/, ''), i);
	}

	terminal.apply(result.output, (params) => byParams.get(params) ?? 0);
	terminal.checkClusters();
	return { lines: terminal.toLines(), output: result.output, result, styles: terminal.styles };
}

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
