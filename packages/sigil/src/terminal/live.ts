import { stringWidth } from '../width/index.js';
import { type LiveClaim, type Terminal, terminal as defaultTerminal } from './index.js';
import { CURSOR_HOME, cursorUp, ERASE_DOWN } from './sequences.js';

/**
 * How many rows a frame occupies once the terminal has wrapped it.
 *
 * Counting newlines is not the answer: a line longer than the screen takes more
 * than one row, and the repaint walks the cursor up by this number. Count too
 * few and the next frame is written below the last one; count too many and the
 * cursor walks up into the log above the region and erases it.
 *
 * Measured with `stringWidth()` rather than `String.length`, because a CJK
 * character takes two columns and a combining mark takes none -- a progress bar
 * labelled in Japanese wraps at half the characters an ASCII one does.
 *
 * An empty line still occupies a row, which is what the `1` is for.
 *
 * @param frame - The frame, as it would be written.
 * @param columns - The width to wrap against.
 * @returns The number of rows.
 */
export function frameHeight(frame: string, columns: number): number {
	const width = columns > 0 ? columns : 1;
	let rows = 0;

	for (const line of frame.split('\n')) {
		rows += Math.max(1, Math.ceil(stringWidth(line) / width));
	}

	return rows;
}

export interface LiveRegionOptions {
	/** The terminal to draw through. Defaults to the process's. */
	terminal?: Terminal;
}

export interface LiveRegion {
	/** Whether this region still holds the terminal's live claim. */
	readonly active: boolean;
	/** Erases the region, leaving the cursor where it began. */
	clear(): void;
	/**
	 * Leaves a last frame on screen and gives the region up.
	 *
	 * @param final - The frame to leave. Whatever is on screen, if omitted.
	 */
	done(final?: string): void;
	/**
	 * Whether frames can actually be repainted.
	 *
	 * `false` when this is not a terminal -- a pipe, a file, a CI log -- where
	 * there is no cursor to move and nothing to repaint. An animating component
	 * should not animate into that: pass what the frame *means* as `plain` and
	 * one line is written per change, rather than one per tick.
	 */
	readonly isLive: boolean;
	/**
	 * Draws a frame, replacing the one before it.
	 *
	 * @param frame - What to draw.
	 * @param plain - What to write instead when this is not a terminal.
	 */
	render(frame: string, plain?: string): void;
	/** Erases the region and gives it up, leaving nothing behind. */
	stop(): void;
	/** The terminal being drawn through, for anything that sizes itself to it. */
	readonly terminal: Terminal;
	/**
	 * Writes output that stays, above the region rather than through it.
	 *
	 * A `console.log()` while a spinner is running lands wherever the cursor
	 * happens to be, which is inside the spinner's own line. This clears the
	 * region, writes, and draws the frame again underneath.
	 *
	 * @param text - The line to write. A trailing newline is added if missing.
	 */
	write(text: string): void;
}

/**
 * Claims the bottom of the screen and repaints it in place.
 *
 * Inline rather than full-screen: the region is the last few rows, and
 * everything above it scrolls the way it always did. That is the shape a build
 * tool needs -- its output is a log, and taking the whole screen to show a
 * spinner would cost the scrollback that log lives in.
 *
 * The claim is the terminal's, so a second region evicts the first: a spinner
 * still ticking underneath a prompt would draw over it on its next frame.
 *
 * @param opts - The terminal to draw through.
 * @returns The region.
 */
export function createLiveRegion(opts: LiveRegionOptions = {}): LiveRegion {
	const terminal = opts.terminal ?? defaultTerminal;

	let claim: LiveClaim | undefined;
	let frame: string | undefined;
	let plainWritten: string | undefined;
	let height = 0;
	let offResize: (() => void) | undefined;
	let cursorHidden = false;

	// after a resize the rows the last frame occupies is not the number it
	// occupied when it was drawn, and there is no way to recover the real one.
	// The next repaint cleans from where the cursor is rather than walking up a
	// number it cannot trust
	let stale = false;

	const isLive = () => terminal.isTTY && !terminal.closed;

	function begin(): boolean {
		if (claim?.active) {
			return true;
		}
		if (claim) {
			// evicted, and an evicted region does not take the screen back
			return false;
		}

		claim = terminal.claimLive(() => {
			// something else wants the region: give back a clean line and stop
			erase();
			finish();
		});

		offResize = terminal.onResize(() => {
			stale = true;
		});

		if (isLive()) {
			terminal.hideCursor();
			cursorHidden = true;
		}

		return true;
	}

	/** Lets go of everything without drawing. */
	function finish(): void {
		offResize?.();
		offResize = undefined;

		if (cursorHidden) {
			cursorHidden = false;
			terminal.showCursor();
		}

		frame = undefined;
		plainWritten = undefined;
		height = 0;
	}

	/** The sequence that puts the cursor at the top of the region and clears it. */
	function eraseSequence(): string {
		if (stale) {
			// the old frame's height is unknowable, so clean from here down and
			// accept that rows above may linger rather than erasing a guess
			stale = false;
			height = 0;
			return CURSOR_HOME + ERASE_DOWN;
		}

		return height > 0 ? cursorUp(height - 1) + CURSOR_HOME + ERASE_DOWN : '';
	}

	function erase(): void {
		if (!isLive()) {
			return;
		}

		const seq = eraseSequence();
		if (seq) {
			terminal.write(seq);
		}

		frame = undefined;
		height = 0;
	}

	return {
		get active() {
			return !!claim?.active;
		},

		clear(): void {
			if (claim?.active) {
				erase();
			}
		},

		done(final?: string): void {
			if (!claim) {
				return;
			}

			if (claim.active) {
				if (final !== undefined) {
					this.render(final);
				}

				// the frame stays, so the cursor has to come off the end of it --
				// otherwise the next thing written lands on the last row of it
				if (isLive() && height > 0) {
					terminal.write('\n');
				}

				claim.release();
			}

			finish();
		},

		get isLive() {
			return isLive();
		},

		render(next: string, plain?: string): void {
			if (!begin()) {
				return;
			}

			if (!isLive()) {
				// nothing to repaint, so what is written is what changed. An animating
				// frame would be a line per tick, which is why `plain` exists
				const line = plain ?? next;
				if (line !== plainWritten) {
					plainWritten = line;
					terminal.write(line.endsWith('\n') ? line : `${line}\n`);
				}
				return;
			}

			if (next === frame && !stale) {
				return;
			}

			terminal.write(eraseSequence() + next);
			frame = next;
			height = frameHeight(next, terminal.width);
		},

		stop(): void {
			if (claim?.active) {
				erase();
				claim.release();
			}
			finish();
		},

		terminal,

		write(text: string): void {
			const line = text.endsWith('\n') ? text : `${text}\n`;

			if (!claim?.active || !isLive()) {
				terminal.write(line);
				return;
			}

			// the frame is redrawn underneath rather than left where it was: the
			// text has to land above it, and the only way there is through it
			const redraw = frame;
			terminal.write(eraseSequence() + line);
			frame = undefined;
			height = 0;

			if (redraw !== undefined) {
				this.render(redraw);
			}
		},
	};
}
