import { box, type Element, text as textNode } from '../element/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { type Mounted, type MountOptions, mountLive } from './mount.js';

/**
 * The default frames, which are Braille dots: they animate smoothly, sit inside
 * one column, and are far more widely rendered than the block characters a
 * fancier spinner would use.
 */
export const DOTS: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Frames for a terminal that cannot be trusted with anything but ASCII. */
export const LINE: readonly string[] = ['-', '\\', '|', '/'];

/** How a spinner ends, and the mark it leaves. */
const OUTCOMES = {
	error: '✖',
	info: 'ℹ',
	success: '✔',
	warn: '⚠',
} as const;

/** One of the four ways a spinner settles. */
export type SpinnerOutcome = keyof typeof OUTCOMES;

export interface SpinnerOptions extends MountOptions {
	/** How long each frame lasts, in milliseconds. Defaults to 80. */
	interval?: number;
	/** What it is doing, shown after the spinner. */
	text?: string;
	/** The frames to cycle. Defaults to `DOTS`. */
	frames?: readonly string[];
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

/** What a spinner's tree is driven by, and what the facade writes to. */
export interface SpinnerState {
	/** How far through the frames, or `undefined` once it has settled. */
	readonly frame: State<number | undefined>;
	/** The mark it settled with, if it has. */
	readonly outcome: State<SpinnerOutcome | undefined>;
	/** What it is doing. */
	readonly label: State<string>;
}

/**
 * Builds the state a spinner's tree reads.
 *
 * @param label - What it is doing.
 * @returns The signals.
 */
export function spinnerState(label = ''): SpinnerState {
	return {
		frame: new State<number | undefined>(undefined),
		label: new State(label),
		outcome: new State<SpinnerOutcome | undefined>(undefined),
	};
}

/**
 * The spinner, as an element tree.
 *
 * One leading element rather than two, because what goes there is one thing at a
 * time: an animation frame while it runs and a mark once it has settled. Hidden
 * outright when there is neither -- a spinner in a CI log has no frames to show
 * and `display: none` is what keeps its margin from becoming a leading space in
 * a line somebody greps.
 *
 * @param state - What it reads.
 * @param frames - The frames to cycle.
 * @returns The tree.
 */
export function spinnerView(state: SpinnerState, frames: readonly string[] = DOTS): Element {
	const lead = textNode('', { 'margin-right': 1 });
	const label = textNode(state.label.get(), { class: 'sigil-spinner-text' });

	createEffect(() => {
		const outcome = state.outcome.get();
		const frame = state.frame.get();

		if (outcome) {
			lead.setText(OUTCOMES[outcome]);
			lead.setProps({ class: `sigil-symbol is-${outcome}`, display: 'flex' });
		} else if (frame === undefined) {
			lead.setText('');
			lead.setProps({ class: 'sigil-spinner-frame', display: 'none' });
		} else {
			lead.setText(frames[frame % frames.length]);
			lead.setProps({ class: 'sigil-spinner-frame', display: 'flex' });
		}
	});

	createEffect(() => {
		label.setText(state.label.get());
	});

	return box({ class: 'sigil-spinner' }, lead, label);
}

/**
 * A spinner, for work whose length is not known.
 *
 * Where there is no terminal there is nothing to animate, so no frame is drawn
 * and no timer is started -- and the canvas backend then writes a line per
 * change rather than one per tick. A CI log gets one line per thing the program
 * started doing, which is what it always got; what has changed is that it falls
 * out of the frame being the same either way rather than out of a second code
 * path.
 *
 * @param opts - What it says and how it looks.
 * @returns The spinner, not yet started.
 */
export function createSpinner(opts: SpinnerOptions = {}): Spinner {
	const frames = opts.frames?.length ? opts.frames : DOTS;
	const interval = opts.interval && opts.interval > 0 ? opts.interval : 80;
	const state = spinnerState(opts.text ?? '');
	const running = new State(false);
	const terminal = opts.terminal ?? defaultTerminal;

	/**
	 * What is on screen now, or nothing.
	 *
	 * Nothing is mounted until it is started, because a spinner that has not been
	 * started has nothing on screen -- which is what it has always meant and is
	 * the one thing a canvas would take away by itself: a renderer paints its
	 * first frame as it is built. And nothing is left mounted once it has settled
	 * or stopped, because a disposed renderer paints nothing ever again: keeping
	 * it made `start()` after `succeed()` a call that set `spinning` to true and
	 * changed the screen not at all.
	 */
	let mounted: Mounted | undefined;
	let spinning = false;

	function mount(): Mounted {
		mounted ??= mountLive(
			(live) => {
				createEffect(() => {
					// only while there is something to animate and something running: a
					// pipe has no frames to show, so a timer would wake the process
					// eighty times a second to render nothing
					if (!live || !running.get()) {
						return;
					}

					state.frame.set(0);
					const timer = setInterval(() => {
						state.frame.set((state.frame.get() ?? 0) + 1);
					}, interval);
					// the spinner is not a reason to stay alive -- a program that has
					// finished should exit even if somebody forgot to stop it
					timer.unref?.();
					onCleanup(() => clearInterval(timer));
				});

				return spinnerView(state, frames);
			},
			{ ...opts, terminal }
		);
		return mounted;
	}

	/**
	 * Stops and leaves one final line, which is the only thing a CI log keeps.
	 *
	 * @param outcome - How it ended.
	 * @param final - The text to leave. The current text, if omitted.
	 */
	function settle(outcome: SpinnerOutcome, final?: string): void {
		if (final !== undefined) {
			state.label.set(final);
		}
		spinning = false;
		running.set(false);
		state.frame.set(undefined);
		state.outcome.set(outcome);

		// mounted even if it never ran: a `succeed()` on a spinner nobody started
		// still leaves its line, which is what a region asked to `done(final)`
		// always did
		const it = mount();
		// painted before the screen is given back, because `done()` leaves what is
		// on screen where it is and what is on screen is still the frame before this
		it.frame();
		it.done();
		mounted = undefined;
	}

	const spinner: Spinner = {
		fail(final?: string): void {
			settle('error', final);
		},

		info(final?: string): void {
			settle('info', final);
		},

		start(next?: string): Spinner {
			if (next !== undefined) {
				state.label.set(next);
			}

			if (!spinning) {
				spinning = true;
				// whatever it settled as is cleared, so a spinner started again after
				// a `succeed()` shows its frames rather than the tick it ended on
				state.outcome.set(undefined);
				running.set(true);
				mount().frame();
			}

			return spinner;
		},

		get spinning() {
			return spinning;
		},

		stop(): void {
			spinning = false;
			running.set(false);
			mounted?.stop();
			mounted = undefined;
		},

		succeed(final?: string): void {
			settle('success', final);
		},

		get text() {
			return state.label.get();
		},

		set text(next: string) {
			state.label.set(next);
			if (spinning) {
				mounted?.frame();
			}
		},

		warn(final?: string): void {
			settle('warn', final);
		},

		write(line: string): void {
			if (mounted) {
				mounted.write(line);
				return;
			}
			// nothing has claimed the screen, so there is nothing to write above
			terminal.write(line.endsWith('\n') ? line : `${line}\n`);
		},
	};

	return spinner;
}
