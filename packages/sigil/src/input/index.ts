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
 * What is deliberately not here: mouse tracking, which would give `:hover`,
 * click-to-focus and a scroll wheel, and which costs a capability check and a
 * mode that must go back on exit. It is a follow-up rather than a no -- and the
 * event model does not preclude it, which is why a key event is `KeyEvent`
 * rather than `Event`: a mouse one can join it without either having to become
 * the other. The Kitty keyboard protocol is the same shape of answer, opt-in by
 * query, and worth having the day something needs a key the legacy encoding
 * cannot spell.
 */

import { decodeKeys, type Key, pendingLength } from '../components/keys.js';
import type { Element } from '../element/index.js';
import { State } from '../signals/index.js';
import {
	PASTE_END,
	PASTE_START,
	type Terminal,
	terminal as defaultTerminal,
} from '../terminal/index.js';

export { isAbort, type Key } from '../components/keys.js';

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

export interface InputRouter {
	/**
	 * Adds an app-level binding, which sees every key before anything focused.
	 *
	 * @param handler - What to do with it.
	 * @returns Removes the binding.
	 */
	bind(handler: KeyHandler): () => void;
	readonly focus: FocusRing;
	/** Feeds bytes as though the terminal had sent them. */
	feed(chunk: string): void;
	/**
	 * Adds a paste handler, which sees pasted text before it is typed in.
	 *
	 * @param handler - What to do with it.
	 * @returns Removes the handler.
	 */
	onPaste(handler: PasteHandler): () => void;
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
	/** Gives stdin back and puts raw mode and the paste markers back. */
	stop(): void;
}

export interface InputOptions {
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
	terminal?: Terminal;
}

/** A readable stream, as narrow as this module needs it. */
interface InputStream {
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
	const stdin = terminal.stdin as InputStream | undefined;

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

	const focus: FocusRing = {
		current,

		focus(element: Element | undefined): void {
			const previous = current.get();
			if (previous === element) {
				return;
			}

			// the state is what `:focus` matches, so moving focus restyles both ends
			// of the move and nothing else
			previous?.setState('focus', false);
			element?.setState('focus', true);
			current.set(element);
			if (element) {
				lastIndex = Math.max(0, focusables(root).indexOf(element));
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
				return true;
			}
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
		let rest = input;

		while (rest !== '') {
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

		if (pasting === undefined && rest !== '') {
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

		const joined = held + input;
		const length = pendingLength(joined);
		const ready = length === 0 ? joined : joined.slice(0, joined.length - length);
		held = length === 0 ? '' : joined.slice(joined.length - length);

		for (const key of decodeKeys(ready)) {
			route(key);
		}

		if (held !== '') {
			timer = setTimeout(expire, ESCAPE_TIMEOUT);
		}
	}

	/** Nothing followed it, so what is held is a key rather than a beginning. */
	function expire(): void {
		timer = undefined;
		const rest = held;
		held = '';
		for (const key of decodeKeys(rest)) {
			route(key);
		}
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
	stdin.resume?.();
	terminal.setRawMode(true);

	const hadPaste = opts.paste === false ? false : terminal.enableBracketedPaste();

	let stopped = false;

	return {
		bind(handler: KeyHandler): () => void {
			bindings.add(handler);
			return () => void bindings.delete(handler);
		},

		feed(chunk: string): void {
			consume(chunk);
		},

		focus,

		onPaste(handler: PasteHandler): () => void {
			pasters.add(handler);
			return () => void pasters.delete(handler);
		},

		onResize(handler: (size: { height: number; width: number }) => void): () => void {
			resizers.add(handler);
			return () => void resizers.delete(handler);
		},

		stop(): void {
			if (stopped) {
				return;
			}
			stopped = true;

			const off = stdin.off ?? stdin.removeListener;
			off?.call(stdin, 'data', onData);
			offResize();
			clearTimeout(timer);
			timer = undefined;
			held = '';
			pasting = undefined;

			// left as it was found: paused, undestroyed, and readable by whatever
			// reads it next
			stdin.pause?.();
			terminal.setRawMode(false);
			if (hadPaste) {
				terminal.disableBracketedPaste();
			}
		},
	};
}
