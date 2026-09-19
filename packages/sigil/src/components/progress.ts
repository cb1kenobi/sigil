import { box, type Element, text as textNode } from '../element/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { stringWidth } from '../width/index.js';
import { type Mounted, type MountOptions, mountLive } from './mount.js';

export interface ProgressOptions extends MountOptions {
	/** The character drawn for the part still to do. Defaults to a light block. */
	empty?: string;
	/** The character drawn for the part done. Defaults to a full block. */
	filled?: string;
	/** A label shown before the bar. */
	text?: string;
	/** How wide the bar itself is. Defaults to a third of the terminal, 10-40. */
	barWidth?: number;
	/** How often a plain log line is written when there is no terminal, in percent. Defaults to 10. */
	step?: number;
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

/** What a progress bar's tree is driven by, and what the facade writes to. */
export interface ProgressState {
	/** How far along. */
	readonly current: State<number>;
	/** The label. */
	readonly label: State<string>;
	/** How much work there is. */
	readonly total: State<number>;
}

/**
 * Builds the state a progress bar's tree reads.
 *
 * @param label - The label.
 * @param total - How much work there is.
 * @returns The signals.
 */
export function progressState(label = '', total = 100): ProgressState {
	return { current: new State(0), label: new State(label), total: new State(total) };
}

export interface ProgressViewOptions {
	/** How wide the bar is, in columns. */
	barWidth: () => number;
	/** The character for the part left. */
	empty: string;
	/** The character for the part done. */
	filled: string;
	/**
	 * Whether there is a terminal to draw a bar on.
	 *
	 * There is no bar in a log file. A bar redrawn a thousand times is a thousand
	 * lines of nothing anybody will read, and the percentage is the whole of what
	 * it was saying -- so the plain form is the label and a percentage rounded
	 * down to `step`, which is what makes consecutive frames identical and lets
	 * the backend write one line per change rather than one per tick.
	 */
	live: boolean;
	/** How often the plain form changes, in percent. */
	step: number;
}

/**
 * The progress bar, as an element tree.
 *
 * @param state - What it reads.
 * @param opts - How the bar is drawn.
 * @returns The tree.
 */
export function progressView(state: ProgressState, opts: ProgressViewOptions): Element {
	const label = textNode('', { class: 'sigil-progress-label', 'margin-right': 1 });
	const bar = textNode('', { class: 'sigil-progress-bar', 'margin-right': 1 });
	const percent = textNode('', { class: 'sigil-progress-percent' });

	const ratio = (): number => {
		const total = state.total.get();
		return total > 0 ? state.current.get() / total : 0;
	};

	createEffect(() => {
		const text = state.label.get();
		label.setText(text);
		// the margin is what separates it from the bar, so a label nobody set must
		// not leave one: `display: none` takes its margin with it
		label.setProps({ display: text === '' ? 'none' : 'flex' });
	});

	createEffect(() => {
		bar.setText(opts.live ? renderBar(ratio(), opts.barWidth(), opts.filled, opts.empty) : '');
		bar.setProps({ display: opts.live ? 'flex' : 'none' });
	});

	createEffect(() => {
		const whole = Math.floor(Math.min(1, Math.max(0, ratio())) * 100);
		// a bar that finished says so, whatever `step` divides into: stepping alone
		// left `step: 30` ending its log at 90%, and a bar whose last word is 90%
		// is one the reader cannot tell from a build that stopped there
		const shown = opts.live || whole === 100 ? whole : Math.floor(whole / opts.step) * opts.step;
		percent.setText(`${shown}%`);
	});

	return box({ class: 'sigil-progress' }, label, bar, percent);
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
	const filled = opts.filled ?? '█';
	const empty = opts.empty ?? '░';
	const step = opts.step && opts.step > 0 ? opts.step : 10;
	const state = progressState(opts.text ?? '', opts.total && opts.total > 0 ? opts.total : 100);
	// resolved up front rather than off the backend, because `barWidth()` is read
	// by an effect during the very first render -- which happens inside
	// `mountLive()`, before there is a handle to ask
	const terminal = opts.terminal ?? opts.backend?.terminal ?? defaultTerminal;

	function barWidth(): number {
		if (opts.barWidth && opts.barWidth > 0) {
			return Math.floor(opts.barWidth);
		}

		// a third of the screen, so the label and the percentage have room, and
		// bounded so it is neither a stub on a narrow terminal nor absurd on a wide
		return Math.min(40, Math.max(10, Math.floor(terminal.width / 3)));
	}

	const mounted: Mounted = mountLive(
		(live) => progressView(state, { barWidth, empty, filled, live, step }),
		{ ...opts, terminal }
	);

	function clamp(next: number): number {
		return Math.min(state.total.get(), Math.max(0, next));
	}

	/** Settles the graph and paints, which is what every setter here owes. */
	function draw(): void {
		mounted.frame();
	}

	return {
		get current() {
			return state.current.get();
		},

		set current(next: number) {
			state.current.set(clamp(next));
			draw();
		},

		done(final?: string): void {
			if (final !== undefined) {
				state.label.set(final);
			}
			state.current.set(state.total.get());
			draw();
			mounted.done();
		},

		stop(): void {
			mounted.stop();
		},

		get text() {
			return state.label.get();
		},

		set text(next: string) {
			state.label.set(next);
			draw();
		},

		tick(delta = 1): void {
			this.current = state.current.get() + delta;
		},

		get total() {
			return state.total.get();
		},

		set total(next: number) {
			state.total.set(next > 0 ? next : 1);
			state.current.set(clamp(state.current.get()));
			draw();
		},

		write(line: string): void {
			mounted.write(line);
		},
	};
}
