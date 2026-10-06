/**
 * One thing owns stdin, and components subscribe.
 *
 * Today each prompt sets raw mode, attaches its own `data` listener, decodes,
 * and puts everything back -- which works exactly as long as there is one
 * prompt. Two at once fight over the stream, and neither can see what the other
 * consumed. A canvas has one router instead: it reads, it decodes, and it
 * dispatches through the element tree.
 *
 * ```js
 * import { createInput } from '@ttylabs/sigil/input';
 *
 * const input = createInput({ root });
 * input.bind((event) => {
 *   if (event.key.ctrl && event.key.name === 'c') stop();
 * });
 * ```
 *
 * A handler registered while an event is being dispatched does not receive that
 * event, and one removed during it is not called. Every handler set here is
 * therefore walked over a copy *and* asked whether each entry is still in the
 * live set, because the two halves want opposite things and a bare `for..of`
 * over the `Set` gives only one of them. Without the copy, a component that
 * binds a key in response to being focused has that new binding see the very key
 * that focused it, and whether it does depends on where in the iteration it
 * joined. Without the membership check, the copy re-runs a handler that has just
 * unsubscribed -- which is a one-shot binding firing twice, and a dialog torn
 * down by Escape still handing Escape to the handlers it was tearing down.
 * Order-dependent and unexplainable is worse than one rule said once.
 *
 * The mouse is here too, and it arrives on the same stream for the same reason:
 * a report is interleaved with what the user is typing, so a private `data`
 * listener for it is the exact failure this module exists to replace. It is
 * **opt-in**, and what turning it on takes away is worth knowing before you do:
 * a terminal reporting the mouse stops doing its own text selection, so from the
 * user's point of view an app that enables tracking has broken copy and paste.
 * Shift-drag overrides it in most terminals and not all.
 *
 * The Kitty keyboard protocol is the remaining answer of this shape, opt-in by
 * query, and worth having the day something needs a key the legacy encoding
 * cannot spell.
 */

import {
	type DecodeOptions,
	decodeKeys,
	type Key,
	pendingIsString,
	pendingLength,
} from '../components/keys.js';
// `element/hit.js` rather than the element barrel, which is the same precision
// the renderer takes over this module: `Element` is a type and erases, while these
// two are real code and this is the one file that needs them
import { ancestry, hitTest } from '../element/hit.js';
import type { Element } from '../element/index.js';
// `scroll.js` imports nothing but types, for the same reason `hit.js` does: the
// focus ring needs one function out of the element tree and reaching it through
// the barrel would put the layout engine and the cascade behind this module
import { scrollIntoView } from '../element/scroll.js';
import { State } from '../signals/index.js';
import {
	PASTE_END,
	PASTE_START,
	type Terminal,
	terminal as defaultTerminal,
} from '../terminal/index.js';
import {
	type CapabilityReply,
	isCapabilityResponse,
	parseCapabilityResponse,
	QUERY_TIMEOUT,
	type QueryOptions,
	queryCursor,
} from './capabilities.js';
import {
	type MouseButton,
	type MouseEventKind,
	type MouseReport,
	parseMouseReport,
	type WheelDirection,
} from './mouse.js';
// `sequence.js` imports nothing but the decoder's own name table, for the reason
// `hit.js` and `scroll.js` are imported directly: a grammar and a trie are real
// code, and reaching them through a barrel would put something else behind them
import {
	addBinding,
	createTrie,
	formatKey,
	type KeyPattern,
	KeySpecError,
	parseKeys,
	type SequenceHandler,
	type SequenceNode,
} from './sequence.js';

export { isAbort, type Key, KEY_NAMES } from '../components/keys.js';
export {
	addBinding,
	createTrie,
	formatKey,
	formatKeys,
	type KeyPattern,
	KeySpecError,
	parseKeys,
	type SequenceHandler,
	type SequenceNode,
} from './sequence.js';
export {
	type MouseButton,
	type MouseEventKind,
	type MouseReport,
	type MouseReportKind,
	parseMouseReport,
	type WheelDirection,
} from './mouse.js';
export {
	BACKGROUND_COLOR,
	type Capabilities,
	type CapabilityKind,
	type CapabilityReply,
	CELL_PIXELS,
	CURSOR_POSITION,
	DA1,
	DA2,
	detectCapabilities,
	type DetectOptions,
	FOREGROUND_COLOR,
	isCapabilityResponse,
	type ModeState,
	parseCapabilityResponse,
	parseReportedColor,
	QUERY_TIMEOUT,
	type QueryOptions,
	queryCursor,
	type ReportedColor,
	queryMode,
	readCapabilities,
	refineColorLevel,
	requestMode,
	TEXT_AREA_PIXELS,
	XTVERSION,
} from './capabilities.js';

/**
 * How long a partial sequence waits for the rest of itself.
 *
 * The same number, for the same reason, as the one the prompt already uses: a
 * lone Escape is a key rather than a wait with no end, because nothing follows
 * it and so nothing can complete it. Fifty milliseconds because the two failures
 * are not symmetric -- too short types a stray character into somebody's answer,
 * too long makes Escape feel late.
 */
export const ESCAPE_TIMEOUT: number = 50;

/**
 * How long a key that is both a binding and a prefix waits to find out which.
 *
 * The same shape as `ESCAPE_TIMEOUT` and **ten times the number**, because the
 * asymmetry points the other way. That one waits for *bytes from a terminal*,
 * which arrive in microseconds unless the link is slow, and its failures are
 * "too short types a stray character into somebody's answer, too long makes
 * Escape feel late". This waits for *a human finger*, which is two orders of
 * magnitude slower, and its failures are: too short and a deliberate `g g` fires
 * `g` twice -- the silent wrong action, which is the half that one is written to
 * protect against -- while too long makes a bound `g` feel broken, which is the
 * annoyance half. Fifty milliseconds would fire `g` twice for essentially
 * everybody, so the trade is taken in the direction that does not act wrongly.
 *
 * Five hundred rather than a number fitted to anything: vim's `timeoutlen` is
 * documented at 1000ms and Emacs waits indefinitely, so those are the two poles,
 * and this sits between them. It only ever arises where an app bound **both** a
 * key and a sequence starting with it, which is the app choosing the ambiguity
 * -- so `InputOptions.sequenceTimeout` is how an app that knows its own bindings
 * picks. A node that is a prefix and *not* a binding waits with no deadline at
 * all, which is Emacs' answer and the right one: there is nothing to disambiguate
 * and any key that does not continue the sequence already cancels it.
 */
export const SEQUENCE_TIMEOUT: number = 500;

/**
 * The longest delay `setTimeout` will hold.
 *
 * Node stores one as a signed 32-bit integer, so anything past this becomes
 * `1` -- which is the trap `Infinity` is already refused for, reached by a
 * finite number instead. A value past it is clamped rather than thrown away: a
 * caller who wrote one meant "as long as possible", and the longest delay there
 * is the nearest answer, where falling back to the default would be *shorter*
 * than what they asked for.
 */
const MAX_DELAY = 2_147_483_647;

/** Raised when there is nobody to read keys from. */
export class InputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InputError';
	}
}

/**
 * A key on its way through the tree.
 *
 * Stoppable, because without that a text input's Left is also the list's
 * "previous item": the event reaches the focused element first and every
 * ancestor after it, and the only thing that can know the key was meant for the
 * input is the input.
 */
export interface KeyEvent {
	/** The element currently being asked, which changes as the event bubbles. */
	readonly current: Element | undefined;
	readonly key: Key;
	/** Whether this is content that was pasted rather than typed. */
	readonly paste: boolean;
	/** Stops the event reaching anything further. */
	stop(): void;
	readonly stopped: boolean;
	/** The element the event was dispatched to, which does not change. */
	readonly target: Element | undefined;
}

export type KeyHandler = (event: KeyEvent) => void;

/** Text that arrived as one paste rather than as a burst of keystrokes. */
export interface PasteEvent {
	stop(): void;
	readonly stopped: boolean;
	readonly text: string;
}

export type PasteHandler = (event: PasteEvent) => void;

/**
 * A mouse event on its way through the tree.
 *
 * Stoppable and bubbling, exactly like a key -- but with **no bindings-first
 * step**. That ordering exists so a focused input cannot swallow Ctrl-C, and
 * there is no mouse analogue of being unable to quit: the router's own handlers
 * see what the tree did not claim rather than what it has not seen yet.
 *
 * `x` and `y` are the canvas's own cells, zero-based. They may be **outside** the
 * canvas while a button is held, because a press captures the pointer: a drag
 * that wanders off the region still reports to whatever the press landed on,
 * which is the only way a component can find out that the drag ended.
 */
export interface MouseEvent {
	/**
	 * Which button, where there is one.
	 *
	 * `undefined` for a wheel and for motion with nothing held.
	 */
	readonly button: MouseButton | undefined;
	readonly ctrl: boolean;
	/**
	 * The element currently being asked, which changes as the event bubbles.
	 *
	 * `undefined` once the event has left the tree and is reaching the router's own
	 * handlers, because at that point it is not at an element at all.
	 */
	readonly current: Element | undefined;
	readonly kind: MouseEventKind;
	/** Alt, which xterm calls meta and reports in the same bit. */
	readonly meta: boolean;
	readonly shift: boolean;
	/** Stops the event reaching anything further. */
	stop(): void;
	readonly stopped: boolean;
	/**
	 * The element the event was dispatched to, which does not change.
	 *
	 * `undefined` for a report that landed on no element -- inside the canvas but
	 * outside every box, or the pointer leaving the canvas altogether. Such an
	 * event reaches the router's handlers and nothing else, which is the one thing
	 * only a router-level handler can see.
	 */
	readonly target: Element | undefined;
	/** Which way the wheel turned, for a `wheel` event and nothing else. */
	readonly wheel: WheelDirection | undefined;
	/** The column, zero-based, in the canvas's own cells. */
	readonly x: number;
	/** The row, zero-based, in the canvas's own cells. */
	readonly y: number;
}

export type MouseHandler = (event: MouseEvent) => void;

/**
 * What the router asks of a canvas: where it sits, and how big it is.
 *
 * A structural interface rather than an import of `CanvasBackend`, which is the
 * shape `InputStream` and `OutputStream` already take here: the router needs four
 * things from a canvas and naming them is cheaper than depending on one. Every
 * backend satisfies it.
 */
export interface MouseSurface {
	readonly height: number;
	/**
	 * Learns where the canvas sits on screen, given a way to ask the terminal.
	 *
	 * @param probe - Asks for the cursor position.
	 * @returns Whether the origin is now known.
	 */
	locate(probe: () => Promise<{ column: number; row: number } | undefined>): Promise<boolean>;
	readonly origin: { x: number; y: number } | undefined;
	/**
	 * Translates a one-based screen coordinate into a zero-based canvas one.
	 *
	 * @returns `undefined` while the origin is unknown.
	 */
	toCanvas(column: number, row: number): { x: number; y: number } | undefined;
	readonly width: number;
}

export interface MouseOptions {
	/**
	 * Whether to report the pointer with nothing held, which is what `:hover`
	 * needs.
	 *
	 * Off by default, and that is the whole of the trade: on is xterm's `1003`,
	 * which reports **every cell the pointer crosses**, for as long as the app runs,
	 * over what may be an ssh link. Off is `1002`, which reports presses, releases
	 * and motion only while a button is held -- so the pointer's position between
	 * clicks is not a thing the app knows.
	 *
	 * `:hover`, `mouseenter` and `mouseleave` are therefore tracked **only** when
	 * this is on. Writing them from a press instead would be worse than not writing
	 * them: with no motion to clear it, a hover set by a click sticks to whatever
	 * was clicked until something else is. Which means with this off, `:hover`
	 * matches nothing -- exactly the behaviour it had before there was a mouse at
	 * all, so no sheet changes meaning by turning tracking on.
	 *
	 * The alternative considered was turning `1003` on by itself whenever some rule
	 * in some sheet uses `:hover`. It is refused: a sheet is one of two consumers
	 * -- a `mousemove` handler wants motion just as much and no scan can see one --
	 * and sheets are swapped at runtime, so the wire cost would come and go
	 * underneath the app with nobody having asked for it.
	 */
	motion?: boolean;
	/**
	 * The canvas a report's screen coordinates are translated against.
	 *
	 * Required, and inside the option rather than beside it, because a report is in
	 * screen coordinates and a canvas does not know where it sits -- so mouse
	 * tracking without something to translate against is a mouse that silently
	 * does nothing. Pass the renderer's `backend`.
	 */
	surface: MouseSurface;
}

export interface FocusRing {
	/**
	 * The focused element, as a signal.
	 *
	 * A signal rather than a getter because this is what everything else reacts
	 * to: an effect repaints, and the `:focus` state it sets is what makes an
	 * input that highlights when focused zero lines of component code.
	 */
	readonly current: State<Element | undefined>;
	/** Focuses an element, or nothing. */
	focus(element: Element | undefined): void;
	/** Moves to the next focusable element, wrapping. */
	next(): void;
	/** Moves to the previous focusable element, wrapping. */
	previous(): void;
	/** Every focusable element, in the order Tab visits them. */
	ring(): readonly Element[];
}

/**
 * Sequences bound under one leading key, and the way to take them all off.
 *
 * The one sequence shape everybody wants, and what the helper buys over writing
 * `` input.bind(`${leader} f`, …) `` is that the leader is declared once: an app
 * that moves it from Space to Comma edits one line rather than every binding,
 * and the spec is checked as a single key where it is named rather than as the
 * first token of each sequence.
 */
export interface LeaderBindings {
	/**
	 * Binds a sequence under the leader.
	 *
	 * @param keys - What follows it, as a spec.
	 * @param handler - What to run.
	 * @returns Removes that one binding.
	 */
	bind(keys: string, handler: SequenceHandler): () => void;
	/**
	 * Removes every binding made through this.
	 *
	 * "Put back what you attached" -- the rule the `EPIPE` guard and every entry
	 * on the restore list already follow, which is worth having here because the
	 * point of a leader is that one object holds many bindings.
	 */
	dispose(): void;
	/** The leader, canonically spelled, which is what a status line prints. */
	readonly key: string;
}

export interface InputRouter {
	/**
	 * Adds an app-level binding, which sees every key before anything focused.
	 *
	 * A **function** binding sees every key, full stop: before the sequence trie,
	 * before the focused element, before the Tab default, and before any pending
	 * sequence has a chance to claim it. That is where Ctrl-C belongs and it is
	 * why there are two spellings of this method rather than one -- an app that
	 * cannot be quit is the failure this ordering exists to prevent, and a
	 * half-entered sequence is a second route to it.
	 *
	 * @param handler - What to do with it.
	 * @returns Removes the binding.
	 */
	bind(handler: KeyHandler): () => void;
	/**
	 * Adds a key-sequence binding.
	 *
	 * `'ctrl+s'` is one key, `'g g'` and `'ctrl+x ctrl+s'` are two; keys are
	 * separated by whitespace and modifiers by `+`. The spec is parsed here, so a
	 * spelling that cannot be a key throws rather than becoming a binding that
	 * never fires.
	 *
	 * A sequence is consulted **after** every function binding and before the
	 * focused element. While one is part way through, the next key is claimed only
	 * where the app bound a continuation on it -- anything else cancels the
	 * pending sequence and is dispatched from the top, so nothing is swallowed
	 * that the app did not itself name as a continuation.
	 *
	 * @param keys - The sequence, as a spec.
	 * @param handler - What to run once all of it has been pressed.
	 * @returns Removes the binding.
	 */
	bind(keys: string, handler: SequenceHandler): () => void;
	readonly focus: FocusRing;
	/** Feeds bytes as though the terminal had sent them. */
	feed(chunk: string): void;
	/**
	 * The innermost element under the pointer, if anything is.
	 *
	 * Always `undefined` without `mouse.motion`, for the reason that option gives:
	 * with nothing reporting where the pointer is between clicks, there is no such
	 * thing as "under the pointer". Not a signal, because what reacts to it is the
	 * `hover` state this writes, and setting a state already marks the tree and
	 * asks for a frame.
	 */
	readonly hovered: Element | undefined;
	/**
	 * Declares a leader key, under which sequences are bound.
	 *
	 * @param key - One key, as a spec.
	 * @returns The binder, and the way to take all of it off.
	 */
	leader(key: string): LeaderBindings;
	/**
	 * Adds a paste handler, which sees pasted text before it is typed in.
	 *
	 * @param handler - What to do with it.
	 * @returns Removes the handler.
	 */
	onPaste(handler: PasteHandler): () => void;
	/**
	 * Adds a handler for a mouse event the tree did not claim.
	 *
	 * **After** the tree rather than before it, which is the opposite of `bind()`
	 * and is the whole of what the mouse does differently. A binding goes first
	 * because an app that cannot be quit is the failure that ordering prevents, and
	 * nothing about the mouse has that shape -- so what is left is the useful
	 * position: everything the tree did not stop, *including* the reports that
	 * landed on no element at all, which nothing in the tree can see.
	 *
	 * It sees every kind, `mouseenter` and `mouseleave` included, and stopping one
	 * of those stops the rest of that enter or leave sequence. Stopping a
	 * `mousedown` suppresses click-to-focus, which is the mouse's default action the
	 * way Tab is a key's.
	 *
	 * @param handler - What to do with it.
	 * @returns Removes the handler.
	 */
	onMouse(handler: MouseHandler): () => void;
	/**
	 * Adds a resize handler.
	 *
	 * `Terminal.onResize()` already existed; what is new is what it means, and
	 * that is deliberately not decided here. A resize re-evaluates the width and
	 * height media queries, re-lays out, and repaints the whole canvas rather than
	 * diffing against a grid that described a different screen -- and every one of
	 * those is the renderer's to do. This is here so that the thing which owns
	 * stdin also owns the other event a terminal produces, rather than an app
	 * subscribing to two places for the two halves of one frame.
	 *
	 * @param handler - Called with the new size.
	 * @returns Removes the handler.
	 */
	onResize(handler: (size: { height: number; width: number }) => void): () => void;
	/**
	 * Adds a handler for the input going away.
	 *
	 * The stream ending, or erroring, means no key will ever arrive again -- and
	 * something waiting on one has to be told, or it waits forever. That is a
	 * question about stdin, and the router is what owns stdin: a prompt keeping a
	 * listener of its own for it would be the private stdin handling this exists
	 * to replace, kept alive for one event.
	 *
	 * @param handler - Called with the error, if it was one.
	 * @returns Removes the handler.
	 */
	onEnd(handler: (error?: unknown) => void): () => void;
	/**
	 * Writes a query to the terminal and collects what comes back.
	 *
	 * Here because one thing owns stdin, and a reply arrives on stdin interleaved
	 * with whatever the user is typing -- a private listener for it would be the
	 * exact failure this module exists to replace. What the router adds on top of
	 * the write is the three things only it can: a reply is taken out of the key
	 * stream before it reaches anything focused, a reply nobody is waiting for is
	 * dropped rather than dispatched, and the decoder is told that an OSC or DCS
	 * introducer is an answer rather than Alt-] for as long as a query is open.
	 *
	 * A terminal that answered nothing resolves with nothing rather than rejecting:
	 * that is an answer, and a probe that threw over it would take a frame down for
	 * a terminal that did nothing wrong. The far end being gone resolves the same
	 * way. What does reject is a write that fails outright, which is a broken stream
	 * rather than a quiet terminal -- and it leaves nothing armed, because the
	 * question is asked before anything is registered.
	 *
	 * @param opts - The bytes, the deadline, and what ends the wait early.
	 * @returns Every reply that arrived, in order.
	 */
	query(opts: QueryOptions): Promise<CapabilityReply[]>;
	/**
	 * The keys of a sequence part way through being entered.
	 *
	 * Empty whenever nothing is pending. A signal rather than a getter because an
	 * app wants to *show* it -- the `g` sitting in the corner of the status line is
	 * how a vim-like UI stays usable -- and nothing else here would ask for the
	 * frame that renders it: `hovered` is a plain getter precisely because the
	 * `hover` state it writes already marks the tree, and a pending sequence writes
	 * no element state at all.
	 *
	 * `formatKeys()` is what turns it into the string to print, which is the same
	 * function a spec parses through, so the two cannot disagree about what a key
	 * is called. Clearing an already-empty sequence writes nothing, because the
	 * empty value is one shared frozen array and `State.set()` compares with
	 * `Object.is` -- a key that cancels nothing does not ask for a frame.
	 */
	readonly sequence: State<readonly Key[]>;
	/** Gives stdin back and puts raw mode and the paste markers back. */
	stop(): void;
}

export interface InputOptions {
	/**
	 * Whether to track the mouse, and what to translate a report against.
	 *
	 * Off by default, and it is worth being deliberate about turning it on: a
	 * terminal reporting the mouse stops doing its own text selection, so an app
	 * that asks for this has, from the user's point of view, broken copy and paste.
	 * Shift-drag overrides it in most terminals and not all.
	 */
	mouse?: MouseOptions;
	/**
	 * Whether a paste arrives whole.
	 *
	 * On by default. Off means a pasted block arrives as though it had been
	 * typed, which is what a terminal that does not support the markers does
	 * anyway -- so this is about whether to ask, not about what to trust.
	 */
	paste?: boolean;
	/** The tree keys are dispatched through, and the focus ring is built from. */
	root?: Element;
	/**
	 * How long a key that is both a binding and a prefix waits, in milliseconds.
	 *
	 * Defaults to `SEQUENCE_TIMEOUT`, whose entry has the trade. A value that is
	 * not a finite number at or above zero falls back to it rather than being
	 * honoured, which is the rule the typewriter's own interval keeps and for its
	 * reason: `Infinity >= 0` is true and node reads a delay past 2^31-1 as 1, so
	 * an unchecked `Infinity` asks for "never" and gets "at once".
	 */
	sequenceTimeout?: number;
	/** Where keys come from. Defaults to the terminal's own input. */
	stdin?: InputStream;
	terminal?: Terminal;
}

/** A readable stream, as narrow as this module needs it. */
export interface InputStream {
	isTTY?: boolean;
	off?: (event: string, fn: (...args: unknown[]) => void) => unknown;
	on?: (event: string, fn: (...args: unknown[]) => void) => unknown;
	pause?: () => unknown;
	removeListener?: (event: string, fn: (...args: unknown[]) => void) => unknown;
	resume?: () => unknown;
	setEncoding?: (encoding: string) => unknown;
}

/** Every element a Tab would stop on, in the order it visits them. */
function focusables(root: Element | undefined): Element[] {
	if (!root) {
		return [];
	}

	const found: Element[] = [];
	const walk = (element: Element): void => {
		if (element.style.display === 'none') {
			// a subtree that is not laid out is not one a Tab can reach: there is
			// nothing on screen to move the focus to
			return;
		}
		if (element.focusable) {
			found.push(element);
		}
		for (const child of element.children) {
			walk(child);
		}
	};
	walk(root);

	// document order, and then whatever asked for a place of its own. Sorted
	// stably so that everything sharing a `tabindex` -- which is everything that
	// did not name one -- keeps the order it was written in
	return found.every((element) => element.tabIndex === undefined)
		? found
		: [...found].sort((a, b) => (a.tabIndex ?? 0) - (b.tabIndex ?? 0));
}

/** Whether an element is still hanging off the root. */
function attached(element: Element, root: Element | undefined): boolean {
	for (let at: Element | undefined = element; at; at = at.parent) {
		if (at === root) {
			return true;
		}
	}
	return false;
}

/**
 * Builds the input router.
 *
 * Throws where stdin is not a terminal rather than carrying a router that can
 * never read a key. That is `PromptError`'s rule generalized: a prompt with
 * nobody to answer it fails loudly rather than hanging, and a router exists to
 * read keys, so one that cannot is a bug in the app rather than a state to
 * carry. An app that runs without input does not build one.
 *
 * @param opts - The tree, the terminal, and whether to ask for bracketed paste.
 * @returns The router.
 */
export function createInput(opts: InputOptions = {}): InputRouter {
	const terminal = opts.terminal ?? defaultTerminal;
	const stdin = opts.stdin ?? (terminal.stdin as InputStream | undefined);

	if (!terminal.isTTY || !stdin?.isTTY) {
		throw new InputError(
			'Cannot read keys because the input is not a terminal: build a router only where there is somebody to type'
		);
	}

	const root = opts.root;
	const bindings = new Set<KeyHandler>();
	const pasters = new Set<PasteHandler>();
	const current = new State<Element | undefined>(undefined);

	/** Where the focused element sat in the ring, for when it is unmounted. */
	let lastIndex = 0;

	// -- key sequences --------------------------------------------------------

	const trie = createTrie();

	/**
	 * The empty sequence, shared so that clearing one that is already clear is not
	 * a write.
	 *
	 * `State.set()` compares with `Object.is`, so a fresh `[]` each time would be a
	 * change each time -- and every key that cancels nothing would ask for a frame
	 * to redraw a status line that has not moved. Frozen for the reason every
	 * initial value in the property table is: `readonly` is a TypeScript fiction at
	 * run time, and one caller splicing what the signal published rewrites what
	 * every reader of it sees.
	 */
	const NO_KEYS: readonly Key[] = Object.freeze([]);

	const sequence = new State<readonly Key[]>(NO_KEYS);

	/** The node a pending sequence has reached, or nothing pending. */
	let node: SequenceNode | undefined;

	/** The keys that got it there, which is what the signal publishes. */
	let entered: readonly Key[] = NO_KEYS;

	let seqTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * How long an exact match that is also a prefix waits.
	 *
	 * A value that is not a finite number at or above zero falls back, which is
	 * the typewriter's own rule: `Infinity >= 0` is true and node reads a delay
	 * past 2^31-1 as 1, so honouring one asks for "never" and gets "at once". And
	 * a *finite* number past that ceiling is the same trap one step along, so it
	 * is clamped rather than honoured -- `MAX_DELAY` has which way round and why.
	 */
	const waitFor =
		typeof opts.sequenceTimeout === 'number' &&
		Number.isFinite(opts.sequenceTimeout) &&
		opts.sequenceTimeout >= 0
			? Math.min(opts.sequenceTimeout, MAX_DELAY)
			: SEQUENCE_TIMEOUT;

	/**
	 * Whether a node is still hanging off the trie.
	 *
	 * `parent` is never cleared by a prune -- only the parent's entry for the
	 * child is -- so a walk up the links reaches the root from a node that was
	 * unbound. What says it is still there is the parent still naming it.
	 */
	function reaches(from: SequenceNode): boolean {
		let at: SequenceNode = from;
		while (at.parent) {
			if (at.parent.children.get(at.spec) !== at) {
				return false;
			}
			at = at.parent;
		}
		return at === trie;
	}

	function clearSeqTimer(): void {
		if (seqTimer !== undefined) {
			clearTimeout(seqTimer);
			seqTimer = undefined;
		}
	}

	/** Throws the pending sequence away, timer and all. */
	function clearSequence(): void {
		clearSeqTimer();
		node = undefined;
		entered = NO_KEYS;
		sequence.set(NO_KEYS);
	}

	/**
	 * Runs the bindings a completed sequence reached.
	 *
	 * The pending state is reset by the caller **before** this runs, which is the
	 * order `Show` already keeps for a different reason: a handler that moves the
	 * focus -- and moving the focus is what invalidates a pending sequence -- must
	 * not be clearing state the sequence it completed had already left behind, and
	 * a handler that feeds more keys has to start from a clean one.
	 *
	 * Over a copy and a membership check, which is the rule every handler set here
	 * follows: a sequence whose handler rebinds the same sequence does not hand it
	 * that very completion, and one that unbinds itself is not called twice.
	 *
	 * @param target - The node that was reached.
	 * @param keys - What was pressed to reach it.
	 */
	function fire(target: SequenceNode, keys: readonly Key[]): void {
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const handler of [...target.handlers]) {
			if (!target.handlers.has(handler)) {
				continue;
			}
			handler(keys);
			// the fourth place this is asked, and the ordinary way to reach it is a
			// sequence bound twice whose first handler quits
			if (stopped) {
				return;
			}
		}
	}

	/**
	 * Takes a key the trie has a child for.
	 *
	 * Three shapes, and the third is the only one that waits. A node with no
	 * children is an exact match with nothing to disambiguate, so it fires at
	 * once. A node with children and no handler is a prefix, which waits with no
	 * deadline at all -- there is nothing to decide between, and any key that does
	 * not continue it already cancels it. A node with both is the ambiguous case
	 * `SEQUENCE_TIMEOUT` is for.
	 *
	 * `from` is passed rather than read off `entered`, which is what makes this a
	 * function of its arguments: the second call site offers a key from the
	 * **root**, where the trail has to be empty whatever `entered` holds -- and a
	 * handler reached from the commit just above it can have started a sequence of
	 * its own by calling `feed()`. Measured on the ambient version: `g` committed,
	 * its handler fed a `d`, and the outer `d` was then taken with the inner one
	 * already in `entered` -- so one keystroke left a pending `d d` and the `d d`
	 * binding fired with **three** keys.
	 */
	function take(key: Key, next: SequenceNode, from: readonly Key[]): void {
		clearSeqTimer();
		const keys: readonly Key[] = Object.freeze([...from, key]);

		if (next.children.size === 0) {
			clearSequence();
			fire(next, keys);
			return;
		}

		node = next;
		entered = keys;
		sequence.set(keys);

		if (next.handlers.size > 0) {
			// the node and the keys are captured rather than read back, because the
			// pending state moving is what clears this timer -- so those two cannot
			// part. The **trie** can, which is a thing this comment used to deny: a
			// disposer called while the deadline is running can take the handler off
			// the very node it was armed for, and what is left is a pure prefix, which
			// waits with no deadline at all. So the handlers are asked again on the
			// way out, and firing an empty set there would have thrown the sequence
			// away for nothing. Not unref'd, which matches the key timeout beside it:
			// the router holds stdin resumed for as long as it runs, so it is never
			// the timer keeping the process alive, and a key part way through a
			// sequence is a user mid action rather than a probe nobody is awaiting
			seqTimer = setTimeout(() => {
				seqTimer = undefined;
				if (next.handlers.size === 0) {
					return;
				}
				clearSequence();
				fire(next, keys);
			}, waitFor);
		}
	}

	/**
	 * Drops the last key of the pending sequence.
	 *
	 * Deliberately **not** re-armed even where what is left is a binding as well
	 * as a prefix: Backspace is the user editing the sequence, and committing the
	 * shorter binding on a deadline after an explicit undo is the opposite of what
	 * they asked for.
	 */
	function pop(current: SequenceNode): void {
		clearSeqTimer();
		if (entered.length <= 1) {
			clearSequence();
			return;
		}
		// a real node rather than the root, because more than one key got here
		node = current.parent;
		entered = Object.freeze(entered.slice(0, -1));
		sequence.set(entered);
	}

	/**
	 * Offers a key to the trie, after every function binding has seen it.
	 *
	 * **The rule, which is the Ctrl-C guarantee stated positively: a pending
	 * sequence claims a key only where the app bound a continuation on it.**
	 * Anything else cancels the sequence and is then offered from the root, so it
	 * reaches the focused element and the Tab default exactly as it would have.
	 * Nothing is swallowed that the app did not itself name.
	 *
	 * Escape clears and Backspace pops, and both sit *under* that rule rather than
	 * over it -- a continuation the app explicitly bound on either wins, which is
	 * the same call Tab already gets, where a component that wants it keeps it by
	 * stopping the event. Nothing is stuck either way, because a key that does not
	 * continue the sequence has already ended it.
	 *
	 * @param key - The key.
	 * @returns Whether the sequence machinery claimed it.
	 */
	function sequenceStep(key: Key): boolean {
		// a pending node whose path was unbound while the sequence was part way
		// through is nothing pending, and the disposer cannot say so: `sequence.ts`
		// knows nothing about the router on purpose. Asked here instead, which is a
		// walk of two or three links and only while something is pending
		if (node && !reaches(node)) {
			clearSequence();
		}

		const spec = formatKey(key);

		if (node) {
			const next = node.children.get(spec);
			if (next) {
				take(key, next, entered);
				return true;
			}

			// a modifier makes it a different key, so Alt-Escape is not Escape and
			// `ctrl+h` is not Backspace -- those fall through to the commit below
			if (!key.ctrl && !key.meta && key.name === 'escape') {
				clearSequence();
				return true;
			}
			if (!key.ctrl && !key.meta && key.name === 'backspace') {
				pop(node);
				return true;
			}

			// the sequence is over, and a key that reached the trie and did not
			// continue it has **answered** the question the deadline was waiting on:
			// `g` bound and `g g` bound, `g` then `x`, means `g` -- which is what vim
			// does and the only reading that does not silently lose a keystroke the
			// user deliberately made. The first version discarded it, so a bound `g`
			// fired only if nothing was pressed for half a second.
			//
			// At the node reached and no further. Committing an *ancestor* would mean
			// deciding that the keys after it were spent on nothing and then saying
			// what becomes of them, which is a typeahead replay rather than a rule --
			// so a node with no handler cancels, exactly as before.
			//
			// And Escape and Backspace are above this rather than below it, which is
			// the whole distinction: those are the user saying "forget it", where a
			// key is the user saying which of the two they meant
			const reached = node;
			const keys = entered;
			clearSequence();
			if (reached.handlers.size > 0) {
				fire(reached, keys);
				if (stopped) {
					return true;
				}
			}
		}

		// and then from the root, because a key that ended one sequence may start
		// another: `g` pending with `d d` bound means `d` begins that one rather
		// than being spent on cancelling
		const start = trie.children.get(spec);
		if (start) {
			// from the root, so the trail is empty -- and `entered` is deliberately
			// not what says so: a handler the commit above just ran may have started
			// a sequence of its own
			take(key, start, NO_KEYS);
			return true;
		}

		return false;
	}

	const focus: FocusRing = {
		current,

		focus(element: Element | undefined): void {
			const previous = current.get();
			if (previous === element) {
				return;
			}

			// and a half-entered sequence does not survive the move: one entered into
			// a log pane must not complete in the editor beside it, because the
			// second key was typed at something else. Before the states move rather
			// than after, so that an effect woken by `:focus` already reads the
			// pending sequence as gone. A focus change *caused by* a completing
			// sequence costs nothing here -- `fire()` is handed the keys and the
			// state is already clear by the time the handler can move anything
			clearSequence();

			// the state is what `:focus` matches, so moving focus restyles both ends
			// of the move and nothing else
			previous?.setState('focus', false);
			element?.setState('focus', true);
			current.set(element);
			if (element) {
				lastIndex = Math.max(0, focusables(root).indexOf(element));
				// and it is brought on screen, unconditionally. The ring already
				// skips a `display: none` subtree because there is nothing on screen
				// there to move the focus to; a row below the fold is that case with
				// the opposite answer -- it is on screen, somewhere the user cannot
				// see -- so the fix is to scroll rather than to skip. Left out, Tab
				// into a long list moves a highlight nobody can find, which reads as
				// an app that stopped responding
				scrollIntoView(element);
			}
		},

		next(): void {
			step(1);
		},

		previous(): void {
			step(-1);
		},

		ring(): readonly Element[] {
			return focusables(root);
		},
	};

	/**
	 * Moves the focus along the ring, wrapping.
	 *
	 * The ring is rebuilt from the tree each time rather than kept, so it reorders
	 * itself as the tree does and there is nothing to keep in agreement. A couple
	 * of hundred elements walked on a keystroke is not a cost worth a cache that
	 * can be wrong.
	 */
	function step(by: number): void {
		const ring = focusables(root);
		if (ring.length === 0) {
			focus.focus(undefined);
			return;
		}

		const at = current.get();
		const from = at ? ring.indexOf(at) : -1;
		const index =
			from === -1 ? (by > 0 ? 0 : ring.length - 1) : (from + by + ring.length) % ring.length;
		focus.focus(ring[index]);
	}

	/**
	 * Hands focus somewhere sensible when the element holding it is unmounted.
	 *
	 * Dropping it into nothing is the alternative, and it reads as an app that
	 * stopped responding: every key then goes to the bindings and nowhere else.
	 * The position in the ring is what is kept rather than the element, because
	 * the element is exactly what has gone.
	 */
	function reconcileFocus(): void {
		const at = current.get();
		// nothing focused is a legitimate state and not one to fix: an app that has
		// not put the focus anywhere yet should have its first Tab land on the
		// first element rather than on the second, which is what grabbing it here
		// quietly did
		if (!at || attached(at, root)) {
			return;
		}

		const ring = focusables(root);
		if (ring.length === 0) {
			focus.focus(undefined);
			return;
		}
		focus.focus(ring[Math.min(lastIndex, ring.length - 1)]);
	}

	/** Walks a key from the focused element up through its ancestors. */
	function dispatch(key: Key, paste: boolean): boolean {
		let stopped = false;
		const target = current.get();
		let at: Element | undefined = target;

		const event: KeyEvent = {
			get current() {
				return at;
			},
			key,
			paste,
			stop(): void {
				stopped = true;
			},
			get stopped() {
				return stopped;
			},
			target,
		};

		// a copy, and `has`: the rule in the module docblock
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const binding of [...bindings]) {
			if (!bindings.has(binding)) {
				continue;
			}
			binding(event);
			if (stopped) {
				// and a pending sequence is over, because something else acted on the
				// key: the user typed `g`, then a key a binding claimed, and a `g`
				// after that must not complete `g g` across it. Only where the
				// binding *stopped* the event -- a binding that merely watched every
				// key has observed rather than acted, and cancelling there would make
				// a sequence unenterable in any app that logs its keystrokes
				if (!paste) {
					clearSequence();
				}
				return true;
			}
		}

		// the sequence trie, after every function binding and before anything
		// focused. That order is the whole Ctrl-C guarantee: a function binding sees
		// every key, so no keystroke whatsoever can make one unreachable -- which is
		// the sentence this module already carries about a focused input, and a
		// half-entered sequence is the second route to the same failure.
		//
		// A **pasted** key is skipped outright, both halves of it: it neither
		// advances a sequence nor cancels one. What is between the paste markers is
		// content by definition -- the rule a capability reply inside a paste
		// already follows -- so a pasted `gg` must not fire a `g g` binding, and a
		// paste arriving mid-sequence must not be able to cancel one either.
		// Content cannot drive a binding in either direction
		if (!paste && sequenceStep(key)) {
			return true;
		}

		while (at) {
			at.onKey?.(event);
			if (stopped) {
				return true;
			}
			at = at.parent;
		}

		return false;
	}

	// -- the mouse ------------------------------------------------------------

	const mouse = opts.mouse;
	const mousers = new Set<MouseHandler>();

	/**
	 * The chain under the pointer, innermost first.
	 *
	 * Always empty without motion tracking: with nothing reporting where the
	 * pointer is between clicks, "under the pointer" has no answer, and a hover set
	 * from a press would stick to whatever was clicked with nothing to clear it.
	 */
	let hovering: Element[] = [];

	/**
	 * Which element each held button was pressed on.
	 *
	 * The capture. A key's identity is the button, so two buttons held at once are
	 * two entries, and a button being in here at all is what says a release belongs
	 * to this app.
	 */
	const pressed = new Map<MouseButton, Element | undefined>();

	/** Whether a cursor probe is already out, so a burst of reports asks once. */
	let locating = false;

	/** Everything a mouse event carries that is not its kind or its target. */
	interface MouseDetail {
		button: MouseButton | undefined;
		ctrl: boolean;
		meta: boolean;
		shift: boolean;
		wheel: WheelDirection | undefined;
		x: number;
		y: number;
	}

	/**
	 * Walks a mouse event through a list of elements and then the router's handlers.
	 *
	 * The list rather than "the target and its ancestors", because enter and leave
	 * are dispatched along the difference between two chains rather than bubbled --
	 * one event construction, two ways of choosing who sees it.
	 *
	 * @param kind - Which event.
	 * @param target - What it was addressed to, which does not change as it walks.
	 * @param chain - Who sees it, in order.
	 * @param detail - The position, the button, and the modifiers.
	 * @returns Whether something stopped it.
	 */
	function deliver(
		kind: MouseEventKind,
		target: Element | undefined,
		chain: readonly Element[],
		detail: MouseDetail
	): boolean {
		let stopped = false;
		let current: Element | undefined = target;

		const event: MouseEvent = {
			button: detail.button,
			ctrl: detail.ctrl,
			get current() {
				return current;
			},
			kind,
			meta: detail.meta,
			shift: detail.shift,
			stop(): void {
				stopped = true;
			},
			get stopped() {
				return stopped;
			},
			target,
			wheel: detail.wheel,
			x: detail.x,
			y: detail.y,
		};

		for (const element of chain) {
			current = element;
			element.onMouse?.(event);
			if (stopped) {
				return true;
			}
		}

		// past the tree, so the event is not at an element any more
		current = undefined;

		// a copy, and `has`: the rule in the module docblock
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const handler of [...mousers]) {
			if (!mousers.has(handler)) {
				continue;
			}
			handler(event);
			if (stopped) {
				return true;
			}
		}

		return false;
	}

	/** Target then ancestors, which is every kind but enter and leave. */
	function bubble(kind: MouseEventKind, target: Element | undefined, detail: MouseDetail): boolean {
		return deliver(kind, target, ancestry(target), detail);
	}

	/**
	 * Moves `:hover` and fires the enter and leave that implies.
	 *
	 * `:hover` is set on the whole chain rather than on the innermost element,
	 * because in CSS the pointer is inside every box that contains it -- a
	 * `.row:hover` rule has to match the row when the pointer is over the text
	 * inside it. One source, the state derived from it, and no second thing to keep
	 * in agreement, which is exactly how focus works.
	 *
	 * @param next - The chain under the pointer now, innermost first.
	 * @param detail - What the report that moved it carried.
	 */
	function setHover(next: Element[], detail: MouseDetail): void {
		const before = hovering;
		if (before.length === next.length && before.every((it, i) => it === next[i])) {
			return;
		}

		const wanted = new Set(next);
		const had = new Set(before);
		/** Innermost first, which is the order the DOM leaves in. */
		const left = before.filter((it) => !wanted.has(it));
		/** Outermost first, which is the order the DOM enters in. */
		const entered = next.filter((it) => !had.has(it)).reverse();

		hovering = next;

		// every state first, so a handler that reads `element.states` sees the answer
		// rather than the question
		for (const it of left) {
			it.setState('hover', false);
		}
		for (const it of entered) {
			it.setState('hover', true);
		}

		// and *not* bubbled, which is the one place the dispatch differs by kind.
		// Moving from a child to its sibling leaves the child and enters the sibling
		// and does not leave their parent, which the pointer never left -- a bubbling
		// leave would say it did, which is precisely why the DOM has two spellings of
		// this event. The difference between the two chains is the answer, so the
		// difference is what is dispatched
		for (const it of left) {
			if (deliver('mouseleave', it, [it], detail)) {
				return;
			}
		}
		for (const it of entered) {
			if (deliver('mouseenter', it, [it], detail)) {
				return;
			}
		}
	}

	/**
	 * Asks the terminal where the canvas is, once.
	 *
	 * Lazily, on the first report that cannot be placed, and again after every
	 * re-anchor -- which is the same invalidation list the anchor already has. What
	 * it costs is the one report that found out, which is paid on a resize, on a
	 * line written above the region, and on an eviction.
	 */
	async function relocate(): Promise<void> {
		if (!mouse || locating || stopped) {
			return;
		}
		locating = true;
		try {
			await mouse.surface.locate(() => queryCursor(router));
		} catch {
			// a probe that threw did not answer, which is the same answer as a terminal
			// that said nothing: the origin stays unknown and the next report asks
			// again. Swallowed rather than reported, because nobody asked for this
			// report and a frame must not come down over a mouse move.
			//
			// What that also swallows is a *write* that failed outright, which
			// `InputRouter.query()` rejects over on the ground that a broken stream is
			// not a quiet terminal -- and here there is nobody to tell, since this runs
			// inside the stream's `data` listener. So a stream fault costs the mouse and
			// nothing else, silently. Written down because it cost a debugging round:
			// the screen model in the test suite threw over the `CSI 6 n` it had not been
			// taught, and this is where the throw went
		} finally {
			locating = false;
		}
	}

	/** Whether a canvas coordinate is actually on the canvas. */
	function onCanvas(at: { x: number; y: number }): boolean {
		const surface = mouse?.surface;
		return (
			surface !== undefined &&
			at.x >= 0 &&
			at.y >= 0 &&
			at.x < surface.width &&
			at.y < surface.height
		);
	}

	/** The nearest element containing both, if there is one. */
	function common(a: Element | undefined, b: Element | undefined): Element | undefined {
		if (!a || !b) {
			return undefined;
		}
		const up = new Set(ancestry(a));
		for (let at: Element | undefined = b; at; at = at.parent) {
			if (up.has(at)) {
				return at;
			}
		}
		return undefined;
	}

	/**
	 * Focuses the nearest focusable ancestor of what was pressed.
	 *
	 * Nothing focusable under the pointer leaves the focus where it was rather than
	 * clearing it. A browser blurs there; this does not, because what that comes to
	 * in a terminal is the keyboard stopping because the pointer brushed a border --
	 * and a click that landed on nothing focusable said nothing about focus.
	 */
	function focusFromPress(target: Element | undefined): void {
		for (let at = target; at; at = at.parent) {
			if (at.focusable) {
				focus.focus(at);
				return;
			}
		}
	}

	/**
	 * Hit-tests a report and walks whatever event it means through the tree.
	 *
	 * @param report - The report, in the terminal's own screen coordinates.
	 */
	function routeMouse(report: MouseReport): void {
		if (!mouse) {
			return;
		}

		const at = mouse.surface.toCanvas(report.column, report.row);
		if (!at) {
			void relocate();
			return;
		}

		const detail: MouseDetail = {
			button: report.button,
			ctrl: report.ctrl,
			meta: report.meta,
			shift: report.shift,
			wheel: report.wheel,
			x: at.x,
			y: at.y,
		};

		const inside = onCanvas(at);
		const under = inside && root ? hitTest(root, at.x, at.y) : undefined;

		// a press captures the pointer, so the motion and the release that follow go
		// to whatever the press landed on wherever the pointer has got to. Without
		// it, a drag that wandered off the region would never be told it ended: the
		// release arrives outside the rect, dropping it is what "dropped rather than
		// clamped" says to do, and a component tracking the press waits for a
		// `mouseup` forever. This is the web's implicit capture, and it is what makes
		// a draggable scrollbar possible at all -- which is also why `x` and `y` may
		// be outside the canvas on a captured event.
		//
		// A press is never a captured event, which is not pedantry: it is what
		// *creates* the capture, so reading one would send a second press for a button
		// already held to whatever the first one landed on rather than to what is
		// under the pointer now
		const captured =
			report.kind !== 'mousedown' && report.button !== undefined && pressed.has(report.button);
		const target = captured ? pressed.get(report.button as MouseButton) : under;

		// hover follows the pointer even during a drag, which is what a browser does:
		// the *target* is captured, and where the pointer is, is still where it is. A
		// report from outside the canvas clears it, because the pointer has left
		if (mouse.motion === true) {
			setHover(inside ? ancestry(under) : [], detail);
		}

		switch (report.kind) {
			case 'mousedown': {
				// a press outside the canvas is not this app's: it landed on the log
				// above the region, or on whatever else is sharing the screen. Dropped
				// rather than clamped, which is the whole reason the rect is asked about
				if (!inside) {
					return;
				}
				// a press by no button is a shape SGR does not have -- a release carries
				// the bits of the button it let go, and the final byte is what says which
				// it is -- so there is nothing to pair a release with and nothing to
				// capture. Dropped rather than dispatched as a press nobody can complete
				if (report.button === undefined) {
					return;
				}
				pressed.set(report.button, target);
				if (bubble('mousedown', target, detail)) {
					return;
				}
				// click-to-focus, which is the mouse's default action the way Tab is a
				// key's: a component that wants the press for itself keeps the focus
				// where it was by stopping the event
				focusFromPress(target);
				return;
			}

			case 'mouseup': {
				const button = report.button;
				const ours = button !== undefined && pressed.has(button);
				if (!ours && !inside) {
					// a release of a press this app never saw, landing where it does not
					// draw: not its event in either direction
					return;
				}

				const from = ours ? pressed.get(button as MouseButton) : undefined;
				if (button !== undefined) {
					pressed.delete(button);
				}

				// and the click is *not* gated on it, which is the DOM's rule and took a
				// demo to notice. Stopping an event stops it bubbling; it does not cancel a
				// different event. A slider that stops the `mouseup` because it owns the
				// drag is the ordinary case, and gating the click on it made that slider
				// silently lose the clicks it also wanted -- with nothing to point at,
				// since both spellings look identical from outside. A component that wants
				// neither stops both, which is discoverable in a way the other way round
				// is not
				bubble('mouseup', ours ? from : under, detail);

				// a click is a press and a release on the same thing, and "the same
				// thing" is the nearest box containing both: a press on the text inside a
				// button and a release on the button's padding is a click on the button,
				// which is the DOM's rule and what everybody expects. Nothing in common is
				// no click -- and a release that landed off the canvas needs no guard of
				// its own, because there is nothing under it to have anything in common
				// with. An `inside` conjunct was written here and deleted again for that
				// reason: a condition the suite stays green without reads as load-bearing
				// and is not
				if (ours) {
					const it = common(from, under);
					if (it) {
						bubble('click', it, detail);
					}
				}
				return;
			}

			case 'mousemove': {
				// the pointer left the canvas with nothing held. Hover has already been
				// cleared above, and there is no move to report about a canvas the
				// pointer is not over
				if (!captured && !inside) {
					return;
				}
				bubble('mousemove', target, detail);
				return;
			}

			default: {
				// the wheel, which carries its own position -- so what it turns over is
				// whatever is under the pointer whether or not motion is being tracked at
				// all. A report *is* a position, so this needs no motion to know
				if (!inside) {
					return;
				}
				bubble('wheel', under, detail);
			}
		}
	}

	/**
	 * Offers a decoded sequence to the mouse.
	 *
	 * @param sequence - Exactly what the terminal sent.
	 * @returns Whether it was a mouse report, and so must not be dispatched as a key.
	 */
	function takeMouse(sequence: string): boolean {
		const report = parseMouseReport(sequence);
		if (!report) {
			return false;
		}
		// dropped whether or not anybody asked for tracking, which is the rule a reply
		// nobody is waiting for already follows: a report is not a key. A terminal
		// some other program left in a tracking mode, or one still reporting after
		// this router turned the mode off, would otherwise put `<35;40;12M` into
		// somebody's answer
		if (mouse) {
			routeMouse(report);
		}
		return true;
	}

	/** Reads a chunk, holding a partial sequence or a partial paste. */
	let held = '';
	let pasting: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function flushPaste(text: string): void {
		let stopped = false;
		const event: PasteEvent = {
			stop(): void {
				stopped = true;
			},
			get stopped() {
				return stopped;
			},
			text,
		};

		// eslint-disable-next-line unicorn/no-useless-spread
		for (const handler of [...pasters]) {
			if (!pasters.has(handler)) {
				continue;
			}
			handler(event);
			if (stopped) {
				return;
			}
		}

		// nobody wanted it whole, so it arrives as what it would have been without
		// the markers -- which is what a terminal that cannot bracket a paste sends
		for (const key of decodeKeys(text)) {
			dispatch(key, true);
		}
	}

	function consume(input: string): void {
		// a stopped router reads nothing, which was not true and had a cost: `stop()`
		// clears the held tail and the escape timer, and then `consume()` carried on
		// through the rest of the chunk it was part way through and armed a new one.
		// A Ctrl-C binding that stops the router is the ordinary way to reach it, and
		// what it left behind was a timer firing into a router with no listeners,
		// dispatching to the bindings `stop()` does not remove
		if (stopped) {
			return;
		}

		let rest = input;

		// and the loop asks again, because the chunk it is part way through may be
		// what stops it: a Ctrl-C binding that calls `stop()` is the ordinary way
		while (!stopped && rest !== '') {
			if (pasting !== undefined) {
				const end = rest.indexOf(PASTE_END);
				if (end === -1) {
					pasting += rest;
					return;
				}
				flushPaste(pasting + rest.slice(0, end));
				pasting = undefined;
				rest = rest.slice(end + PASTE_END.length);
				continue;
			}

			const start = rest.indexOf(PASTE_START);
			if (start === -1) {
				break;
			}

			keys(rest.slice(0, start));
			pasting = '';
			rest = rest.slice(start + PASTE_START.length);
		}

		if (!stopped && pasting === undefined && rest !== '') {
			keys(rest);
		}
	}

	/**
	 * Decodes what is certainly whole and holds what might not be.
	 *
	 * `pendingLength()` says how much of a chunk's tail could still be the start
	 * of a longer key, measured by the same reader `decodeKeys()` uses so the two
	 * cannot disagree about where the last key begins. Held here rather than
	 * inside the dispatch, because a second chunk landing while the first is being
	 * handled would otherwise be joined to a stale remainder.
	 */
	function keys(input: string): void {
		clearTimeout(timer);
		timer = undefined;

		// the same options to both, which is the whole reason `pendingLength()`
		// exists: two readers of one chunk that disagree about where the last key
		// starts is the bug it was written against, and `strings` is a second way
		// for them to disagree
		const opts = decoding();
		const joined = held + input;
		const length = pendingLength(joined, opts);
		const ready = length === 0 ? joined : joined.slice(0, joined.length - length);
		const tail = length === 0 ? '' : joined.slice(joined.length - length);
		held = tail;

		for (const key of decodeKeys(ready, opts)) {
			// asked between keys as well as at the entry, because one of them may be
			// the Ctrl-C that stops the router: `feed('\u0003hello')` went on routing
			// `hello` to bindings `stop()` does not remove
			if (stopped) {
				return;
			}
			route(key);
		}

		// and `held` has to still be the tail *this* call computed. A handler reached
		// from the routing above can call `feed()`, which runs this whole function
		// again and leaves its own remainder behind -- so arming from `joined` there
		// arms a second timer over bytes this call never saw. Measured, before any of
		// it was true on purpose: a binding that feeds a trailing `ESC` mid-chunk
		// left **two** timers armed where one is correct, which is what the comment
		// in `armExpiry()` called unreachable. The wasted timer is the lesser half.
		// The one that matters is a held control *string*: where the inner remainder
		// is one and this chunk's was not, `pendingIsString(joined)` is false and the
		// second timer is the key deadline over a held reply, which is the one thing
		// `armExpiry()` exists to refuse. Where the two differ the inner call has
		// already armed for what is really held, or correctly declined to
		if (held !== '' && held === tail) {
			armExpiry(joined, opts);
		}
		settleSatisfied();
	}

	/**
	 * Arms the wait for the rest of what is held, unless a reply owns the wait.
	 *
	 * `ESCAPE_TIMEOUT` is fifty milliseconds because what follows a half-arrived
	 * `ESC [` may be the Ctrl-C somebody is pressing to get out, and a key held
	 * longer than that is a key that feels lost. None of that is true of a
	 * half-arrived *reply*: it is not a key, nobody is waiting on it, and the thing
	 * that should end the wait is the query's own deadline. Flushing one on the key
	 * timeout instead leaves its payload to arrive as a chunk with no introducer in
	 * front of it -- `11;rgb:1111/2222/3333` typed into somebody's answer, by the
	 * one route the framing does not close.
	 *
	 * So a held control string with a query outstanding is not put on a timer at
	 * all, and `settle()` flushes whatever is left when the last query goes. A held
	 * *key* is untouched, which is what keeps that Ctrl-C at fifty milliseconds.
	 */
	function armExpiry(joined: string, opts: DecodeOptions): void {
		// there is never a timer already armed to clear here, and the three things
		// that make that true are the deferred settle, `keys()` clearing on the way
		// in, and `settle()` arming only where nothing is armed. The fourth was a
		// **false** claim until it was measured: this comment said nothing at all
		// could arm one before this runs, and a handler that calls `feed()` from
		// inside the routing does -- so the guard for that is in `keys()`, which
		// declines to arm where `held` is no longer the tail it computed, and its
		// comment has what that cost. A `clearTimeout()` was written
		// here first, for the order this had before -- settling inside the routing
		// armed a timer that this one then assigned over, orphaning it -- and it is
		// gone because nothing can reach it, which is a thing to know before somebody
		// moves the settle back
		if (pending.size > 0 && pendingIsString(joined, opts)) {
			return;
		}
		timer = setTimeout(expire, ESCAPE_TIMEOUT);
	}

	/** Nothing followed it, so what is held is a key rather than a beginning. */
	function expire(): void {
		timer = undefined;
		const rest = held;
		held = '';
		for (const key of decodeKeys(rest, decoding())) {
			if (stopped) {
				return;
			}
			route(key);
		}
		// unreachable today, and kept rather than dropped. A held tail is by
		// definition a read that did not finish, so a *whole* reply cannot be in one
		// -- and the day that stops being true, the alternative to this line is a
		// query that waits out its deadline over an answer it was already handed
		settleSatisfied();
	}

	/**
	 * Every query still waiting for its reply.
	 *
	 * A set rather than one, because a probe and a cursor request may legitimately
	 * be outstanding at once and each wants its own deadline. A reply is offered to
	 * all of them: matching by shape rather than by which query was written is the
	 * rule the batched probe already follows, since a terminal that does not
	 * understand one query answers nothing for it and position says nothing.
	 */
	interface Pending {
		cursor: boolean;
		replies: CapabilityReply[];
		settle(): void;
		timer: ReturnType<typeof setTimeout> | undefined;
		until: QueryOptions['until'];
	}

	const pending = new Set<Pending>();

	/**
	 * Queries whose `until` fired, settled once the whole chunk has been read.
	 *
	 * Settling inside the routing is what the sentinel made expensive: DA1 is
	 * written last, so its reply normally arrives last -- but a terminal that
	 * reorders, or a multiplexer that answers for itself first, can put the DA1 in
	 * front of a reply in the *same chunk*, and a probe that settled on the spot had
	 * already stopped collecting by the time the next key was routed. The reply was
	 * then dropped rather than read, since `takeReply()` claims it either way. So a
	 * satisfied query waits for the end of the chunk, which costs nothing and is
	 * what "matched by shape rather than by position" was supposed to mean.
	 */
	const satisfied = new Set<Pending>();

	/** Settles every query the chunk just satisfied. */
	function settleSatisfied(): void {
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const it of [...satisfied]) {
			it.settle();
		}
		satisfied.clear();
	}

	/**
	 * How the decoder should read an OSC or DCS introducer right now.
	 *
	 * `ESC ]` is both the OSC introducer and Alt-], and only a reader that has
	 * asked the terminal a question knows which. So this is on exactly while one is
	 * outstanding, which closes a reply whose read split between the introducer and
	 * its payload and costs Alt-] only inside that window.
	 */
	function decoding(): DecodeOptions {
		return { strings: pending.size > 0 };
	}

	/**
	 * Offers a decoded sequence to whatever is waiting for a reply.
	 *
	 * @param sequence - Exactly what the terminal sent.
	 * @returns Whether it was a reply, and so must not be dispatched as a key.
	 */
	function takeReply(sequence: string): boolean {
		const found = parseCapabilityResponse(sequence);
		if (!found) {
			return false;
		}

		// a cursor position report is byte for byte Shift-F3 under xterm's
		// `modifyFunctionKeys`, so it is a reply only while somebody asked for one.
		// Everything else `isCapabilityResponse()` claims is a shape no keyboard
		// produces and is a reply whether or not it was asked for
		if (!isCapabilityResponse(sequence)) {
			let wanted = false;
			for (const it of pending) {
				if (it.cursor) {
					wanted = true;
					break;
				}
			}
			if (!wanted) {
				return false;
			}
		}

		// over a copy and a membership check, which is the rule every handler set
		// here follows: `until` may settle a query, and settling removes it
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const it of [...pending]) {
			if (!pending.has(it)) {
				continue;
			}
			it.replies.push(found);
			let done: boolean;
			try {
				done = it.until?.(found, it.replies) === true;
			} catch {
				// a predicate that throws ends its own probe rather than the process.
				// This runs inside the stream's `data` listener, so letting it escape is
				// an uncaught exception -- and it would leave the query outstanding with
				// its deadline armed and the decoder still reading an `ESC ]` as an
				// answer. The caller gets what arrived, which is what a deadline would
				// have given it anyway
				done = true;
			}
			if (done) {
				satisfied.add(it);
			}
		}

		// dropped where nobody was waiting, rather than dispatched. A reply that
		// arrived late, or one the terminal sent unasked, is still not a key -- and
		// putting it in somebody's answer is the failure this whole path is for
		return true;
	}

	/**
	 * Bindings, then the focused element and its ancestors, then the default.
	 *
	 * Tab is the default rather than the first thing tried, so a component that
	 * wants it -- a completion, a cell in a grid -- keeps it by stopping the
	 * event. A binding sees every key before any of that, which is where Ctrl-C
	 * belongs: an app that cannot be quit because a focused input swallowed it is
	 * the failure this order exists to prevent.
	 */
	function route(key: Key): void {
		// before anything else, because everything else is a place a reply must not
		// reach: a binding, a focused text prompt, or the Tab default
		if (takeReply(key.sequence)) {
			return;
		}

		// and a mouse report is the same argument with a different destination. The
		// two are disjoint -- `parseCapabilityResponse()` claims no `CSI < ... M` --
		// so the order between them says nothing, and the reply goes first only
		// because losing one is the more expensive mistake
		if (takeMouse(key.sequence)) {
			return;
		}

		reconcileFocus();

		if (dispatch(key, false)) {
			return;
		}

		if (key.name === 'tab') {
			if (key.shift) {
				focus.previous();
			} else {
				focus.next();
			}
		}
	}

	const onData = (...args: unknown[]): void => {
		consume(String(args[0]));
	};

	const enders = new Set<(error?: unknown) => void>();

	/**
	 * Tells everything waiting on a key that none is coming.
	 *
	 * Over a copy and a membership check, which is the rule every handler set
	 * here follows: a handler added while this is running does not receive this
	 * event, and one removed during it is not called. The first needs the copy and
	 * the second needs the check, and either alone gives only its own half.
	 *
	 * @param error - What the stream failed with, if it did.
	 */
	const ended = (error?: unknown): void => {
		// a probe first, because the stream ending is the strongest possible answer
		// to "will a reply arrive": no. Waiting out the deadline after that is a
		// frame held up for nothing
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const it of [...pending]) {
			it.settle();
		}
		satisfied.clear();

		// eslint-disable-next-line unicorn/no-useless-spread
		for (const handler of [...enders]) {
			if (!enders.has(handler)) {
				continue;
			}
			handler(error);
		}
	};

	const onStreamEnd = (): void => ended();
	const onStreamError = (...args: unknown[]): void => ended(args[0]);

	const resizers = new Set<(size: { height: number; width: number }) => void>();
	const offResize = terminal.onResize((size) => {
		// eslint-disable-next-line unicorn/no-useless-spread
		for (const handler of [...resizers]) {
			if (!resizers.has(handler)) {
				continue;
			}
			handler(size);
		}
	});

	// `setEncoding` rather than a `StringDecoder` of this module's own: the router
	// owns the stream for as long as it runs, which is the whole point of it, so
	// there is no other reader whose view of the bytes this could disturb
	stdin.setEncoding?.('utf8');
	stdin.on?.('data', onData);
	stdin.on?.('end', onStreamEnd);
	stdin.on?.('error', onStreamError);
	stdin.resume?.();
	// only put back what this call changed, which is the rule `hideCursor()`
	// already follows: a router built inside a full-screen app that is already in
	// raw mode must not take the app out of it on the way out -- the app is still
	// reading keys, and what it would get back is a cooked stream that echoes
	const hadRaw = terminal.setRawMode(true);

	const hadPaste = opts.paste === false ? false : terminal.enableBracketedPaste();

	// and the tracking mode, which goes back on the way out for the same reason and
	// with more at stake: a shell left reporting the mouse puts `ESC [ < 35 ; 40 ;
	// 12 M` into whatever the user types next every time they move the pointer
	const hadMouse = mouse ? terminal.enableMouse({ motion: mouse.motion === true }) : false;

	let stopped = false;

	const router: InputRouter = {
		bind(first: KeyHandler | string, second?: SequenceHandler): () => void {
			if (typeof first !== 'string') {
				bindings.add(first);
				return () => void bindings.delete(first);
			}

			// a `bind('ctrl+s')` with the handler forgotten would otherwise register
			// a sequence that consumes the key and does nothing with it, which is
			// strictly worse than the binding not existing
			if (typeof second !== 'function') {
				throw new TypeError(`A key-sequence binding needs a handler: bind("${first}", fn)`);
			}

			return addBinding(trie, parseKeys(first), second);
		},

		feed(chunk: string): void {
			consume(chunk);
		},

		focus,

		get hovered() {
			return hovering[0];
		},

		leader(key: string): LeaderBindings {
			const patterns = parseKeys(key);
			if (patterns.length !== 1) {
				throw new KeySpecError(
					`A leader is one key: "${key}" is ${patterns.length}. Bind the whole sequence instead`
				);
			}

			const first = patterns[0] as KeyPattern;
			// the canonical spelling, so that the leader a status line prints and the
			// one the trie is keyed by are one string
			const spec = formatKey(first);
			const offs = new Set<() => void>();

			return {
				bind(keys: string, handler: SequenceHandler): () => void {
					if (typeof handler !== 'function') {
						throw new TypeError(`A key-sequence binding needs a handler: bind("${keys}", fn)`);
					}

					// the **patterns** are joined rather than the strings, which is what
					// stops `bind('')` binding the leader by itself: `parseKeys('')`
					// refuses an empty spec, and `"space "` does not reach that refusal
					// because the blank token is dropped and one key is left
					const off = addBinding(trie, [first, ...parseKeys(keys)], handler);
					const remove = (): void => {
						offs.delete(remove);
						off();
					};
					offs.add(remove);
					return remove;
				},

				dispose(): void {
					// a copy, because each `remove` takes itself out of the set
					// eslint-disable-next-line unicorn/no-useless-spread
					for (const remove of [...offs]) {
						remove();
					}
				},

				key: spec,
			};
		},

		onMouse(handler: MouseHandler): () => void {
			mousers.add(handler);
			return () => void mousers.delete(handler);
		},

		onPaste(handler: PasteHandler): () => void {
			pasters.add(handler);
			return () => void pasters.delete(handler);
		},

		onEnd(handler: (error?: unknown) => void): () => void {
			enders.add(handler);
			return () => void enders.delete(handler);
		},

		onResize(handler: (size: { height: number; width: number }) => void): () => void {
			resizers.add(handler);
			return () => void resizers.delete(handler);
		},

		query(opts: QueryOptions): Promise<CapabilityReply[]> {
			return new Promise<CapabilityReply[]>((resolve) => {
				// a router that has been stopped writes nothing and waits for nothing:
				// there is nobody left reading stdin, so the reply could only ever be
				// the timeout. Resolved rather than rejected, for the reason the
				// interface gives
				if (stopped) {
					resolve([]);
					return;
				}

				// written before anything is armed, which reads backwards and is the
				// point. `terminal.write()` swallows the far end going away and returns
				// `false`, and it *throws* for a fault that is not that -- so a write
				// inside the arming would reject this promise with a deadline still
				// running and the decoder still reading an `ESC ]` as an answer. Nothing
				// is registered until the question has actually been asked, so the one
				// thing a failed write can cost is the answer. There is no synchronous
				// reply to race: a terminal answers on a later turn of the loop, and a
				// harness that feeds bytes does it after this call returns
				if (!terminal.write(opts.write)) {
					// the far end is gone, so waiting out the deadline is a frame held up
					// for an answer that cannot arrive
					resolve([]);
					return;
				}

				const it: Pending = {
					cursor: opts.cursor === true,
					replies: [],
					settle(): void {
						// idempotent, because three things settle a query -- the reply, the
						// deadline, and the router stopping -- and two of them can race
						if (!pending.delete(it)) {
							return;
						}
						if (it.timer) {
							clearTimeout(it.timer);
							it.timer = undefined;
						}
						// a control string held on this query's behalf has nothing left to
						// wait for, so it goes back on the key timeout -- where it is
						// re-read with `strings` off and an `ESC ]` becomes the Alt-] it
						// always was. Armed rather than flushed here, because flushing
						// would dispatch keys from inside the handling of a reply
						if (pending.size === 0 && held !== '' && timer === undefined) {
							timer = setTimeout(expire, ESCAPE_TIMEOUT);
						}
						resolve(it.replies);
					},
					timer: undefined,
					until: opts.until,
				};

				pending.add(it);
				it.timer = setTimeout(
					() => {
						it.timer = undefined;
						it.settle();
					},
					Math.max(0, opts.timeout ?? QUERY_TIMEOUT)
				);
				// a timer nothing is waiting for must not be what keeps the process
				// alive: a CLI whose last frame has been painted should exit, and a probe
				// is by construction something nobody is blocking on
				it.timer.unref?.();
			});
		},

		sequence,

		stop(): void {
			if (stopped) {
				return;
			}
			stopped = true;

			// every probe gets what it has, which for almost all of them is nothing.
			// A query left outstanding is a promise nobody will ever settle, and the
			// caller of a probe is usually a frame -- so this is the same rule
			// `onEnd()` exists for, one layer along
			// eslint-disable-next-line unicorn/no-useless-spread
			for (const it of [...pending]) {
				it.settle();
			}
			satisfied.clear();

			const off = stdin.off ?? stdin.removeListener;
			off?.call(stdin, 'data', onData);
			off?.call(stdin, 'end', onStreamEnd);
			off?.call(stdin, 'error', onStreamError);
			offResize();
			clearTimeout(timer);
			timer = undefined;
			held = '';
			pasting = undefined;

			// and the pending sequence goes the way the hover states do, and for its
			// reason: nothing will ever clear it otherwise -- the keys have stopped --
			// so the `g` in the corner of a status line would outlive the router that
			// put it there. Which is also the answer to whether there is a fourth
			// place to ask `stopped`: there is not, because the one timer this added
			// is cleared here the way the key timeout is, so it cannot fire into a
			// router with no listeners left. The bindings themselves are deliberately
			// kept, which is what `stop()` already does with a function binding
			clearSequence();

			// left as it was found: paused, undestroyed, and readable by whatever
			// reads it next
			stdin.pause?.();
			if (hadRaw) {
				terminal.setRawMode(false);
			}
			if (hadPaste) {
				terminal.disableBracketedPaste();
			}
			if (hadMouse) {
				terminal.disableMouse();
			}

			// and the hover states go, without dispatching the leave a moving pointer
			// would have. Nothing will ever clear them otherwise -- the reports have
			// stopped -- so a highlight would outlive the tracking that produced it,
			// which is a wrong cell on screen forever. The focus is deliberately *not*
			// cleared the same way: focus is the app's and survives a prompt borrowing
			// the stream, while hover is the pointer's and the pointer has gone.
			// Silently, because dispatching into a component while the router is being
			// torn down is a worse rule than a state nobody is told about
			for (const it of hovering) {
				it.setState('hover', false);
			}
			hovering = [];
			pressed.clear();
		},
	};

	// asked once at the start, so that the common case -- a canvas nothing has
	// re-anchored since -- does not lose its first click to learning where it is
	if (mouse) {
		void relocate();
	}

	return router;
}
