import { DEFAULT_WIDTH, terminalWidth } from '../wrap/index.js';
import {
	DISABLE_PASTE,
	ENABLE_PASTE,
	ENTER_ALT_SCREEN,
	HIDE_CURSOR,
	LEAVE_ALT_SCREEN,
	PASTE_END,
	PASTE_START,
	SHOW_CURSOR,
} from './sequences.js';

export { createLiveRegion, frameHeight, type LiveRegion, type LiveRegionOptions } from './live.js';
export {
	CURSOR_HOME,
	CURSOR_TOP_LEFT,
	cursorDown,
	cursorRight,
	cursorUp,
	DISABLE_PASTE,
	ENABLE_PASTE,
	ENTER_ALT_SCREEN,
	ERASE_DOWN,
	ERASE_LINE,
	ERASE_LINE_END,
	HIDE_CURSOR,
	LEAVE_ALT_SCREEN,
	PASTE_END,
	PASTE_START,
	SHOW_CURSOR,
} from './sequences.js';

/** What a terminal is assumed to be tall when there is no terminal to ask. */
export const DEFAULT_HEIGHT: number = 24;

/** The signals a terminal restores itself on. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * The errors that mean the other end is gone and nothing more will be read.
 *
 * `EPIPE` is the reader closing the pipe -- `mycli --help | head -1` the instant
 * `head` has its line. `ERR_STREAM_DESTROYED` is the same thing arriving through
 * a stream that has already torn down. Neither is the app's fault and neither is
 * worth a stack trace.
 */
const GONE = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

/** Only what a terminal actually asks of an output stream. */
export interface OutputStream {
	columns?: number;
	isTTY?: boolean;
	rows?: number;
	on?(event: string, listener: (...args: unknown[]) => void): unknown;
	removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
	write(chunk: string): boolean;
}

/** Only what a terminal actually asks of an input stream. */
export interface InputStream {
	isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
}

/** Only what a terminal actually asks of the process. */
export interface ProcessLike {
	listenerCount?(event: string): number;
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	pid?: number;
	kill?(pid: number, signal: string): unknown;
	removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface TerminalOptions {
	/** The environment to read `COLUMNS` from. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Overrides TTY detection, which is otherwise the output stream's. */
	isTTY?: boolean;
	/** The process to install signal and exit handlers on. Defaults to `process`. */
	proc?: ProcessLike;
	/** Defaults to `process.stderr`. */
	stderr?: OutputStream;
	/** Defaults to `process.stdin`. */
	stdin?: InputStream;
	/** Defaults to `process.stdout`. */
	stdout?: OutputStream;
}

/** A hold on the one region of the screen that may be repainted in place. */
export interface LiveClaim {
	/** `false` once something else has claimed the region, or it was released. */
	readonly active: boolean;
	/** Gives the region up. Idempotent, and does not evict a later claim. */
	release(): void;
}

export interface Terminal {
	/**
	 * Takes the live region, evicting whoever held it.
	 *
	 * Only one thing may repaint the bottom of the screen: a spinner still
	 * ticking underneath a prompt writes over it on its next frame. The previous
	 * holder's `onEvict` runs first and is expected to clear what it drew, so the
	 * new holder starts on a clean line.
	 *
	 * @param onEvict - Called if something else claims the region.
	 * @returns The claim.
	 */
	claimLive(onEvict?: () => void): LiveClaim;
	/** Whether the far end has gone away, after which writes do nothing. */
	readonly closed: boolean;
	/**
	 * Switches to the alternate screen, and registers to switch back however the
	 * process ends.
	 *
	 * The switching back is the whole reason this lives here rather than in a
	 * backend writing the sequence itself: a CLI that dies on the alternate
	 * buffer and never comes back has eaten the user's terminal, and `restore()`
	 * is what already runs on a signal, on `exit`, and on the way out of an
	 * uncaught throw.
	 *
	 * @returns Whether this call is what switched, mirroring `hideCursor()`.
	 * `false` when something had already switched or there is no terminal to
	 * switch -- either way the caller owes no `leaveAltScreen()`.
	 */
	enterAltScreen(): boolean;
	/** Rows, from the stream, or 24 when there is nothing to ask. */
	readonly height: number;
	/**
	 * Hides the cursor, and registers to show it again however the process ends.
	 *
	 * @returns Whether this call is what hid it. `false` when something had
	 * already hidden it, or when there is no terminal to hide one on -- either
	 * way the caller owes no `showCursor()`, because showing it would put back a
	 * cursor somebody else is still hiding.
	 */
	hideCursor(): boolean;
	/** Whether this is a terminal, and so whether repainting means anything. */
	readonly isTTY: boolean;
	/** Returns to the main screen, if this terminal is what left it. */
	leaveAltScreen(): void;
	/**
	 * Asks the terminal to wrap a paste in markers, and registers to stop asking
	 * however the process ends.
	 *
	 * On the restore list for the same reason the alternate screen is: a CLI that
	 * dies with this left on hands the user a shell that puts `ESC [ 200 ~` into
	 * every paste, which is a terminal that has to be reset by hand.
	 *
	 * @returns Whether this call is what turned it on, mirroring `hideCursor()`.
	 */
	enableBracketedPaste(): boolean;
	/** Stops the markers, if this terminal is what asked for them. */
	disableBracketedPaste(): void;
	/**
	 * Subscribes to resizes.
	 *
	 * @param fn - Called with the new size.
	 * @returns Unsubscribes.
	 */
	onResize(fn: (size: { height: number; width: number }) => void): () => void;
	/** Puts back everything this terminal changed. Idempotent. */
	restore(): void;
	/** Enters or leaves raw mode, if the input stream is a TTY. */
	setRawMode(raw: boolean): void;
	/** Shows the cursor. */
	showCursor(): void;
	readonly stderr: OutputStream;
	readonly stdin: InputStream | undefined;
	readonly stdout: OutputStream;
	/**
	 * Columns, from `COLUMNS`, then the stream, then 80.
	 *
	 * Uncapped, unlike `terminalWidth()`, which stops at `MAX_WIDTH` because a
	 * line of prose is hard to read much past it. That cap is about generated
	 * text; this is the number the cursor math needs, and a progress bar told the
	 * screen is 100 columns when it is 200 erases the wrong amount.
	 */
	readonly width: number;
	/** Writes to stderr. Never throws; returns `false` once the far end is gone. */
	writeErr(chunk: string): boolean;
	/** Writes to stdout. Never throws; returns `false` once the far end is gone. */
	write(chunk: string): boolean;
}

/**
 * Builds a terminal over a set of streams.
 *
 * Nothing is installed on the process here. A CLI that only ever prints lines
 * should not acquire signal handlers by importing a module, so the `exit` and
 * signal listeners are attached the first time there is something to put back --
 * a hidden cursor, raw mode, a live claim -- and removed again once there is
 * not.
 *
 * @param opts - The streams to wrap and where to read the size from.
 * @returns The terminal.
 */
export function createTerminal(opts: TerminalOptions = {}): Terminal {
	const stdout = opts.stdout ?? process.stdout;
	const stderr = opts.stderr ?? process.stderr;
	const stdin = 'stdin' in opts ? opts.stdin : process.stdin;
	const proc = opts.proc ?? (process as unknown as ProcessLike);
	const env = opts.env ?? process.env;

	const isTTY = opts.isTTY ?? !!stdout.isTTY;

	let closed = false;
	let altScreen = false;
	let bracketedPaste = false;
	let cursorHidden = false;
	let rawMode = false;
	let claim: InternalClaim | undefined;

	// what has been attached to the process and to the streams, so that each is
	// attached once and removed when the last reason for it goes away
	let restoreAttached = false;
	const resizeListeners = new Set<(size: { height: number; width: number }) => void>();
	let resizeAttached = false;

	interface InternalClaim extends LiveClaim {
		evict(): void;
	}

	function width(): number {
		// `max: Infinity` because the cap `terminalWidth()` applies by default is a
		// readability limit on generated prose, and this is the width of the actual
		// screen -- erasing a wrapped line needs the real number
		return terminalWidth({ env, fallback: DEFAULT_WIDTH, max: Infinity, stream: stdout });
	}

	function height(): number {
		const rows = stdout.rows;
		return typeof rows === 'number' && rows > 0 ? Math.floor(rows) : DEFAULT_HEIGHT;
	}

	function writeTo(stream: OutputStream, chunk: string): boolean {
		if (closed || chunk === '') {
			return !closed;
		}

		try {
			stream.write(chunk);
			return true;
		} catch (err) {
			// a synchronous throw is the pipe being gone already. Anything else is a
			// real fault and is not this module's to swallow
			if (GONE.has((err as NodeJS.ErrnoException)?.code as string)) {
				closed = true;
				return false;
			}
			throw err;
		}
	}

	/**
	 * Swallows the far end going away.
	 *
	 * `EPIPE` usually arrives as an `error` event rather than a throw, and an
	 * `error` event with no listener is an uncaught exception -- which is how
	 * `mycli --help | head -1` kills a CLI that did nothing wrong. Attached on the
	 * first write rather than up front, since a stream nothing writes to cannot
	 * produce one.
	 */
	function guard(stream: OutputStream): void {
		stream.on?.('error', (...args: unknown[]) => {
			const err = args[0] as NodeJS.ErrnoException | undefined;
			if (GONE.has(err?.code as string)) {
				closed = true;
			}
		});
	}

	let guarded = false;
	function ensureGuarded(): void {
		if (!guarded) {
			guarded = true;
			guard(stdout);
			if (stderr !== stdout) {
				guard(stderr);
			}
		}
	}

	function onExit(): void {
		restore();
	}

	function onSignal(signal: string): void {
		restore();

		// a listener on a signal replaces the default action, so a CLI that hid its
		// cursor would stop dying on Ctrl-C -- which is a far worse bug than the
		// one this is fixing. Stand down and let the signal land the way it would
		// have: our own listeners are gone by now, so if nothing else is waiting on
		// it, re-raising gets the default
		detachRestore();
		if (proc.listenerCount?.(signal) === 0) {
			proc.kill?.(proc.pid as number, signal);
		}
	}

	const signalHandlers = new Map<string, () => void>();

	function attachRestore(): void {
		if (restoreAttached) {
			return;
		}
		restoreAttached = true;

		proc.on('exit', onExit);
		for (const signal of SIGNALS) {
			const handler = () => onSignal(signal);
			signalHandlers.set(signal, handler);
			proc.on(signal, handler);
		}
	}

	function detachRestore(): void {
		if (!restoreAttached) {
			return;
		}
		restoreAttached = false;

		proc.removeListener('exit', onExit);
		for (const [signal, handler] of signalHandlers) {
			proc.removeListener(signal, handler);
		}
		signalHandlers.clear();
	}

	/**
	 * Attaches or detaches the restore handlers to match whether there is
	 * anything to restore, so a terminal that has gone back to normal stops
	 * holding the process's signal handling.
	 */
	function syncRestore(): void {
		if (altScreen || bracketedPaste || cursorHidden || rawMode || claim?.active) {
			attachRestore();
		} else {
			detachRestore();
		}
	}

	function onStreamResize(): void {
		const size = { height: height(), width: width() };

		// a copy, so the set being iterated is the listeners as they were when the
		// resize happened: one of them unsubscribing another mid-notify would
		// otherwise decide by registration order whether that one still hears about
		// this resize
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const fn of [...resizeListeners]) {
			fn(size);
		}
	}

	function syncResize(): void {
		const want = resizeListeners.size > 0;
		if (want === resizeAttached) {
			return;
		}
		resizeAttached = want;

		// a TTY write stream emits `resize` itself, which is the same event
		// `SIGWINCH` would carry and is scoped to the stream rather than to the
		// process. Nothing to fall back to when the stream cannot be asked: a
		// stream that is not a terminal has no size to change
		if (want) {
			stdout.on?.('resize', onStreamResize);
		} else {
			stdout.removeListener?.('resize', onStreamResize);
		}
	}

	function restore(): void {
		if (claim?.active) {
			claim.evict();
		}

		if (rawMode) {
			rawMode = false;
			stdin?.setRawMode?.(false);
		}

		if (bracketedPaste) {
			bracketedPaste = false;
			writeTo(stdout, DISABLE_PASTE);
		}

		// the alternate screen goes back first, so that a cursor hidden while it was
		// up is shown again on the screen that is about to be looked at
		if (altScreen) {
			altScreen = false;
			writeTo(stdout, LEAVE_ALT_SCREEN);
		}

		if (cursorHidden) {
			cursorHidden = false;
			writeTo(stdout, SHOW_CURSOR);
		}

		detachRestore();
	}

	return {
		claimLive(onEvict?: () => void): LiveClaim {
			const previous = claim;
			previous?.evict();

			let active = true;
			const it: InternalClaim = {
				get active() {
					return active;
				},
				evict() {
					if (active) {
						active = false;
						onEvict?.();
					}
				},
				release() {
					if (active) {
						active = false;
						// only if still the holder: releasing a claim something else has
						// already taken would hand the region to nobody
						if (claim === it) {
							claim = undefined;
							syncRestore();
						}
					}
				},
			};

			claim = it;
			syncRestore();
			return it;
		},

		get closed() {
			return closed;
		},

		disableBracketedPaste(): void {
			if (bracketedPaste) {
				bracketedPaste = false;
				writeTo(stdout, DISABLE_PASTE);
				syncRestore();
			}
		},

		enableBracketedPaste(): boolean {
			if (bracketedPaste || !isTTY) {
				return false;
			}
			bracketedPaste = true;
			attachRestore();
			ensureGuarded();
			writeTo(stdout, ENABLE_PASTE);
			return true;
		},

		enterAltScreen(): boolean {
			if (altScreen || !isTTY) {
				return false;
			}
			altScreen = true;
			attachRestore();
			ensureGuarded();
			writeTo(stdout, ENTER_ALT_SCREEN);
			return true;
		},

		get height() {
			return height();
		},

		hideCursor(): boolean {
			if (cursorHidden || !isTTY) {
				return false;
			}
			cursorHidden = true;
			attachRestore();
			ensureGuarded();
			writeTo(stdout, HIDE_CURSOR);
			return true;
		},

		isTTY,

		leaveAltScreen(): void {
			if (altScreen) {
				altScreen = false;
				writeTo(stdout, LEAVE_ALT_SCREEN);
				syncRestore();
			}
		},

		onResize(fn: (size: { height: number; width: number }) => void): () => void {
			resizeListeners.add(fn);
			syncResize();

			return () => {
				resizeListeners.delete(fn);
				syncResize();
			};
		},

		restore,

		setRawMode(raw: boolean): void {
			if (raw === rawMode || !stdin?.isTTY || typeof stdin.setRawMode !== 'function') {
				return;
			}
			rawMode = raw;
			stdin.setRawMode(raw);
			syncRestore();
		},

		showCursor(): void {
			if (cursorHidden) {
				cursorHidden = false;
				writeTo(stdout, SHOW_CURSOR);
				syncRestore();
			}
		},

		stderr,
		stdin,
		stdout,

		get width() {
			return width();
		},

		write(chunk: string): boolean {
			ensureGuarded();
			return writeTo(stdout, chunk);
		},

		writeErr(chunk: string): boolean {
			ensureGuarded();
			return writeTo(stderr, chunk);
		},
	};
}

/**
 * The terminal bound to this process's streams.
 *
 * Built on import, which costs nothing: `createTerminal()` reads no size and
 * installs no handler until something asks it to.
 */
export const terminal: Terminal = createTerminal();

export default terminal;
