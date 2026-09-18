/**
 * The other half of the canvas: where the rect actually sits.
 *
 * A canvas is a rect of cells and nothing else -- every coordinate it reports is
 * relative to its own top-left, and it deliberately does not know where that is.
 * A backend is the thing that knows. There are two, behind one interface, so
 * that nothing above this line knows which it is drawing through:
 *
 * - **inline**, where the canvas is the last few rows and everything above it
 *   scrolls the way it always did. This is what almost every component wants: a
 *   prompt is one row, a spinner is one row, a progress bar with a label is two,
 *   and taking the whole screen to show one would cost the log its scrollback.
 * - **full screen**, where the canvas is the alternate screen buffer. For a log
 *   viewer, a dashboard, a picker that wants more room than a list of lines.
 *
 * Which one an app gets is the *app's* decision and never a component's. A
 * component that unilaterally took the screen in the middle of a build log is
 * the failure this split exists to make impossible, and it is why a backend is
 * something you construct rather than something a spinner can ask for.
 *
 * They do not nest. The live claim is already exclusive -- one thing repaints at
 * a time, and claiming evicts whoever held it -- so an inline canvas inside a
 * full-screen one is a second holder of a claim that has one.
 */

import {
	CURSOR_HOME,
	CURSOR_TOP_LEFT,
	cursorUp,
	ERASE_DOWN,
	type LiveClaim,
	type Terminal,
	terminal as defaultTerminal,
} from '../terminal/index.js';
import type { Painter } from './buffer.js';
import { type Canvas, createCanvas } from './index.js';

/**
 * Line endings a terminal will still be reading as line endings.
 *
 * A bare `\n` reaches column zero only because the line discipline is
 * translating it, and that translation -- ONLCR -- is off in raw mode, which is
 * where a full-screen app and every prompt live. Untranslated, the second line
 * of anything written starts under the end of the first. Written out here rather
 * than left to the terminal, because whether the terminal is doing it is not
 * something this can see.
 *
 * @param text - What the app asked to write.
 * @returns The same text, with every line ending a carriage return and a line
 * feed.
 */
function crlf(text: string): string {
	return text.replace(/\r?\n/g, '\r\n');
}

/** What a backend is asked to draw: the same callback `Canvas.paint()` takes. */
export type Draw = (painter: Painter, canvas: Canvas) => void;

export interface CanvasBackend {
	/** Whether this backend still holds the screen. */
	readonly active: boolean;
	/** The canvas being drawn. Paint it directly and call `present()`, or use `render()`. */
	readonly canvas: Canvas;
	/**
	 * Leaves the last frame on screen and gives the screen back.
	 *
	 * Inline, that means the frame stays in the log with the cursor below it.
	 * Full screen, there is nowhere for a frame to stay -- the alternate buffer
	 * goes away with everything on it -- so this is `stop()` with the queued
	 * writes flushed.
	 */
	done(): void;
	readonly height: number;
	/**
	 * Whether frames can be repainted at all.
	 *
	 * `false` for a pipe, a file, a CI log: there is no cursor to move and
	 * nothing to repaint, so each frame that differs is written once as plain
	 * text rather than animated in place.
	 */
	readonly isLive: boolean;
	/**
	 * Reconciles the screen with what is painted.
	 *
	 * @param opts - `full` repaints every cell rather than diffing.
	 */
	present(opts?: { full?: boolean }): void;
	/**
	 * Paints a frame and puts it on screen.
	 *
	 * @param draw - Called with a painter over the canvas.
	 */
	render(draw: Draw): void;
	/**
	 * Resizes the canvas.
	 *
	 * Inline only, and it is the app's to call: how many rows the region needs is
	 * a question about the content. A full-screen canvas is the size of the
	 * screen and follows it by itself.
	 *
	 * @param width - The new width.
	 * @param height - The new height.
	 */
	resize(width: number, height: number): void;
	/** Erases what was drawn and gives the screen back, leaving nothing behind. */
	stop(): void;
	/** The terminal being drawn through, for anything that sizes itself to it. */
	readonly terminal: Terminal;
	readonly width: number;
	/**
	 * Writes output that stays, rather than through the canvas.
	 *
	 * A `console.log()` while something is repainting lands wherever the cursor
	 * happens to be, which is inside the frame. Inline, this clears the region,
	 * writes above it, and repaints underneath. Full screen, there is no "above"
	 * -- the alternate buffer has no scrollback -- so the line is held and
	 * written to the main screen on the way out, which is where its reader is.
	 *
	 * @param text - The line to write. A trailing newline is added if missing.
	 */
	write(text: string): void;
}

export interface InlineCanvasOptions {
	/** How many rows the canvas occupies. Defaults to one. */
	height?: number;
	/** The terminal to draw through. Defaults to the process's. */
	terminal?: Terminal;
	/**
	 * How many columns. Defaults to the terminal's width, and follows it.
	 *
	 * A canvas wider than the screen is one whose rows the terminal wraps, and a
	 * wrapped row is an extra row the cursor arithmetic does not know about --
	 * every erase and every move after it is off by as many rows as wrapped.
	 */
	width?: number;
}

export interface FullscreenCanvasOptions {
	/** The terminal to draw through. Defaults to the process's. */
	terminal?: Terminal;
}

/**
 * The shared half of both backends: the live claim, the cursor, and the
 * not-a-terminal fallback.
 *
 * @param terminal - The terminal to draw through.
 * @param onEvict - What to do when something else claims the region.
 * @returns The shared state and its helpers.
 */
function createClaim(terminal: Terminal, onEvict: () => void) {
	let claim: LiveClaim | undefined;
	let hidCursor = false;

	return {
		get active(): boolean {
			return !!claim?.active;
		},

		/**
		 * Takes the screen, or reports that this backend has been evicted.
		 *
		 * @returns Whether this backend may draw.
		 */
		begin(): boolean {
			if (claim?.active) {
				return true;
			}
			if (claim) {
				// evicted, and an evicted backend does not take the screen back
				return false;
			}

			claim = terminal.claimLive(onEvict);

			// only if this is the call that hid it: an app that hid the cursor
			// itself is still hiding it when this stops, and showing it anyway
			// would put back a cursor over somebody else's screen
			hidCursor = terminal.hideCursor();
			return true;
		},

		/** Whether anything was ever claimed, active or not. */
		get claimed(): boolean {
			return claim !== undefined;
		},

		/** Lets go of the cursor and the claim, drawing nothing. */
		finish(): void {
			if (hidCursor) {
				hidCursor = false;
				terminal.showCursor();
			}
			claim?.release();
		},
	};
}

/**
 * A canvas anchored to the last rows of the screen.
 *
 * @param opts - The size and the terminal.
 * @returns The backend.
 */
export function createInlineCanvas(opts: InlineCanvasOptions = {}): CanvasBackend {
	const terminal = opts.terminal ?? defaultTerminal;
	const fixedWidth = opts.width;
	const canvas = createCanvas({
		height: Math.max(1, opts.height ?? 1),
		width: Math.max(1, fixedWidth ?? terminal.width),
	});

	/**
	 * Where the last frame left the cursor, relative to the canvas's top-left.
	 *
	 * Every move a backend makes is relative, because the canvas's own row on the
	 * screen is not a number anything here can learn -- the log above it scrolls.
	 */
	let row = 0;

	/**
	 * Whether the screen currently holds this canvas's rows.
	 *
	 * `false` before the first frame and after anything that threw the region
	 * away: a resize, a write above it, an erase. The next present reserves the
	 * rows again and repaints in full, because there is nothing on screen for a
	 * diff to be a diff against.
	 */
	let anchored = false;

	/** The last frame written when this is not a terminal, so repeats are not. */
	let plainWritten: string | undefined;

	const isLive = (): boolean => terminal.isTTY && !terminal.closed;

	const claim = createClaim(terminal, () => {
		// something else wants the region: give back a clean line and stop
		erase();
		claim.finish();
	});

	/** Puts the cursor at the canvas's top-left and clears from there down. */
	function eraseSequence(): string {
		return anchored ? cursorUp(row) + CURSOR_HOME + ERASE_DOWN : '';
	}

	function erase(): void {
		if (isLive() && anchored) {
			terminal.write(eraseSequence());
		}
		anchored = false;
		row = 0;
	}

	const offResize = terminal.onResize(() => {
		if (fixedWidth !== undefined || !claim.active) {
			return;
		}

		// re-laid out at the new width and repainted whole, rather than diffed
		// against a grid that described a screen that no longer exists. The old
		// frame's rows are not even a number any more: they were written at the old
		// width and the terminal rewrapped them wherever it liked
		erase();
		canvas.resize(Math.max(1, terminal.width), canvas.height);
	});

	function stopDrawing(): void {
		offResize();
		claim.finish();
		plainWritten = undefined;
	}

	const backend: CanvasBackend = {
		get active() {
			return claim.active;
		},

		canvas,

		done(): void {
			if (!claim.claimed) {
				return;
			}

			// the frame stays, so the cursor has to come off the end of it --
			// otherwise the next thing written lands on the last row of the frame
			if (claim.active && isLive() && anchored) {
				terminal.write(cursorUp(row) + CURSOR_HOME + '\n'.repeat(canvas.height));
				anchored = false;
				row = 0;
			}

			stopDrawing();
		},

		get height() {
			return canvas.height;
		},

		get isLive() {
			return isLive();
		},

		present(presentOpts = {}): void {
			if (!claim.begin()) {
				return;
			}

			if (!isLive()) {
				// nothing to repaint, so what is written is what changed. An animating
				// frame would otherwise be one line per tick down a log file
				const text = canvas.toString();
				if (text !== plainWritten) {
					plainWritten = text;
					terminal.write(`${text}\n`);
				}
				return;
			}

			let lead = '';
			let full = presentOpts.full === true;

			if (anchored) {
				lead = cursorUp(row) + CURSOR_HOME;
			} else {
				// the rows have to exist before anything is painted into them.
				// Downward movement is CUD, which stops at the bottom margin and never
				// scrolls -- so a canvas rendered with the cursor on the last row of
				// the screen would paint every one of its rows onto that line. The
				// newlines are what scroll the log up to make room; the walk back up
				// is what puts the cursor where the diff expects to start
				lead = '\n'.repeat(canvas.height - 1) + cursorUp(canvas.height - 1) + CURSOR_HOME;
				full = true;
			}

			const result = canvas.present({ full });

			// an unchanged frame with the rows already reserved is nothing to write,
			// and writing the reposition alone would move the cursor off the place
			// this is tracking it
			if (result.output === '' && anchored) {
				return;
			}

			terminal.write(lead + result.output);
			anchored = true;
			row = result.row;
		},

		render(draw: Draw): void {
			canvas.paint(draw);
			backend.present();
		},

		resize(width: number, height: number): void {
			const next = { height: Math.max(1, height), width: Math.max(1, width) };
			if (next.width === canvas.width && next.height === canvas.height) {
				return;
			}

			// the region goes and is reserved again at the new height on the next
			// present. A canvas that grew needs rows the screen has not given it, and
			// the only way to get them is to scroll the log; one that shrank leaves
			// the rows it is giving up blank behind it, which is a cost paid where it
			// is visible rather than by walking the log up to close the gap
			erase();
			canvas.resize(next.width, next.height);
		},

		stop(): void {
			if (claim.active) {
				erase();
			}
			stopDrawing();
		},

		terminal,

		get width() {
			return canvas.width;
		},

		write(text: string): void {
			const line = text.endsWith('\n') ? text : `${text}\n`;

			if (!claim.active || !isLive()) {
				terminal.write(line);
				return;
			}

			// the text has to land above the canvas, and the only way there is
			// through it: erase, write, and reserve the rows again underneath
			terminal.write(eraseSequence() + crlf(line));
			anchored = false;
			row = 0;
			backend.present({ full: true });
		},
	};

	return backend;
}

/**
 * A canvas that is the whole alternate screen.
 *
 * @param opts - The terminal.
 * @returns The backend.
 */
export function createFullscreenCanvas(opts: FullscreenCanvasOptions = {}): CanvasBackend {
	const terminal = opts.terminal ?? defaultTerminal;
	const canvas = createCanvas({
		height: Math.max(1, terminal.height),
		width: Math.max(1, terminal.width),
	});

	/**
	 * Output that asked to stay, held until the main screen is back.
	 *
	 * The alternate buffer has no scrollback and is thrown away wholesale when it
	 * is left, so there is no "above the region" to write to and nothing written
	 * here would survive being read. Held rather than dropped: a log line the app
	 * thought it had written is worse than a log line that arrives late.
	 */
	const held: string[] = [];

	/** Whether this backend is what switched screens, and so owes a switch back. */
	let entered = false;
	let plainWritten: string | undefined;

	const isLive = (): boolean => terminal.isTTY && !terminal.closed;

	const claim = createClaim(terminal, () => {
		// something else claimed the region. The alternate screen is this
		// backend's and goes back with it, which is also what puts the evictor on
		// a screen anybody can see
		leave();
		claim.finish();
	});

	function leave(): void {
		if (entered) {
			entered = false;
			terminal.leaveAltScreen();
		}
	}

	function flushHeld(): void {
		if (held.length > 0) {
			const text = held.join('');
			terminal.write(isLive() ? crlf(text) : text);
			held.length = 0;
		}
	}

	const offResize = terminal.onResize(({ height, width }) => {
		if (!claim.active) {
			return;
		}
		// a full-screen canvas is the size of the screen by definition, so it
		// follows it rather than waiting to be told. Both grids go, which makes the
		// next present a full repaint of a screen the terminal has just cleared
		canvas.resize(Math.max(1, width), Math.max(1, height));
	});

	const backend: CanvasBackend = {
		get active() {
			return claim.active;
		},

		canvas,

		done(): void {
			backend.stop();
		},

		get height() {
			return canvas.height;
		},

		get isLive() {
			return isLive();
		},

		present(presentOpts = {}): void {
			if (!claim.begin()) {
				return;
			}

			if (!isLive()) {
				const text = canvas.toString();
				if (text !== plainWritten) {
					plainWritten = text;
					terminal.write(`${text}\n`);
				}
				return;
			}

			let full = presentOpts.full === true;
			if (!entered) {
				// entering clears the alternate buffer, so there is nothing on it for
				// a diff to be a diff against
				entered = terminal.enterAltScreen();
				full = true;
			}

			const result = canvas.present({ full });
			if (result.output === '') {
				return;
			}

			// absolute rather than relative: this backend owns every row, so there is
			// no log above to be careful of and no cursor position to carry between
			// frames
			terminal.write(CURSOR_TOP_LEFT + result.output);
		},

		render(draw: Draw): void {
			canvas.paint(draw);
			backend.present();
		},

		resize(): void {
			// the screen decides, and `onResize` has already said so
		},

		stop(): void {
			offResize();
			leave();
			claim.finish();
			flushHeld();
			plainWritten = undefined;
		},

		terminal,

		get width() {
			return canvas.width;
		},

		write(text: string): void {
			const line = text.endsWith('\n') ? text : `${text}\n`;

			if (!claim.active || !isLive()) {
				terminal.write(line);
				return;
			}

			held.push(line);
		},
	};

	return backend;
}
