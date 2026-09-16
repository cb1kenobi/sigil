import { ansi as defaultAnsi, type Ansi } from '../ansi/index.js';
import type { Terminal } from '../terminal/index.js';
import { type LiveRegion, createLiveRegion } from '../terminal/live.js';
import { stringWidth } from '../width/index.js';

export interface ProgressOptions {
	/** The styler to mark up with. Defaults to the process's. */
	ansi?: Ansi;
	/** The character drawn for the part still to do. Defaults to a light block. */
	empty?: string;
	/** The character drawn for the part done. Defaults to a full block. */
	filled?: string;
	/** A label shown before the bar. */
	text?: string;
	/** How wide the bar itself is. Defaults to a third of the terminal, 10-40. */
	barWidth?: number;
	/** The region to draw in. One is made if not given. */
	region?: LiveRegion;
	/** How often a plain log line is written when there is no terminal, in percent. Defaults to 10. */
	step?: number;
	/** The terminal to draw through. Defaults to the process's. */
	terminal?: Terminal;
	/** How many units of work there are. Defaults to 100. */
	total?: number;
}

export interface Progress {
	/** How far along, between 0 and `total`. Assigning redraws. */
	current: number;
	/** Stops, leaving the bar on screen. */
	done(text?: string): void;
	/** Moves forward by `delta`, one by default. */
	tick(delta?: number): void;
	/** Stops and erases, leaving nothing behind. */
	stop(): void;
	/** The label. Assigning redraws. */
	text: string;
	/** How much work there is. Assigning redraws. */
	total: number;
	/** Writes a line that stays, above the bar. */
	write(text: string): void;
}

/**
 * Renders the bar itself.
 *
 * @param ratio - How far along, 0 to 1.
 * @param width - How many columns the bar occupies.
 * @param filled - The character for the part done.
 * @param empty - The character for the part left.
 * @returns The bar.
 */
export function renderBar(ratio: number, width: number, filled: string, empty: string): string {
	const columns = Math.max(1, Math.floor(width));

	// the characters may be wider than one column -- a full block is one, but
	// nothing stops a caller passing an emoji -- and a bar measured in characters
	// would then be twice the width it was asked for and wrap
	const per = Math.max(1, stringWidth(filled), stringWidth(empty));
	const cells = Math.max(1, Math.floor(columns / per));

	const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
	const done = Math.round(clamped * cells);

	return filled.repeat(done) + empty.repeat(cells - done);
}

/**
 * A progress bar, for work whose length is known.
 *
 * Where there is no terminal the bar is not drawn at all: a CI log gets a line
 * every `step` percent instead, because a bar redrawn a thousand times is a
 * thousand lines of nothing anybody will read.
 *
 * @param opts - What it says and how it looks.
 * @returns The bar, drawn at zero.
 */
export function createProgress(opts: ProgressOptions = {}): Progress {
	const ansi = opts.ansi ?? defaultAnsi;
	const region = opts.region ?? createLiveRegion({ terminal: opts.terminal });
	const filled = opts.filled ?? '█';
	const empty = opts.empty ?? '░';
	const step = opts.step && opts.step > 0 ? opts.step : 10;

	let text = opts.text ?? '';
	let total = opts.total && opts.total > 0 ? opts.total : 100;
	let current = 0;

	function barWidth(): number {
		if (opts.barWidth && opts.barWidth > 0) {
			return Math.floor(opts.barWidth);
		}

		// a third of the screen, so the label and the percentage have room, and
		// bounded so it is neither a stub on a narrow terminal nor absurd on a wide.
		// Asked of the region's own terminal rather than of `opts`, which may not
		// have carried one
		return Math.min(40, Math.max(10, Math.floor(region.terminal.width / 3)));
	}

	function draw(): void {
		const ratio = total > 0 ? current / total : 0;
		const percent = `${Math.floor(Math.min(1, Math.max(0, ratio)) * 100)}%`;
		const bar = renderBar(ratio, barWidth(), filled, empty);
		const label = text ? `${text} ` : '';

		region.render(
			`${label}${ansi.cyan(bar)} ${percent}`,
			// a line only every `step` percent: the plain form is what the live
			// region writes when there is no terminal, and it dedupes on it
			`${label}${percentStep(ratio)}%`
		);
	}

	/**
	 * The percentage rounded down to the nearest `step`, which is what makes the
	 * plain form repeat rather than change on every tick.
	 *
	 * @param ratio - How far along.
	 * @returns The stepped percentage.
	 */
	function percentStep(ratio: number): number {
		const percent = Math.floor(Math.min(1, Math.max(0, ratio)) * 100);
		return Math.floor(percent / step) * step;
	}

	draw();

	return {
		get current() {
			return current;
		},

		set current(next: number) {
			current = Math.min(total, Math.max(0, next));
			draw();
		},

		done(final?: string): void {
			if (final !== undefined) {
				text = final;
			}
			current = total;
			draw();
			region.done();
		},

		stop(): void {
			region.stop();
		},

		get text() {
			return text;
		},

		set text(next: string) {
			text = next;
			draw();
		},

		tick(delta = 1): void {
			this.current = current + delta;
		},

		get total() {
			return total;
		},

		set total(next: number) {
			total = next > 0 ? next : 1;
			current = Math.min(current, total);
			draw();
		},

		write(line: string): void {
			region.write(line);
		},
	};
}
