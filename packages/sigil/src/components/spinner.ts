import { ansi as defaultAnsi, type Ansi } from '../ansi/index.js';
import type { Terminal } from '../terminal/index.js';
import { createLiveRegion, type LiveRegion } from '../terminal/live.js';

/**
 * The default frames, which are Braille dots: they animate smoothly, sit inside
 * one column, and are far more widely rendered than the block characters a
 * fancier spinner would use.
 */
export const DOTS: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Frames for a terminal that cannot be trusted with anything but ASCII. */
export const LINE: readonly string[] = ['-', '\\', '|', '/'];

export interface SpinnerOptions {
	/** The styler to mark up with. Defaults to the process's. */
	ansi?: Ansi;
	/** How long each frame lasts, in milliseconds. Defaults to 80. */
	interval?: number;
	/** What it is doing, shown after the spinner. */
	text?: string;
	/** The frames to cycle. Defaults to `DOTS`. */
	frames?: readonly string[];
	/** The region to draw in. One is made if not given. */
	region?: LiveRegion;
	/** The terminal to draw through. Defaults to the process's. */
	terminal?: Terminal;
}

export interface Spinner {
	/** Whether it is currently spinning. */
	readonly spinning: boolean;
	/** Stops, leaving `text` behind marked as failed. */
	fail(text?: string): void;
	/** Stops, leaving `text` behind marked as an informational note. */
	info(text?: string): void;
	/** Starts spinning, optionally changing the text first. */
	start(text?: string): Spinner;
	/** Stops and erases, leaving nothing behind. */
	stop(): void;
	/** Stops, leaving `text` behind marked as done. */
	succeed(text?: string): void;
	/** What it is doing. Assigning redraws it. */
	text: string;
	/** Stops, leaving `text` behind marked as a warning. */
	warn(text?: string): void;
	/** Writes a line that stays, above the spinner. */
	write(text: string): void;
}

/**
 * A spinner, for work whose length is not known.
 *
 * Where there is no terminal there is nothing to animate, so the frames are
 * dropped and the text is written once per change -- a CI log gets one line per
 * thing the program started doing, rather than one per eightieth of a second.
 * That is the live region's rule and this does not override it.
 *
 * @param opts - What it says and how it looks.
 * @returns The spinner, not yet started.
 */
export function createSpinner(opts: SpinnerOptions = {}): Spinner {
	const ansi = opts.ansi ?? defaultAnsi;
	const frames = opts.frames?.length ? opts.frames : DOTS;
	const interval = opts.interval && opts.interval > 0 ? opts.interval : 80;
	const region = opts.region ?? createLiveRegion({ terminal: opts.terminal });

	let text = opts.text ?? '';
	let frame = 0;
	let timer: NodeJS.Timeout | undefined;

	function draw(): void {
		region.render(`${ansi.cyan(frames[frame % frames.length])} ${text}`, text);
	}

	function tick(): void {
		frame++;
		draw();
	}

	function stopTimer(): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	/**
	 * Stops and leaves one final line, which is the only thing a CI log keeps.
	 *
	 * @param symbol - The mark to lead with.
	 * @param final - The text to leave. The current text, if omitted.
	 */
	function settle(symbol: string, final?: string): void {
		stopTimer();
		if (final !== undefined) {
			text = final;
		}
		region.done(`${symbol} ${text}`);
	}

	const spinner: Spinner = {
		fail(final?: string): void {
			settle(ansi.red('✖'), final);
		},

		info(final?: string): void {
			settle(ansi.blue('ℹ'), final);
		},

		start(next?: string): Spinner {
			if (next !== undefined) {
				text = next;
			}

			if (!timer) {
				draw();

				// only while there is something to animate: a pipe has no frames to
				// show, so a timer would wake the process eighty times a second to
				// render nothing
				if (region.isLive) {
					timer = setInterval(tick, interval);
					// the spinner is not a reason to stay alive -- a program that has
					// finished should exit even if somebody forgot to stop it
					timer.unref?.();
				}
			}

			return spinner;
		},

		get spinning() {
			return timer !== undefined;
		},

		stop(): void {
			stopTimer();
			region.stop();
		},

		succeed(final?: string): void {
			settle(ansi.green('✔'), final);
		},

		get text() {
			return text;
		},

		set text(next: string) {
			text = next;
			if (region.active) {
				draw();
			}
		},

		warn(final?: string): void {
			settle(ansi.yellow('⚠'), final);
		},

		write(line: string): void {
			region.write(line);
		},
	};

	return spinner;
}
