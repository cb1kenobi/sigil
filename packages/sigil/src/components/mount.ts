/**
 * Mounting one of the built-in components, for the imperative API in front of
 * it.
 *
 * `createSpinner()` and `text()` are functions a build script calls, not trees an
 * app renders, and what they need from the renderer is the same four things
 * every time: a canvas at the bottom of the log, the framework's stylesheet, a
 * way to write a line above the frame, and two ways to finish -- one that leaves
 * the last frame in the log and one that erases it. This is those four things.
 *
 * **Whether there is a terminal is settled here and handed to the component**,
 * because it changes what the component draws rather than only how it is drawn.
 * A spinner in a CI log has no frames to animate, so it draws none and starts no
 * timer; the backend then writes the frame once per change rather than once per
 * tick, which is the live region's rule reached through the canvas instead of
 * through a second code path.
 */

import { ansi as defaultAnsi } from '../ansi/index.js';
import type { CanvasBackend } from '../canvas/index.js';
import type { Element } from '../element/index.js';
import { render, type Renderer } from '../renderer/index.js';
import type { ReducedMotion } from '../style/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';

export interface MountOptions extends StyledOptions {
	/** Where frames go. Defaults to an inline canvas that follows its content. */
	backend?: CanvasBackend;
	/**
	 * Milliseconds between frames. Defaults to the renderer's thirty a second.
	 *
	 * Worth naming for something that animates faster than that -- and worth
	 * naming in a test, where a frame arriving a tick late is the difference
	 * between asserting on what was drawn and asserting on when.
	 */
	frameMs?: number;
	/** Where a throw from the component or an effect goes. */
	onError?: (error: unknown) => void;
	/** The terminal to draw through. Defaults to the process's. */
	terminal?: Terminal;
}

export interface Mounted {
	/** Where frames are going. */
	readonly backend: CanvasBackend;
	/** Leaves the last frame where it was drawn and gives the screen back. */
	done(): void;
	/** Paints a frame now, whatever the pacing says. */
	frame(): void;
	/** Whether frames can be repainted at all. `false` for a pipe or a file. */
	readonly live: boolean;
	/** The renderer, for anything that wants the tree or the restyler. */
	readonly renderer: Renderer;
	/** Erases what was drawn and gives the screen back, leaving nothing behind. */
	stop(): void;
	/** Writes a line that stays, above the frame. */
	write(text: string): void;
}

/**
 * Mounts a built-in component over an inline canvas.
 *
 * @param build - Builds the tree. Handed whether there is a terminal to animate
 *   on, and whether anything should move, because both are questions about what
 *   to draw rather than about how it is drawn.
 * @param opts - The terminal, the theme, and the colour level.
 * @returns The handle.
 */
export function mountLive(
	build: (live: boolean, motion: ReducedMotion) => Element,
	opts: MountOptions = {}
): Mounted {
	const terminal = opts.terminal ?? defaultTerminal;
	const live = terminal.isTTY && !terminal.closed;
	/**
	 * Held, so that the build can read the motion the *renderer* resolved.
	 *
	 * `render()` sets `cascade.media` before it runs the component, and its own
	 * `motion()` is the only thing that folds the three sources together -- the
	 * caller's, `SIGIL_REDUCED_MOTION`, and whether there is a screen at all. A
	 * component asking those three for itself would be a second reader of one
	 * rule, which is how the two come to disagree about whether a pipe animates.
	 */
	const cascade = themedCascade(opts);

	const renderer = render(() => build(live, cascade.media.reducedMotion), {
		backend: opts.backend,
		cascade,
		colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
		// passed on as well as into the cascade, because `readMedia()` rebuilds the
		// whole media context and would otherwise drop it: `themedCascade()` sets the
		// scheme and the renderer then overwrites it on the first frame. Found by
		// reading the two together rather than by a failing test, which is why one
		// exists now
		colorScheme: opts.colorScheme,
		frameMs: opts.frameMs,
		// passed on for the same reason the scheme is, and the renderer adds the
		// terminal under it: a pipe collapses an animation to its end state without
		// anybody asking, which is what `live` has always meant for a spinner
		reducedMotion: opts.reducedMotion,
		onError: opts.onError,
		terminal,
		// as wide as what is drawn: these frames end up in a log, and a canvas the
		// width of the screen would leave every one of them padded out to the
		// margin with spaces nobody can see and everybody copies
		width: 'auto',
	});

	return {
		get backend() {
			return renderer.backend;
		},

		done(): void {
			renderer.dispose();
		},

		frame(): void {
			renderer.frame();
		},

		live,

		renderer,

		stop(): void {
			// the erase has to happen before the renderer lets go: finishing the
			// region is what hands the rows back, and afterwards there is no anchor
			// for an erase to be relative to. The renderer's own teardown records the
			// same ordering from the other side
			renderer.backend.stop();
			renderer.dispose();
		},

		write(text: string): void {
			renderer.backend.write(text);
		},
	};
}
