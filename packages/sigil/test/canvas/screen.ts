import { ESC } from '../../src/ansi/codes.js';

/**
 * A terminal screen: scrollback, a viewport, a cursor, and enough of a parser to
 * move one around the other.
 *
 * `diff.test.ts` has a model of its own and this is deliberately not it. That
 * one is canvas-relative -- every `apply()` starts from the canvas origin,
 * because that is the only thing the diff's output claims to know about. A
 * backend's whole job is the part that model assumes away: where the canvas sits
 * on a screen whose log is scrolling underneath it. So this one has rows that
 * scroll off the top, a cursor that survives between frames, and an alternate
 * buffer to switch to.
 *
 * Asserting on the bytes a backend emits would pin one implementation of the
 * cursor arithmetic. Replaying them against this pins the claim: after these
 * frames, this is what the user is looking at.
 */

/** A CSI sequence: the parameters, any private marker, and the final byte. */
const CSI = new RegExp(`^${ESC}\\[(\\??)([\\d;:]*)([A-Za-z])`);

/** SGR and anything else that only changes how text looks, which this ignores. */
const OSC = new RegExp(`^${ESC}\\]([^${ESC}\\u0007]*)(?:${ESC}\\\\|\\u0007)`);

interface Buffer {
	/** Rows that have scrolled off the top. The main buffer's only. */
	scrollback: string[][];
	rows: string[][];
}

export class Screen {
	column = 0;
	/** Whether the cursor is hidden, so a test can assert who put it back. */
	cursorHidden = false;
	row = 0;
	/** Whether the alternate buffer is in front. */
	alternate = false;
	/**
	 * Whether the last graphic write filled the final column.
	 *
	 * A terminal writing the last column of a row does not advance past it -- it
	 * arms a wrap instead and stays put, and the next graphic character is what
	 * moves down. Any cursor movement disarms it. Modelled because a full-width
	 * canvas writes that column on every frame, and a model that walked the
	 * cursor off the edge would disagree with the row the backend is tracking.
	 */
	wrapPending = false;

	#main: Buffer;
	#alt: Buffer;
	/** Where the cursor was on the main screen when the alternate one was entered. */
	#saved: { column: number; row: number } | undefined;

	constructor(
		public width: number,
		public height: number
	) {
		this.#main = { rows: this.#blank(), scrollback: [] };
		this.#alt = { rows: this.#blank(), scrollback: [] };
	}

	#blank(): string[][] {
		return Array.from({ length: this.height }, () => Array.from({ length: this.width }, () => ' '));
	}

	get #buffer(): Buffer {
		return this.alternate ? this.#alt : this.#main;
	}

	/** The viewport, trailing spaces trimmed, as a test wants to read it. */
	get viewport(): string[] {
		return this.#buffer.rows.map((row) => row.join('').replace(/\s+$/, ''));
	}

	/** Everything the main buffer has held: what scrolled off, then the viewport. */
	get log(): string[] {
		const buffer = this.#main;
		return [...buffer.scrollback, ...buffer.rows].map((row) => row.join('').replace(/\s+$/, ''));
	}

	/** The log with the blank rows below the last written one dropped. */
	get written(): string[] {
		const lines = this.log;
		while (lines.length > 0 && lines.at(-1) === '') {
			lines.pop();
		}
		return lines;
	}

	#scroll(): void {
		const buffer = this.#buffer;
		const top = buffer.rows.shift();
		// only the main buffer keeps what scrolls off it; the alternate one has no
		// scrollback, which is the whole reason a full-screen app uses it
		if (top && !this.alternate) {
			buffer.scrollback.push(top);
		}
		buffer.rows.push(Array.from({ length: this.width }, () => ' '));
	}

	#down(): void {
		if (this.row === this.height - 1) {
			this.#scroll();
		} else {
			this.row++;
		}
	}

	/**
	 * Resizes, the way a terminal does when its window changes.
	 *
	 * Rows are padded or truncated and the viewport grows or shrinks from the
	 * bottom. A real terminal rewraps, which is precisely the thing a backend
	 * cannot predict and why a resize throws the old frame away rather than
	 * diffing against it -- so modelling the rewrap would be modelling something
	 * nothing is allowed to rely on.
	 *
	 * @param width - The new width.
	 * @param height - The new height.
	 */
	resize(width: number, height: number): void {
		for (const buffer of [this.#main, this.#alt]) {
			for (const row of buffer.rows) {
				while (row.length > width) {
					row.pop();
				}
				while (row.length < width) {
					row.push(' ');
				}
			}
			while (buffer.rows.length > height) {
				const top = buffer.rows.shift();
				if (top && buffer === this.#main) {
					buffer.scrollback.push(top);
				}
			}
			while (buffer.rows.length < height) {
				buffer.rows.push(Array.from({ length: width }, () => ' '));
			}
		}

		this.width = width;
		this.height = height;
		this.row = Math.min(this.row, height - 1);
		this.column = Math.min(this.column, width - 1);
	}

	/** Applies a chunk of output, from wherever the cursor already is. */
	write(output: string): void {
		let i = 0;

		while (i < output.length) {
			const ch = output[i];

			if (ch === '\r') {
				this.column = 0;
				this.wrapPending = false;
				i++;
				continue;
			}

			if (ch === '\n') {
				this.#down();
				this.wrapPending = false;
				i++;
				continue;
			}

			if (ch === ESC) {
				const osc = OSC.exec(output.slice(i));
				if (osc) {
					i += osc[0].length;
					continue;
				}

				const csi = CSI.exec(output.slice(i));
				if (!csi) {
					throw new Error(`unparsed escape at ${i}: ${JSON.stringify(output.slice(i, i + 12))}`);
				}

				const [match, priv, params, final] = csi;
				const n = Number.parseInt(params, 10) || 1;
				i += match.length;

				if (priv === '?') {
					// the private modes this models: the cursor and the alternate screen
					if (params === '25') {
						this.cursorHidden = final === 'l';
					} else if (params === '1049' && final === 'h') {
						// 1049 saves the cursor, switches, and clears, which is the whole
						// reason it is the one worth using
						this.#saved = { column: this.column, row: this.row };
						this.alternate = true;
						this.#alt.rows = this.#blank();
						this.row = 0;
						this.column = 0;
					} else if (params === '1049' && final === 'l') {
						this.alternate = false;
						if (this.#saved) {
							this.row = this.#saved.row;
							this.column = this.#saved.column;
							this.#saved = undefined;
						}
					}
					this.wrapPending = false;
					continue;
				}

				switch (final) {
					case 'A': {
						this.row = Math.max(0, this.row - n);
						this.wrapPending = false;
						break;
					}
					case 'B': {
						// CUD stops at the bottom margin: it never scrolls, which is the
						// whole reason a backend reserves its rows with newlines instead
						this.row = Math.min(this.height - 1, this.row + n);
						this.wrapPending = false;
						break;
					}
					case 'C': {
						this.column = Math.min(this.width - 1, this.column + n);
						this.wrapPending = false;
						break;
					}
					case 'H': {
						this.row = params ? Math.max(0, n - 1) : 0;
						this.column = 0;
						this.wrapPending = false;
						break;
					}
					case 'J': {
						if (params === '' || params === '0') {
							for (let x = this.column; x < this.width; x++) {
								this.#buffer.rows[this.row][x] = ' ';
							}
							for (let y = this.row + 1; y < this.height; y++) {
								this.#buffer.rows[y] = Array.from({ length: this.width }, () => ' ');
							}
						}
						this.wrapPending = false;
						break;
					}
					case 'K': {
						for (let x = this.column; x < this.width; x++) {
							this.#buffer.rows[this.row][x] = ' ';
						}
						this.wrapPending = false;
						break;
					}
					case 'm': {
						// styling, which a screen model has no opinion about
						break;
					}
					default: {
						throw new Error(`unmodelled sequence: ${final}`);
					}
				}
				continue;
			}

			if (this.wrapPending) {
				this.column = 0;
				this.#down();
				this.wrapPending = false;
			}

			this.#buffer.rows[this.row][this.column] = ch;

			if (this.column === this.width - 1) {
				this.wrapPending = true;
			} else {
				this.column++;
			}
			i++;
		}
	}
}

/** A TTY write stream over a `Screen`, with a way to resize it from a test. */
export interface ScreenStream {
	columns: number;
	isTTY: true;
	on(event: string, fn: (...args: unknown[]) => void): ScreenStream;
	removeListener(event: string, fn: (...args: unknown[]) => void): ScreenStream;
	/** Resizes the screen and tells whoever is listening, as a TTY does. */
	resize(width: number, height: number): void;
	rows: number;
	write(chunk: string): boolean;
}

/**
 * A terminal-shaped object over a `Screen`, for `createTerminal({ stdout })`.
 *
 * @param screen - The screen to write into.
 * @returns The stream, plus the resize hook a terminal listens for.
 */
export function screenStream(screen: Screen): ScreenStream {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	return {
		columns: screen.width,
		isTTY: true as const,
		on(event: string, fn: (...args: unknown[]) => void): ScreenStream {
			let set = listeners.get(event);
			if (!set) {
				set = new Set();
				listeners.set(event, set);
			}
			set.add(fn);
			return this;
		},
		removeListener(event: string, fn: (...args: unknown[]) => void): ScreenStream {
			listeners.get(event)?.delete(fn);
			return this;
		},
		resize(width: number, height: number): void {
			screen.resize(width, height);
			this.columns = width;
			this.rows = height;
			for (const fn of listeners.get('resize') ?? []) {
				fn();
			}
		},
		rows: screen.height,
		write(chunk: string): boolean {
			screen.write(chunk);
			return true;
		},
	};
}
