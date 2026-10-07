/**
 * A debug overlay: captured console output and frame stats, inside the app.
 *
 * Debugging a full-screen app means not being able to print anything. The
 * full-screen backend holds what is written to it and flushes on the way out,
 * which is right -- there is no "above the region" on a screen with no
 * scrollback, and a log line the app thought it had written is worse than one
 * that arrives late -- and *after the app exits* is not when you need to read
 * it. A `console.log` in an effect that fires thirty times a second is invisible
 * until the process ends and then arrives as a wall.
 *
 * ```js
 * import { captureConsole, createLogRing, enableDebugOverlay } from '@ttylabs/sigil/components';
 *
 * const log = createLogRing();
 * const capture = captureConsole(log);
 * const view = render(App, { backend, gatherStats: true });
 * const input = createInput({ root: view.root });
 * const overlay = enableDebugOverlay(view, {
 *   input,
 *   key: (key) => key.ctrl && key.name === 'g',
 *   log,
 * });
 * // on the way out
 * overlay.dispose();
 * capture.restore();
 * ```
 *
 * ## The three loops this is written around
 *
 * The overlay is part of the tree it reports on, so every obvious shape of it is
 * a loop or a lie. Each of the three is answered structurally rather than by a
 * comment, and each has a test named after it.
 *
 * **A console write marks nothing.** The ring is plain data with a version
 * counter and is deliberately **not** a signal: a signal write notifies its
 * watchers, which reaches the renderer's scheduler, which asks for a frame -- so
 * a `console.log` inside an effect would ask for the frame that runs the effect
 * that logs. The ring is therefore inert, and what reads it is the frame
 * callback below.
 *
 * **The pane reads on frames that were already happening.** `Renderer.onFrame()`
 * fires at the *top* of a frame, before the effects run, so what the pane writes
 * there is settled, laid out and painted by that same frame. The consequence is
 * the honest one and is worth knowing: in an app with nothing else going on, a
 * line logged after the last frame does not appear until something else asks for
 * one -- a keystroke, a resize, a signal write. There is no loop-free
 * alternative, because showing a line means changing the tree and changing the
 * tree means a frame.
 *
 * **The pane's own writes are not what asks for the next frame.** The rows
 * terminate by themselves, because a sync that finds the ring unmoved writes
 * nothing. The *stats* line does not: it holds the frame number and the frame's
 * duration, which differ every frame, so `setText()` would mark layout, ask for
 * a frame, and the frame after would differ again -- a thirty-a-second spin for
 * the life of the process, with every number in it measuring the instrument. So
 * the stats line skips exactly the frame its own last write asked for.
 *
 * ## Full screen only, and why the inline backend does not get this
 *
 * The inline backend has `write()`, which puts a line *above* the region and
 * re-anchors -- so an inline app can already print, and an overlay there would
 * be a second answer to a question that has one. This is written for the backend
 * where there is nowhere for a line to go. Nothing stops it being mounted over
 * an inline canvas and nothing about it would break; it simply is not what it is
 * for.
 */

import {
	box,
	type Element,
	type ElementProps,
	scrollIntoView,
	text as textElement,
} from '../element/index.js';
import type { InputRouter, KeyEvent } from '../input/index.js';
import type { FrameStats, Renderer } from '../renderer/index.js';
import type { Key } from './keys.js';
import { ScrollBox } from './scroll-box.js';
import { format } from 'node:util';

/**
 * Which console method produced a line.
 *
 * `trace` is deliberately not one of them: it prints a stack rather than a line,
 * and replacing it with a formatted line would throw the stack away -- which is
 * the whole of what anybody calls it for.
 */
export type LogLevel = 'debug' | 'error' | 'info' | 'log' | 'warn';

/** The console methods the capture replaces, in a fixed order. */
const LEVELS: readonly LogLevel[] = ['debug', 'error', 'info', 'log', 'warn'];

/**
 * The role each level draws in.
 *
 * A **role** rather than a colour, which is the framework sheet's own rule read
 * from the consumer's side: a line's level is de-emphasis, a warning or an error,
 * and those already have one site each in that vocabulary. The consequence is
 * that this component adds no colour declaration of its *own* to the sheet -- a
 * theme restyling `.sigil-error` restyles an error here along with everything
 * else. The one declaration it does add is the pane's **background**, which no
 * role is; the sheet says why where it sits.
 *
 * `log` draws in no role, because the ordinary case is the default foreground --
 * so an ordinary log line is **not** reachable by a role rule, which is the
 * honest half of this and is what `should draw every line in the role a theme
 * reaches it by` pins from both sides.
 * Keyed by the union so that a level added without a role is a type error rather
 * than a class no sheet defines, which is the rule `SEVERITY_ROLE` already keeps
 * in the toolchain.
 */
const LEVEL_ROLE: Record<LogLevel, string> = {
	debug: 'sigil-muted',
	error: 'sigil-error',
	info: 'sigil-info',
	log: '',
	warn: 'sigil-warn',
};

/** One captured line. */
export interface LogEntry {
	/** When it was pushed, from the ring's clock. */
	at: number;
	/** Which console method it came through. */
	level: LogLevel;
	/**
	 * A monotonic counter, so a reader can tell what it has already seen.
	 *
	 * Carried on the entry rather than derived from a position, because a `clear()`
	 * leaves the positions meaning something different while the sequence numbers
	 * go on meaning exactly what they did.
	 */
	seq: number;
	/** The formatted text. One line: a multi-line write becomes several entries. */
	text: string;
}

/**
 * A bounded buffer of captured lines.
 *
 * **A ring rather than the unbounded buffer the full-screen backend keeps**, and
 * the reasoning inverts between the two rather than being inconsistent. That one
 * is unbounded because a cap that silently drops the start of a log is its own
 * trap -- that log is for *keeping*, and it is flushed to the main screen where
 * its reader is. This is for *watching*: the last few hundred lines are the ones
 * anybody reads off a pane, and an unbounded one behind a live overlay is a leak
 * for the life of the process.
 *
 * **And it is not a signal**, which is the ticket's own first loop hazard
 * answered rather than worked around. A signal write notifies, and a
 * notification reaches the renderer's scheduler -- so pushing a line would ask
 * for a frame, from inside whatever effect did the logging. What reads it is
 * `Renderer.onFrame()`, which is a frame that was already happening.
 */
export interface LogRing {
	/** The entry at a position, oldest first, or `undefined` past the end. */
	at(index: number): LogEntry | undefined;
	/** How many lines it holds at most. */
	readonly capacity: number;
	/** Drops everything, which counts as a change. */
	clear(): void;
	/** How many lines have fallen off the front since it was built. */
	readonly dropped: number;
	/** Every line it holds, oldest first. A copy. */
	entries(): readonly LogEntry[];
	/**
	 * Pushes one write, split into a line per newline.
	 *
	 * Split because the pane draws one row per entry at a fixed height, so a write
	 * holding a newline would be one row with two lines in it -- which overflows
	 * its slot. A write that is only whitespace is still a line: a blank line in a
	 * log is something somebody printed.
	 *
	 * @param level - Which console method.
	 * @param text - The formatted text.
	 */
	push(level: LogLevel, text: string): void;
	/** How many lines it holds. */
	readonly size: number;
	/**
	 * How many times it has changed: a push of a line, or a `clear()`.
	 *
	 * What a reader compares to find out whether it has anything to do, which is
	 * why a `clear()` counts. Not "how many lines have ever been pushed" -- that
	 * is each entry's own `seq`, and a counter that answered both questions would
	 * answer one of them wrongly the first time anything was cleared.
	 */
	readonly version: number;
}

export interface LogRingOptions {
	/** How many lines to hold. Defaults to 500. A floor of one. */
	capacity?: number;
	/** Where `LogEntry.at` comes from. Defaults to `Date.now`. */
	now?: () => number;
}

/** How many lines a ring holds when nobody says. */
const CAPACITY = 500;

/**
 * Builds a ring.
 *
 * @param opts - The capacity and the clock.
 * @returns The ring.
 */
export function createLogRing(opts: LogRingOptions = {}): LogRing {
	// `Math.max(1, ...)` is not the whole guard, because `Math.max(1, NaN)` is
	// `NaN`: a ring of `NaN` slots holds `size < NaN`, which is false, so the
	// first push wraps into slot `NaN % NaN` and every line after it is lost
	// while `size` stays zero. The same trap `readInt()` and the typewriter's
	// interval already carry an entry for -- a comparison against `NaN` is false
	// in both directions, so the floor has to be asked about the value's shape
	const asked = opts.capacity;
	const capacity =
		typeof asked === 'number' && Number.isFinite(asked) ? Math.max(1, Math.floor(asked)) : CAPACITY;
	const clock = opts.now ?? Date.now;
	/**
	 * The slots, which only ever grow to `capacity`.
	 *
	 * Allocated as it fills rather than up front, so a ring of five hundred that
	 * nothing ever logs to costs one empty array.
	 */
	const slots: LogEntry[] = [];
	/** Where the oldest entry is, once the ring has wrapped. */
	let head = 0;
	let size = 0;
	let dropped = 0;
	let seq = 0;
	let version = 0;

	const ring: LogRing = {
		at(index: number): LogEntry | undefined {
			if (!Number.isInteger(index) || index < 0 || index >= size) {
				return undefined;
			}
			return slots[(head + index) % capacity];
		},

		capacity,

		clear(): void {
			slots.length = 0;
			head = 0;
			size = 0;
			version++;
		},

		get dropped() {
			return dropped;
		},

		entries(): readonly LogEntry[] {
			const found: LogEntry[] = [];
			for (let i = 0; i < size; i++) {
				const entry = slots[(head + i) % capacity];
				if (entry !== undefined) {
					found.push(entry);
				}
			}
			return found;
		},

		push(level: LogLevel, value: string): void {
			const at = clock();
			// split on either line ending, because what reaches here is whatever
			// somebody passed to `console.log` and a string read off a file on Windows
			// carries CRLF. A single trailing newline is the one a `console.log` would
			// have added itself and is not a blank line somebody wrote
			const lines = value.replace(/\r?\n$/, '').split(/\r?\n/);
			for (const line of lines) {
				const entry: LogEntry = { at, level, seq: seq++, text: line };
				if (size < capacity) {
					slots[(head + size) % capacity] = entry;
					size++;
				} else {
					// wrapped: the slot the oldest entry is in is the slot the newest goes
					// into, and the head moves on to what is now the oldest
					slots[head] = entry;
					head = (head + 1) % capacity;
					dropped++;
				}
				version++;
			}
		},

		get size() {
			return size;
		},

		get version() {
			return version;
		},
	};

	return ring;
}

/** What `captureConsole()` hands back. */
export interface ConsoleCapture {
	/**
	 * Whether **this** call was the one that replaced the console methods.
	 *
	 * `false` where a capture was already installed, which is the rule
	 * `hideCursor()`, `setRawMode()` and `enableBracketedPaste()` already keep:
	 * put back what *you* attached, and say whether there was anything to put
	 * back. A second capture is a no-op reporting `false` rather than an error,
	 * because two live overlays in one process is a thing that can happen and is
	 * not a failure -- the first one's ring is the one being filled.
	 */
	readonly installed: boolean;
	/**
	 * Puts back what this call replaced.
	 *
	 * Idempotent, and a no-op for a capture that did not install. A method whose
	 * current value is no longer the one this installed is **left alone**: that is
	 * somebody else's patch over ours, and "put back what you attached" taken
	 * literally means not removing a patch we did not attach.
	 *
	 * What that leaves behind is an orphan, and it is inherent rather than a hole:
	 * their patch is holding *ours* as its original, so when they restore, our
	 * patch is live with nobody left holding the real method -- and the other
	 * answer, writing our original over theirs, breaks their restore instead.
	 * Two parties patching one global without coordinating cannot both be put
	 * back, so what this does is say so rather than report a success it did not
	 * have. The latch is freed either way, because holding it would let one
	 * foreign patch refuse every later capture for the life of the process.
	 *
	 * @returns Whether the console is back. `false` for a capture that did not
	 *   install, for a call made once it already was, and for one that found a
	 *   method somebody else had patched over -- which stays **retryable**, so a
	 *   later call made after they restore puts that one back and answers `true`.
	 */
	restore(): boolean;
}

export interface CaptureOptions {
	/**
	 * The console to patch. Defaults to the global one.
	 *
	 * A parameter so that a test can exercise the patching without the suite's own
	 * reporter losing its console, which is the same seam `ReportStream` is in the
	 * toolchain. A capture installed on an object of its own is still exclusive of
	 * a capture installed on the global one, for the reason the latch records.
	 */
	console?: Partial<Record<LogLevel, (...args: unknown[]) => void>>;
}

/** What one installation replaced, so that it can be put back exactly. */
interface Installed {
	/** What was there before, per level. */
	originals: Partial<Record<LogLevel, (...args: unknown[]) => void>>;
	/** What was put there, so a patch over ours is not clobbered. */
	patched: Partial<Record<LogLevel, (...args: unknown[]) => void>>;
	/** The object patched, which is the global console unless a test said otherwise. */
	target: Partial<Record<LogLevel, (...args: unknown[]) => void>>;
}

/**
 * The live installation, if there is one.
 *
 * Module scope rather than per call, because the thing being guarded is a
 * **global**: two captures racing over `console.log` would each record the
 * other's patch as the original, and whichever restored second would put the
 * first one's patch back for ever. One latch is what makes `installed` a true
 * statement rather than a hopeful one.
 */
let active: Installed | undefined;

/** A capture that did not install, which is one object rather than one per call. */
const NOT_INSTALLED: ConsoleCapture = { installed: false, restore: () => false };

/**
 * Replaces the console methods with ones that push into a ring.
 *
 * Nothing is forwarded to the real console, and that is the feature rather than
 * an omission: forwarding into a full-screen backend's held buffer is exactly
 * the failure this exists for, and forwarding past it to the raw stream would
 * write into the alternate screen the renderer is diffing. The ring is the
 * destination. Anything that has to reach a file has `DEBUG` and `src/debug/`,
 * which is a different feature wearing the same hat.
 *
 * @param ring - Where the lines go.
 * @param opts - The console to patch.
 * @returns Whether this call installed, and how to put it back.
 */
export function captureConsole(ring: LogRing, opts: CaptureOptions = {}): ConsoleCapture {
	if (active !== undefined) {
		return NOT_INSTALLED;
	}

	const target = (opts.console ?? console) as Partial<
		Record<LogLevel, (...args: unknown[]) => void>
	>;
	const installed: Installed = { originals: {}, patched: {}, target };

	// recorded before anything is replaced, and unwound on the way out of a
	// throw: `format()` is Node's own and a property assignment on a frozen or
	// accessor-backed console can throw, so a half-installed capture is reachable
	// -- and half of a patched console with nothing holding the originals is worse
	// than none of one
	try {
		for (const level of LEVELS) {
			const original = target[level];
			const patch = (...args: unknown[]): void => {
				ring.push(level, format(...args));
			};
			installed.originals[level] = original;
			installed.patched[level] = patch;
			target[level] = patch;
		}
	} catch (error) {
		for (const level of LEVELS) {
			if (installed.patched[level] !== undefined && target[level] === installed.patched[level]) {
				restoreOne(installed, level);
			}
		}
		throw error;
	}

	active = installed;

	/**
	 * Which methods this call has managed to put back.
	 *
	 * Per level rather than one flag, because a restore that could not put a
	 * method back has to stay **retryable** for that one: somebody else's patch
	 * over ours is holding ours as its original, so the moment they restore, our
	 * patch is what is live and a second `restore()` can put the real method back.
	 * A single latch made that unreachable, and the sabotage pass is what said so
	 * -- removing it was *better* for that sequence, which is not something a fast
	 * path can be.
	 *
	 * A retry is safe because `restoreOne()` only ever writes where our own patch
	 * is still the one there: a capture installed in between holds the console, and
	 * a retry leaves it alone exactly as the first call left the foreign patch.
	 */
	const done = new Set<LogLevel>();
	return {
		installed: true,
		restore(): boolean {
			if (done.size === LEVELS.length) {
				return false;
			}
			// the latch goes on the first call whatever it managed, because holding it
			// would let one foreign patch refuse every later capture for the life of
			// the process
			if (active === installed) {
				active = undefined;
			}
			// no `done.has()` check in front of this, and the sabotage pass is why: a
			// level already put back is one whose patch is no longer ours, so
			// `restoreOne()` refuses it and the `add` is never reached -- the guard
			// could not change an answer, which is what this repo deletes rather than
			// comments
			for (const level of LEVELS) {
				if (restoreOne(installed, level)) {
					done.add(level);
				}
			}
			return done.size === LEVELS.length;
		},
	};
}

/**
 * Puts one method back, and only where ours is still the one there.
 *
 * @param installed - What this installation recorded.
 * @param level - Which method.
 * @returns Whether it put that one back.
 */
function restoreOne(installed: Installed, level: LogLevel): boolean {
	const { originals, patched, target } = installed;
	if (target[level] !== patched[level]) {
		// somebody patched over ours. Removing theirs is not "putting back what you
		// attached", and the original they are holding is ours -- so leaving it is
		// the only answer that does not break their restore
		return false;
	}
	const original = originals[level];
	if (original === undefined) {
		delete target[level];
	} else {
		target[level] = original;
	}
	return true;
}

export interface DebugOverlayOptions {
	/**
	 * Whether the pane follows the newest line. Defaults to `true`.
	 *
	 * `tail -f`, which is what a pane you toggled on to watch something wants: a
	 * line arriving while you are reading history pulls you back, and reading
	 * history is what pausing the app is for. It is `scrollIntoView()` on the last
	 * row rather than arithmetic of the pane's own, so the offset is computed by
	 * the one function that already knows where a row is -- and it runs on the
	 * frame **after** a row was appended, because a row the layout has not placed
	 * yet has no box to scroll to.
	 */
	follow?: boolean;
	/** How many cells tall the pane is. Defaults to 12. A floor of three. */
	height?: number;
	/** Where the key binding goes. Without one there is no key and `toggle()` is it. */
	input?: InputRouter;
	/**
	 * Which key toggles the pane, as a predicate over the decoded key.
	 *
	 * A function rather than a name, and that is a correction rather than a
	 * preference: the first version took a `Key.name` and its own documentation
	 * recommended `f12`, which is a name **this decoder never produces** -- the
	 * named sequences are the arrows, the paging keys and the editing keys, and
	 * everything else comes through as a key whose name is its own escape
	 * sequence. So a string would have been an option whose documented value
	 * silently matched nothing, found by driving the demo.
	 *
	 * A predicate also has no chord grammar to invent, which is the other half of
	 * it: a key name and a modifier set are two things, and a third spelling of a
	 * chord beside `Key`'s own fields would be a grammar with one caller. What an
	 * app writes is `(key) => key.ctrl && key.name === 'g'`.
	 *
	 * Note what a binding is: it sees **every** key before the focused element
	 * does, so a bare letter is a letter a text field can no longer type. A chord,
	 * or one of the keys nothing types, is what to reach for -- and the handle's
	 * `toggle()` is there for an app that wants a guard of its own, which is what
	 * `03-focus.js` does with its `q`.
	 */
	key?: (key: Key) => boolean;
	/** The ring the pane shows. Defaults to one of its own. */
	log?: LogRing;
	/**
	 * Whether to draw the stats line. Defaults to `true`.
	 *
	 * It says nothing useful unless the renderer was built with `gatherStats`,
	 * because `Renderer.stats` is `undefined` without it -- so the line reads
	 * `stats off` rather than being left blank, which is a question answered
	 * rather than a pane that looks broken.
	 */
	stats?: boolean;
	/** Whether it starts visible. Defaults to `false`. */
	visible?: boolean;
}

export interface DebugOverlayHandle {
	/**
	 * Takes the pane out of the tree, unbinds the key, and stops reading frames.
	 *
	 * Put back what you attached, in the order it was attached in reverse: the
	 * frame handler first, so that nothing reads a pane being dismantled, then the
	 * key, then the stats exclusion, then the element. Idempotent.
	 */
	dispose(): void;
	/** The pane. Already in the tree -- there is nothing for a caller to mount. */
	readonly element: Element;
	hide(): void;
	/** The ring it is showing, which is the one to pass to `captureConsole()`. */
	readonly log: LogRing;
	show(): void;
	toggle(): void;
	readonly visible: boolean;
}

/** How tall the pane is when nobody says, and the least it may be. */
const HEIGHT = 12;
const MIN_HEIGHT = 3;

/**
 * How high above everything else the pane is painted.
 *
 * Document order would already put it on top, since it is appended last -- this
 * is for the app that appends something after it. Paint order is `z-index` then
 * document order and a non-zero one keeps its subtree together, so one number on
 * the host is the whole of it.
 */
const Z_INDEX = 1000;

/**
 * Mounts a debug pane over a running renderer.
 *
 * The pane is **appended to the root**, which is sound rather than a liberty: it
 * is `position: fixed`, so it is taken out of flow, takes no space, and does not
 * size the parent it was added to -- `measureUncached()` filters out-of-flow
 * children out of what a box measures, so an auto-height canvas does not grow
 * for it either. The app's layout is what it was.
 *
 * Appended rather than built inside the component for the same reason
 * `enableSelection()` takes a mounted renderer: the stats, the exclusion and the
 * frame callback are all the renderer's, and the renderer does not exist while
 * the component body is running.
 *
 * @param view - The renderer. Pass `gatherStats: true` for the numbers.
 * @param opts - The ring, the key, the height.
 * @returns The handle.
 */
export function enableDebugOverlay(
	view: Renderer,
	opts: DebugOverlayOptions = {}
): DebugOverlayHandle {
	const log = opts.log ?? createLogRing();
	const follow = opts.follow !== false;
	const height = Math.max(MIN_HEIGHT, Math.floor(opts.height ?? HEIGHT));
	const showStats = opts.stats !== false;
	let visible = opts.visible === true;

	/** The rows, which the pane appends to and drops from the front of. */
	const list = box({
		class: 'sigil-debug-list',
		'flex-direction': 'column',
		'flex-shrink': 0,
	});

	const statsText = textElement('', {
		class: 'sigil-debug-stats sigil-muted',
		'text-overflow': 'ellipsis',
		'white-space': 'nowrap',
	});

	const head = box(
		{
			class: 'sigil-debug-head',
			'column-gap': 1,
			'flex-direction': 'row',
			'flex-shrink': 0,
		},
		textElement('debug', { class: 'sigil-debug-title sigil-heading', 'white-space': 'nowrap' }),
		statsText
	);

	/**
	 * The log, taking whatever the head left.
	 *
	 * `min-height: 0` is the one declaration here that is not obvious and is
	 * load bearing: a box's automatic minimum is content-based, and the content of
	 * a scroll box holding five hundred rows is five hundred rows tall -- so
	 * without it the host cannot shrink below its own content and the pane comes
	 * out forty rows tall inside a box drawn for six, with the rows painted over
	 * whatever is under it. It is what `flex-basis: 0` already says said once more
	 * for the axis the automatic minimum is about, and it is CSS's own idiom for a
	 * scrolling pane inside a flex column.
	 */
	const scroll = ScrollBox({
		children: () => list,
		props: {
			class: 'sigil-debug-log',
			'flex-basis': 0,
			'flex-grow': 1,
			'min-height': 0,
		},
	});

	/**
	 * The host.
	 *
	 * `bottom` with a declared height rather than `top` and `bottom` together,
	 * because the pane's height is the caller's and the engine's rule is "two
	 * insets, else a declaration": `left` and `right` say how wide it is, and
	 * `bottom` plus `height` say where the bottom edge sits. `display` is what
	 * hides it -- a hidden subtree is not laid out at all, where
	 * `visibility: hidden` would lay out every row to draw none of them.
	 *
	 * The **background is not here**, and it was for a commit. A prop beats a
	 * sheet per property, so `background-color: black` written in as a prop beats
	 * the light half of `.sigil-debug` and beats a theme rule on the same class --
	 * which is the rule this repo records as "no built-in carries a colour in its
	 * props", with the failure invisible on a dark terminal because the prop and
	 * the sheet agreed there. Everything left is geometry, which is what props are
	 * for.
	 */
	const element = box(
		{
			'border-style': 'single',
			bottom: 0,
			class: 'sigil-debug',
			display: visible ? 'flex' : 'none',
			'flex-direction': 'column',
			height,
			left: 0,
			position: 'fixed',
			right: 0,
			'z-index': Z_INDEX,
		} satisfies ElementProps,
		...(showStats ? [head] : []),
		scroll
	);

	/** One row per line, with the sequence number that put it there. */
	interface Row {
		element: Element;
		seq: number;
	}
	const rows: Row[] = [];

	/** What the ring's version was the last time the rows were rebuilt. */
	let seen = -1;

	/**
	 * Brings the rows into agreement with the ring, and says whether it had to.
	 *
	 * Incremental rather than rebuilt, which is `For`'s own reason: a row that is
	 * still in the ring is the same row, so keeping its element keeps its resolved
	 * style and its text measurement -- both of which are keyed on the style
	 * object and are worth nothing to a fresh element. A ring that wrapped once per
	 * frame would otherwise rebuild five hundred rows a frame to move one.
	 *
	 * @returns Whether anything moved, which is what the follow is gated on.
	 */
	function sync(): boolean {
		// a **declared fast path** rather than a claim, and the sabotage pass says
		// so: without it the two loops below run and find nothing to do, because
		// the drop loop's condition is false for every row and the append loop
		// skips every entry it has already shown -- so no answer changes and
		// nothing can be written that fails when it goes. What it buys is not
		// walking the whole ring on every frame of an app whose log is quiet,
		// which for five hundred rows is five hundred comparisons thirty times a
		// second to move nothing
		if (log.version === seen) {
			return false;
		}
		seen = log.version;

		// whatever fell off the front of the ring, which for a `clear()` is all of
		// it: `size` is zero, so there is no oldest entry and nothing survives
		const oldest = log.at(0)?.seq;
		while (rows.length > 0 && (oldest === undefined || rows[0].seq < oldest)) {
			const row = rows.shift();
			if (row !== undefined) {
				list.removeChild(row.element);
			}
		}

		// and whatever is newer than the last row shown. Compared by sequence rather
		// than by counting, so a `clear()` followed by a push cannot be mistaken for
		// the same lines arriving again
		const last = rows.length > 0 ? rows[rows.length - 1].seq : -1;
		for (let i = 0; i < log.size; i++) {
			const entry = log.at(i);
			if (entry === undefined || entry.seq <= last) {
				continue;
			}
			const row = entryRow(entry);
			rows.push({ element: row, seq: entry.seq });
			list.append(row);
		}

		return true;
	}

	/**
	 * What the stats line says, or why it says nothing.
	 *
	 * @param stats - The last frame's, if there is one.
	 * @returns The line.
	 */
	function statsLine(stats: FrameStats | undefined): string {
		if (stats === undefined) {
			return `${log.size} lines  stats off`;
		}
		const work = `${stats.laidOut ? 'L' : '-'}${stats.painted ? 'P' : '-'}`;
		return [
			`${log.size} lines`,
			`f${stats.frame}`,
			`${stats.duration}ms`,
			work,
			`${stats.changed}/${stats.elements} el`,
			`${stats.resolved} re`,
			`${stats.cells}c ${stats.bytes}b`,
			`${stats.styles}s/${stats.sweeps}w`,
		].join('  ');
	}

	/**
	 * Whether the frame about to run is the one this pane's own last write asked
	 * for.
	 *
	 * The third loop hazard, and the only one that does not terminate by itself.
	 * The stats line holds the frame number and the frame's duration, so it differs
	 * on every frame -- and `setText()` marks layout and asks for a frame, so
	 * writing it unconditionally is a thirty-a-second loop for the life of the
	 * process in which every number shown is a measurement of the instrument. The
	 * frame the write asked for is skipped, which is what makes it stop: that frame
	 * finds nothing to do and sets no other timer.
	 *
	 * What it costs is that a steadily animating app updates the line every other
	 * frame rather than every frame, which is the right trade -- the alternative is
	 * an app that cannot stop because something is watching it.
	 */
	let selfCaused = false;
	/** What the stats line last said, so an unchanged line marks nothing. */
	let shown = '';
	/** Whether a row was appended and not yet scrolled to. */
	let pendingFollow = false;
	/**
	 * Whether a frame has already been asked for on this pending follow's behalf.
	 *
	 * One, and it bounds the retry: a visible pane's next layout gives every row a
	 * box, so one frame is enough -- and a tree where it somehow never does leaves
	 * the pane unscrolled rather than asking for a frame per frame for ever.
	 */
	let followAsked = false;

	/** Sets the follow pending, which is where its one retry is armed. */
	function wantFollow(): void {
		pendingFollow = true;
		followAsked = false;
	}

	const offFrame = view.onFrame((stats) => {
		const mine = selfCaused;
		selfCaused = false;

		// the follow first, against the boxes the *previous* frame left, and gated
		// on the last row **having** one rather than on a frame having passed. A row
		// has no box until a layout has placed it -- a row appended by the sync
		// below, or any row appended while the pane was hidden, since a hidden
		// subtree is not laid out at all -- and `scrollIntoView()` returns without
		// doing anything for a target with no box, which is indistinguishable from
		// one that was already visible. So a frame-counting version consumed the
		// flag on exactly the frame it could not act, and opening a pane that had
		// filled up while it was closed showed the *oldest* lines. Asking about the
		// box is what makes the wait as long as it has to be.
		//
		// `scrollIntoView()` writes only where it moved something, so a pane already
		// at the bottom asks for nothing.
		if (pendingFollow && visible) {
			const last = rows.at(-1)?.element;
			if (last === undefined) {
				pendingFollow = false;
			} else if (last.box !== undefined) {
				pendingFollow = false;
				scrollIntoView(last);
			} else if (!followAsked) {
				// nothing else is going to ask: `show()` marked the tree, and the frame
				// that mark produced is this one, so the layout that gives the row a box
				// happens below and the next frame has to be asked for here
				followAsked = true;
				view.invalidate();
			}
		}

		if (sync() && follow) {
			wantFollow();
		}

		if (!showStats || mine) {
			return;
		}
		const line = statsLine(stats);
		if (line !== shown) {
			shown = line;
			statsText.setText(line);
			selfCaused = true;
		}
	});

	const unexclude = view.excludeFromStats(element);
	view.root.append(element);

	let offKey: (() => void) | undefined;
	let disposed = false;

	const handle: DebugOverlayHandle = {
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			offFrame();
			offKey?.();
			unexclude();
			element.parent?.removeChild(element);
		},

		element,

		hide(): void {
			if (!visible) {
				return;
			}
			visible = false;
			element.setProp('display', 'none');
		},

		log,

		show(): void {
			if (visible) {
				return;
			}
			visible = true;
			element.setProp('display', 'flex');
			// a hidden subtree is not laid out, so nothing in it has a box to scroll
			// to and whatever arrived while it was hidden was never followed
			if (follow) {
				wantFollow();
			}
		},

		toggle(): void {
			if (visible) {
				handle.hide();
			} else {
				handle.show();
			}
		},

		get visible() {
			return visible;
		},
	};

	// after the handle, because the binding calls it: a `const` read from a
	// closure declared above it is in its temporal dead zone for as long as
	// nothing has called the closure, and a key pressed in that window would be a
	// `ReferenceError` out of the router's dispatch
	if (opts.input !== undefined && opts.key !== undefined) {
		const wanted = opts.key;
		offKey = opts.input.bind((event: KeyEvent) => {
			// and nothing once the renderer has gone, which is `view.dispose()`
			// without `overlay.dispose()`. Toggling a pane nothing will paint is
			// harmless; **stopping the key** is not -- a binding sees every key first,
			// so a dead overlay would go on swallowing it on a router the app still
			// owns. The pairing is still the app's, which is the contract
			// `enableSelection()` already has
			if (!view.mounted || !wanted(event.key)) {
				return;
			}
			// stopped, because a binding sees every key first and the one that
			// toggles a debug pane is not also a key for the focused element
			event.stop();
			handle.toggle();
		});
	}

	return handle;
}

/**
 * One line, as an element.
 *
 * `nowrap` so that one entry is one row whatever width the pane came out as --
 * which is what makes the list's own arithmetic a count of entries rather than a
 * measurement -- with `text-overflow` cutting what does not fit, because a line
 * that ran off the edge would be a line the pane silently lost the end of.
 *
 * @param entry - The line.
 * @returns The element.
 */
function entryRow(entry: LogEntry): Element {
	const role = LEVEL_ROLE[entry.level];
	return textElement(entry.text, {
		class: role === '' ? 'sigil-debug-entry' : `sigil-debug-entry ${role}`,
		'flex-shrink': 0,
		'text-overflow': 'ellipsis',
		'white-space': 'nowrap',
	});
}
