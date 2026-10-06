/**
 * A terminal, as far as the canvas is concerned, and the replay that is how this
 * module's output is tested.
 *
 * The diff's whole job is "these bytes turn what is on screen into what should
 * be". Asserting on the bytes pins an implementation; replaying them against a
 * model and comparing the result pins the *claim*. This is the only way to test
 * a diff that is allowed to get cleverer later.
 *
 * A module of its own rather than a class inside `diff.test.ts`, because there
 * are two readers of it now: the diff, and the layer composite -- whose claim is
 * the same sentence, since a composite reaches the screen through the diff and
 * through nothing else. Two copies of a model terminal is two models to come to
 * disagree about the deferred wrap, which is the thing this repository writes
 * down about every rule it says twice.
 *
 * Not `screen.ts`, which is the backend's and is *screen*-relative: it has rows
 * that scroll off the top, a cursor that survives between frames, and an
 * alternate buffer to switch to. This one is canvas-relative, because every
 * coordinate the diff emits is, and a backend's job is the part it assumes away.
 */

import {
	type CellBuffer,
	cellWidth,
	DEFAULT_STYLE,
	diff,
	type DiffResult,
	type Style,
	type StyleTable,
	transition,
} from '../../src/canvas/index.js';
import { graphemes } from '../../src/width/index.js';
import { expect } from 'vitest';

export const ESC: string = String.fromCharCode(0x1b);

/**
 * Built rather than written as a literal, for the reason `src/ansi/codes.ts`
 * gives: the formatter normalizes `\u001B` into the raw control character, and a
 * raw control character in source is invisible in an editor and in a diff.
 */
export const CSI: RegExp = new RegExp(`^${ESC}\\[([\\d;:]*)([A-Za-z])`);

/**
 * An OSC sequence and its body, up to either terminator.
 *
 * Both spellings are matched because both are in the wild: `ESC \` is what the
 * specification says and what the diff emits, and BEL is the older form that
 * plenty of terminals still accept. A model that knew only one would pass a
 * frame that no terminal could read.
 */
export const OSC: RegExp = new RegExp(`^${ESC}\\]([^${ESC}\\u0007]*)(?:${ESC}\\\\|\\u0007)`);

/** Every escape sequence, for asking what text a frame actually wrote. */
export const SEQUENCES: RegExp = new RegExp(`${ESC}\\[[\\d;:]*[A-Za-z]`, 'g');

/** What a frame put on screen, with the sequences and carriage returns gone. */
export function written(output: string): string {
	return output.replaceAll(SEQUENCES, '').replaceAll('\r', '');
}

export const style = (over: Partial<Style> = {}): Style => ({ ...DEFAULT_STYLE, ...over });

/** Escape sequences made readable, so a failing assertion says something. */
export function readable(output: string): string {
	return output.replaceAll(ESC, '^[').replaceAll('\r', '^M');
}

/**
 * A terminal, as far as this module is concerned: a grid, a cursor, and enough
 * of an escape-sequence parser to move one around the other.
 */
export class FakeTerminal {
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

			// a grapheme cluster, which may be more than one code unit. Measured with
			// `cellWidth()` rather than `graphemeWidth()`, because the grid and the
			// diff both take two as the most a cluster can occupy -- asking what the
			// cluster contains instead put the model a column right of where the diff
			// said the cursor was, and refused a three-wide cluster at the second
			// column of a grid that had already fitted it into two cells
			const cluster = graphemes(output.slice(i))[0];
			const width = cellWidth(cluster);

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
					if (lead === undefined || cellWidth(lead) !== 2) {
						throw new Error(`orphaned continuation at ${x},${y}`);
					}
					continue;
				}

				if (cellWidth(cell) === 2) {
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
export function replay(
	previous: CellBuffer,
	next: CellBuffer,
	styles: StyleTable,
	full = false
): Replayed {
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

/**
 * What a replay reports.
 *
 * Written out rather than inferred because `isolatedDeclarations` cannot infer
 * an object literal with shorthand properties in it, which is the same reason
 * the property table in `src/style/` spells its codes out.
 */
export interface Replayed {
	/** The hyperlink in effect at each cell. */
	links: string[][];
	/** What the model ended up showing. */
	lines: string[];
	/** The bytes the diff emitted. */
	output: string;
	/** What the diff reported about where the cursor ended up. */
	result: DiffResult;
	/** The style index at each cell, as the model resolved it. */
	styles: number[][];
	/** The model itself, for anything the fields above do not say. */
	terminal: FakeTerminal;
}
