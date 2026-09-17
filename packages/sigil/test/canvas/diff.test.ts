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
import { describe, expect, it, vi } from 'vitest';

const ESC = String.fromCharCode(0x1b);

/**
 * Built rather than written as a literal, for the reason `src/ansi/codes.ts`
 * gives: the formatter normalizes `\u001B` into the raw control character, and a
 * raw control character in source is invisible in an editor and in a diff.
 */
const CSI = new RegExp(`^${ESC}\\[([\\d;:]*)([A-Za-z])`);

/**
 * An OSC sequence and its body, up to either terminator.
 *
 * Both spellings are matched because both are in the wild: `ESC \` is what the
 * specification says and what the diff emits, and BEL is the older form that
 * plenty of terminals still accept. A model that knew only one would pass a
 * frame that no terminal could read.
 */
const OSC = new RegExp(`^${ESC}\\]([^${ESC}\\u0007]*)(?:${ESC}\\\\|\\u0007)`);

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
	/**
	 * The hyperlink in effect when each cell was written.
	 *
	 * Tracked separately from `styles` because OSC 8 is separate state: it is not
	 * carried by SGR, it is not cleared by `\x1b[0m`, and two styles that differ
	 * only by link emit the same SGR parameters -- so the parameter list cannot
	 * tell them apart and this is where the difference has to live.
	 */
	links: string[][];
	row = 0;
	column = 0;
	/**
	 * Whether the last graphic write filled the final column, leaving the wrap
	 * deferred.
	 *
	 * A terminal writing the last column of a row does not advance the cursor
	 * past it -- there is nowhere to go -- so it stays put and arms this instead,
	 * and the *next* graphic character is what moves to the next row. Any cursor
	 * movement disarms it. Modelled because `DiffResult` claims both halves of it
	 * and a model that walked the cursor off the edge agreed with neither the
	 * diff nor a real terminal, so the claim could not be asserted anywhere.
	 */
	wrapPending = false;

	constructor(
		public width: number,
		public height: number
	) {
		this.rows = Array.from({ length: height }, () => Array.from({ length: width }, () => ' '));
		this.styles = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
		this.links = Array.from({ length: height }, () => Array.from({ length: width }, () => ''));
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
		this.wrapPending = false;
		let currentStyle = 0;
		let currentLink = '';
		let i = 0;

		while (i < output.length) {
			const ch = output[i];

			if (ch === '\r') {
				this.column = 0;
				this.wrapPending = false;
				i++;
				continue;
			}

			// OSC: `ESC ] ... ST`, where ST is `ESC \` or BEL. A real terminal
			// consumes the whole thing and paints none of it; before this, the model
			// fell through to the text path and wrote the URL into the grid
			if (ch === ESC && output[i + 1] === ']') {
				const match = OSC.exec(output.slice(i));
				if (!match) {
					throw new Error(`unterminated OSC at ${i}: ${readable(output.slice(i, i + 16))}`);
				}
				const [whole, body] = match;
				const link = /^8;[^;]*;(.*)$/s.exec(body);
				if (!link) {
					throw new Error(`unhandled OSC ${readable(body.slice(0, 16))}`);
				}
				currentLink = link[1];
				i += whole.length;
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
					// every one of these moves the cursor, and a cursor that has been
					// moved has nowhere deferred to wrap to
					case 'A':
						this.row -= n;
						this.wrapPending = false;
						break;
					case 'B':
						this.row += n;
						this.wrapPending = false;
						break;
					case 'C':
						this.column += n;
						this.wrapPending = false;
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

			// the deferred wrap is taken now rather than when it was armed: this is
			// the character that had nowhere to go on the row it was written for
			if (this.wrapPending) {
				this.row++;
				this.column = 0;
				this.wrapPending = false;
			}

			if (this.row < 0 || this.row >= this.height) {
				throw new Error(`wrote outside the canvas at row ${this.row}`);
			}
			if (this.column + width > this.width) {
				throw new Error(`wrote past the right edge at column ${this.column}`);
			}
			this.rows[this.row][this.column] = cluster;
			this.styles[this.row][this.column] = currentStyle;
			this.links[this.row][this.column] = currentLink;
			if (width === 2) {
				this.rows[this.row][this.column + 1] = '';
				this.styles[this.row][this.column + 1] = currentStyle;
				this.links[this.row][this.column + 1] = currentLink;
			}
			this.column += width;
			if (this.column >= this.width) {
				// nowhere to advance to, so the cursor stays on the last column it
				// wrote and the wrap waits for the next character
				this.column = this.width - 1;
				this.wrapPending = true;
			}
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
	// The link is stripped before building the map because `transition()` emits
	// OSC 8 alongside SGR, and the model resolves the two separately -- an SGR
	// parameter list cannot name a link, so two styles differing only by one
	// share an entry here and are told apart by `terminal.links` instead.
	const byParams = new Map<string, number>();
	for (let i = 0; i < styles.size; i++) {
		const sgr = transition(DEFAULT_STYLE, { ...styles.get(i), link: '' });
		const params = sgr.replace(ESC + '[', '').replace(/m$/, '');
		if (!byParams.has(params)) {
			byParams.set(params, i);
		}
	}

	terminal.apply(result.output, (params) => byParams.get(params) ?? 0);
	terminal.checkClusters();

	// where the cursor ended up is a claim the whole frame makes, so every replay
	// checks it rather than the one test that thought to ask. A backend positions
	// itself by these three and cannot see that they are wrong, which is how a
	// field rots with the suite green
	expect({
		column: terminal.column,
		row: terminal.row,
		wrapPending: terminal.wrapPending,
	}).toEqual({ column: result.column, row: result.row, wrapPending: result.wrapPending });

	return {
		lines: terminal.toLines(),
		links: terminal.links,
		output: result.output,
		result,
		styles: terminal.styles,
		terminal,
	};
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
