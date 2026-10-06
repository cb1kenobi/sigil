import { cellWidth } from '../canvas/index.js';
import {
	box,
	cellStyle,
	type Element,
	raw,
	text as textNode,
	toDisplayText,
} from '../element/index.js';
import { createInput, type InputRouter, type InputStream, type Key } from '../input/index.js';
import { isAbort } from '../input/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { graphemes, stringWidth } from '../width/index.js';
import { wrap } from '../wrap/index.js';
import {
	boundary,
	deleteAfter,
	deleteBefore,
	deleteRange,
	insertAt,
	isSpaceCluster,
	pastedBlock,
	pastedLine,
	snap,
	typedText,
	wordAfter,
	wordBefore,
} from './editing.js';
import { type Mounted, type MountOptions, mountLive } from './mount.js';

export { ESCAPE_TIMEOUT } from '../input/index.js';

/**
 * Thrown when a prompt cannot be answered, rather than returning a value that
 * looks like an answer.
 *
 * The two ways that happens are different in kind and both matter:
 * `aborted` is somebody pressing Ctrl-C, and not aborted is a prompt reached
 * where there is nobody to ask -- a pipeline, a CI job, a `cron` entry. The
 * second is the one worth failing loudly for: a prompt that waits forever on a
 * stdin that will never produce a keystroke is a hung build with no explanation.
 */
export class PromptError extends Error {
	/** `true` when the person pressed Ctrl-C or Ctrl-D. */
	aborted: boolean;

	constructor(message: string, aborted = false) {
		super(message);
		this.name = 'PromptError';
		this.aborted = aborted;
	}
}

/** A choice offered by `select()` and `multiselect()`. */
export interface Choice<T = unknown> {
	/** Shown after the label, dimmed. */
	hint?: string;
	/** What is shown. */
	label: string;
	/** Whether `multiselect()` starts with it ticked. */
	selected?: boolean;
	/** What is returned. The label, if omitted. */
	value?: T;
}

export interface PromptOptions extends MountOptions {
	/** What is being asked. */
	message: string;
	/**
	 * The input router to read keys through. One is built if not given.
	 *
	 * An app that already owns a router -- a full-screen one, which had to build
	 * one to have a focus ring at all -- hands it over here, and the prompt binds
	 * to it rather than taking stdin out from under it. That is what makes "one
	 * thing owns stdin" true in an app that prompts: a prompt that builds its own
	 * is only correct because nothing else is reading at the time, which is the
	 * ordinary case and is not every case.
	 *
	 * A router handed in is not stopped when the prompt is answered. The prompt
	 * removes the handlers it added and nothing else, because the router is not
	 * its to give back.
	 */
	router?: InputRouter;
	/** Where keys come from. Defaults to the terminal's input. */
	stdin?: InputStream;
}

export interface TextOptions extends PromptOptions {
	/** Used when the answer is empty. */
	default?: string;
	/** Shown in place of what is typed, for a password. */
	mask?: string;
	/** Shown dimmed when nothing has been typed. */
	placeholder?: string;
	/**
	 * Checks the answer. Return a string to reject it with that message, or
	 * anything falsy to accept.
	 */
	validate?: (value: string) => string | undefined | false | Promise<string | undefined | false>;
}

export interface ConfirmOptions extends PromptOptions {
	/** What Enter alone means. Defaults to `true`. */
	default?: boolean;
}

export interface SelectOptions<T> extends PromptOptions {
	/** What to offer. */
	choices: readonly (Choice<T> | string)[];
	/** Which one starts highlighted, by index. Defaults to 0. */
	initial?: number;
}

export interface MultiselectOptions<T> extends SelectOptions<T> {
	/** Refuse an empty selection. Defaults to `false`. */
	required?: boolean;
}

const SYMBOL = {
	cursor: '❯',
	off: '◯',
	on: '◉',
	question: '?',
};

function toChoice<T>(choice: Choice<T> | string): Choice<T> {
	return typeof choice === 'string' ? { label: choice, value: choice as T } : choice;
}

function valueOf<T>(choice: Choice<T>): T {
	return 'value' in choice ? (choice.value as T) : (choice.label as T);
}

/** What a prompt's tree and its key handling are, built together under an owner. */
interface Handlers<T> {
	/**
	 * Whether this prompt wants a key `isAbort()` would otherwise take.
	 *
	 * Only Ctrl-D is ever reachable through this, and only the multiline field
	 * asks: that is its submit key, and end of input and "that is my answer" are
	 * the same gesture -- a field escaped by the key that submits it has no way
	 * out. Ctrl-C is refused above, because an app that cannot be quit because a
	 * field swallowed it is the failure the binding order exists to prevent.
	 *
	 * Absent for the other four prompts, so the abort path they take is the one
	 * they always took.
	 */
	claims?(k: Key): boolean;
	/** Handles a key. Returning `{ value }` finishes. */
	key(k: Key): Promise<{ value: T } | void> | ({ value: T } | void);
	/** Handles pasted text, when the prompt is one that can take a block of it. */
	paste?(text: string): void;
	/** Puts the tree into the form left behind once it is answered. */
	settle(value: T): void;
	/** The tree. */
	view: Element;
}

/**
 * Runs a prompt: a canvas, the one input router, and everything put back
 * whichever way it ends.
 *
 * What used to be here -- raw mode, a `data` listener, a decoder, a held tail
 * and the timer that expires it -- is the router's. What is left is the part that
 * is actually a prompt: a tree, what each key does, and a promise.
 *
 * A router of its own unless one was handed in, and the difference is who gives
 * stdin back: one built here is stopped when the prompt ends, and one handed in
 * is left running with only this prompt's handlers removed. Two prompts at once
 * over two routers would both read every key, which is why an app that has a
 * router passes it.
 *
 * @param opts - Where to read and draw.
 * @param make - Builds the tree and says what each key does. Runs under the
 *   renderer's owner, so the effects it creates are disposed with the prompt.
 * @returns The answer.
 */
function run<T>(opts: PromptOptions, make: () => Handlers<T>): Promise<T> {
	const terminal = opts.terminal ?? defaultTerminal;
	const stdin = opts.stdin ?? (terminal.stdin as InputStream | undefined);

	// nobody is there to answer, and waiting on a stdin that will never produce a
	// keystroke is a hung build with no explanation. The message names the prompt,
	// because "no TTY" on its own does not say which question went unanswered
	if (!terminal.isTTY || !stdin?.isTTY) {
		return Promise.reject(
			new PromptError(`Cannot prompt for "${opts.message}" because the input is not a terminal`)
		);
	}

	return new Promise<T>((resolve, reject) => {
		let handlers: Handlers<T>;
		let settled = false;
		let mounted: Mounted | undefined;
		let stopInput: (() => void) | undefined;

		/** Everything this prompt took, given back in the order it was taken. */
		function detach(): void {
			stopInput?.();
			stopInput = undefined;
		}

		function fail(error: unknown): void {
			if (settled) {
				return;
			}
			settled = true;
			detach();
			mounted?.stop();
			reject(error);
		}

		/**
		 * Where a throw goes, which depends on whether there is still a prompt.
		 *
		 * Before it is answered, a throw is the answer: the promise rejects. After,
		 * the caller already has what it asked for and a frame that failed on the
		 * way out is not a reason to take it back -- so it goes to `onError` if the
		 * caller wanted to hear about one, and nowhere if it did not.
		 *
		 * @param error - What was thrown.
		 */
		function report(error: unknown): void {
			if (settled) {
				opts.onError?.(error);
				return;
			}
			fail(error);
		}

		function succeed(value: T): void {
			if (settled) {
				return;
			}
			settled = true;
			detach();

			// the answer is the answer whatever the last frame does, so resolving is
			// in a `finally`: a throw from `settle()` would otherwise be caught by
			// the queue, handed to a `fail()` that no-ops because this already set
			// `settled`, and leave the caller awaiting a prompt that is gone
			try {
				handlers.settle(value);
				// painted before the screen is given back, because `done()` leaves
				// what is on screen where it is, and that is still the question
				mounted?.frame();
			} catch (error) {
				report(error);
			} finally {
				mounted?.done();
				resolve(value);
			}
		}

		try {
			mounted = mountLive(
				() => {
					handlers = make();
					return handlers.view;
				},
				{ ...opts, onError: report, terminal }
			);
		} catch (error) {
			fail(error);
			return;
		}

		// a throw from the *first frame* does not come back as a throw: the
		// renderer reports it through `onError`, which is `fail()`, and then hands
		// back a handle that has already given the screen up. Carrying on from here
		// built a router over a promise that was already rejected -- stdin left in
		// raw mode with a `data` listener nothing would ever remove, and the next
		// prompt fighting it for keys
		if (settled) {
			return;
		}

		let router: InputRouter;
		const ownRouter = opts.router === undefined;
		try {
			router = opts.router ?? createInput({ root: mounted.renderer.root, stdin, terminal });
		} catch (error) {
			// the frame is already on screen, so it has to come off: a router that
			// could not be built leaves a question nobody can answer, and leaving it
			// drawn is the hang this rejects instead of
			fail(error);
			return;
		}
		stopInput = ownRouter ? () => router.stop() : undefined;

		/** One key at a time, for the reason the binding below records. */
		let queue: Promise<void> = Promise.resolve();

		const offEnd = router.onEnd((error) => {
			// the same nobody-is-there problem as the check above, arriving later
			fail(error ?? new PromptError('Input ended before the prompt was answered'));
		});
		const offKey = router.bind((event) => {
			event.stop();
			const key = event.key;

			// Ctrl-C does not wait its turn. Everything else is queued because
			// `handlers.key` may be async -- a `validate` that asks a server -- and a
			// key read while the last one is still being handled would apply to a
			// state that has not caught up; but a prompt that cannot be escaped until
			// a slow validator comes back is a prompt that cannot be escaped, and
			// giving up needs nothing from the state
			// Ctrl-C is never a key a prompt may claim, which is the binding order's own
			// rule said one layer along. Ctrl-D is the other half of `isAbort()` and is
			// claimable, for the reason `Handlers.claims` records
			if (isAbort(key) && !(key.name === 'd' && handlers.claims?.(key))) {
				fail(new PromptError('Cancelled', true));
				return;
			}

			queue = queue
				.then(async () => {
					if (settled) {
						return;
					}

					const done = await handlers.key(key);
					if (done) {
						succeed(done.value);
						return;
					}

					if (!settled) {
						mounted?.frame();
					}
				})
				.catch(report);
		});

		const offPaste = handlers!.paste
			? router.onPaste((event) => {
					event.stop();
					const text = event.text;
					queue = queue
						.then(() => {
							if (settled) {
								return;
							}
							handlers.paste?.(text);
							mounted?.frame();
						})
						.catch(report);
				})
			: undefined;

		stopInput = () => {
			offEnd();
			offKey();
			offPaste?.();
			// only a router this prompt built is given back: one handed in belongs to
			// an app that is still reading keys with it
			if (ownRouter) {
				router.stop();
			}
		};
	});
}

/** What a field shows when what was typed is wider than the room for it. */
interface Window {
	/** The part before the caret. */
	before: string;
	/** The cluster the caret is on, empty past the end of the value. */
	under: string;
	/** The part after the caret. */
	after: string;
}

/**
 * The part of a value that is on screen, with the caret always in it.
 *
 * A canvas is a fixed number of columns and a field that runs past the edge is
 * clipped there, so a long answer scrolls sideways rather than being cut off --
 * which is what readline does and is the deliberate divergence from what this
 * used to do, where the string was written whole and the terminal wrapped it. A
 * wrapped field cannot work here for a reason worth writing down: there is no
 * inline layout, so the three pieces the caret splits the value into are three
 * flex items, and a wrapped first item leaves the other two beside its *box*
 * rather than after its last line.
 *
 * @param value - What has been typed.
 * @param cursor - Where the caret is, as an offset into it.
 * @param width - How many columns there are.
 * @returns The three pieces, together no wider than `width`.
 */
function windowOf(value: string, cursor: number, width: number): Window {
	const room = Math.max(1, width);
	const end = boundary(value, cursor, 1);
	const under = value.slice(cursor, end);
	// the caret always takes a column, whether it is on a character or past the
	// last one, so the room for the value itself is one less
	const caret = Math.max(1, stringWidth(under));

	let before = value.slice(0, cursor);
	let after = value.slice(end);

	// the caret is kept on screen by dropping clusters from the front, and what
	// is left over at the end goes by dropping them from the back. Both stop when
	// there is nothing left to drop: a two-column caret in a one-column field is
	// a field that cannot hold it, and a loop that insists would never end --
	// which is a hung process rather than a frame one column too wide
	while (before !== '' && stringWidth(before) + caret > room) {
		// the boundary after offset zero, which is the end of the *first* cluster:
		// asking from one gives the end of the second, so the window jumped two
		// characters at a time and settled a column narrower than it had room for
		before = before.slice(boundary(before, 0, 1));
	}
	while (after !== '' && stringWidth(before) + caret + stringWidth(after) > room) {
		after = after.slice(0, boundary(after, after.length, -1));
	}

	return { after, before, under };
}

/**
 * How the head divides the row it is on.
 *
 * Said out loud rather than left to flexing, and the reason has moved. It used to
 * be the one the help template gave: a row's intrinsic height was taken with every
 * child offered the whole content box while placement hands each one a share, so a
 * question measured at the full width and placed in a share of it came out one line
 * tall and the choice list under it was drawn over the rest of the question.
 * SIG-125 closed that in the engine, so no app has to write this subtraction to get
 * a correct layout any more.
 *
 * This survives it for two reasons that were always here. `lines` is the first and
 * it is not about the message at all: the choice list subtracts it to work out how
 * many rows its window has, which is imperative arithmetic no layout answers. And
 * the message is a `min(content, room)` **cap** rather than a share -- what follows
 * it has to start where it ends, so a message that grew into the line would push
 * the caret to the far edge. So the number is computed either way, and the
 * declaration is what keeps the width and the row count one answer.
 *
 * One column is kept back for whatever follows the message, so that a question
 * as long as the terminal still leaves somewhere for the caret to be.
 *
 * @param message - What is being asked.
 * @param room - The columns the whole line has.
 * @returns What the message gets, what is left after it, and how many rows it
 *   takes -- which is what anything drawn *under* the head has to know, and is
 *   worked out here so that the width and the height cannot disagree about it.
 */
function headWidths(
	message: string,
	room: number
): { lines: number; message: number; rest: number } {
	// the mark, the mark's margin, and the message's own margin
	const fixed = stringWidth(SYMBOL.question) + 2;
	const forMessage = Math.max(1, Math.min(stringWidth(message), room - fixed - 1));
	return {
		// through the same wrapper the text element draws with, rather than by
		// dividing one width by another: a word too long to fit is broken, and a
		// count that guessed would put a choice list over the question
		lines: wrap(toDisplayText(message), { width: forMessage }).split('\n').length,
		message: forMessage,
		rest: Math.max(1, room - fixed - forMessage),
	};
}

/**
 * The head of a prompt: the mark, the message, and whatever follows them.
 *
 * @param message - What is being asked.
 * @param width - The columns the message gets, from `headWidths()`.
 * @param rest - What follows it.
 * @returns The line, and the mark, which every prompt settles.
 */
function promptHead(
	message: string,
	width: number,
	...rest: Element[]
): { line: Element; mark: Element } {
	const mark = textNode(SYMBOL.question, { class: 'sigil-symbol sigil-accent', 'margin-right': 1 });
	return {
		line: box(
			{ class: 'sigil-prompt-line' },
			mark,
			textNode(message, {
				class: 'sigil-prompt-message sigil-heading',
				'flex-shrink': 0,
				'margin-right': 1,
				width,
			}),
			...rest
		),
		mark,
	};
}

/** Marks the head as answered, which is the only thing every prompt settles. */
function answered(mark: Element): void {
	mark.setProps({ class: 'sigil-symbol is-success sigil-success' });
}

/** A line that is shown only when it has something to say. */
function note(classes: string): Element {
	return textNode('', { class: classes, display: 'none' });
}

/**
 * Puts text on a line that hides itself when there is none.
 *
 * @param element - The line.
 * @param text - What it says, or nothing.
 */
function setNote(element: Element, text: string | undefined): void {
	element.setText(text ?? '');
	element.setProps({ display: text ? 'flex' : 'none' });
}

/**
 * Asks for a line of text.
 *
 * @param opts - What to ask, and how to check the answer.
 * @returns What was typed.
 */
export function text(opts: TextOptions): Promise<string> {
	const terminal = opts.terminal ?? defaultTerminal;
	let value = '';
	let cursor = 0;
	let error: string | undefined;

	return run<string>(opts, () => {
		const before = textNode('', { 'white-space': 'nowrap' });
		const caret = textNode('', { class: 'sigil-caret', 'white-space': 'nowrap' });
		const after = textNode('', { 'white-space': 'nowrap' });
		const field = box({ class: 'sigil-prompt-field' }, before, caret, after);
		const head = headWidths(opts.message, Math.max(1, terminal.width));
		const { line, mark } = promptHead(opts.message, head.message, field);
		const complaint = note('sigil-prompt-error sigil-error');
		const view = box(
			{ class: 'sigil-prompt', 'flex-direction': 'column' },
			line,
			box({ 'padding-left': 2 }, complaint)
		);

		/**
		 * What is drawn in place of a piece of the value.
		 *
		 * A mask is a column count rather than a substitution -- a two-column emoji
		 * is two bullets -- so it is applied per piece rather than to the whole
		 * value, which is what lets the caret sit between two of them. The pieces
		 * still add up to what the whole value masked to, because they are split on
		 * cluster boundaries and a width is the sum of its parts.
		 *
		 * @param part - A piece of the value.
		 * @returns The piece, or the mask standing in for it.
		 */
		function shown(part: string): string {
			return opts.mask === undefined ? part : opts.mask.repeat(stringWidth(part));
		}

		/** How many columns the value has, once the head has taken its share. */
		function room(): number {
			return head.rest;
		}

		function draw(): void {
			setNote(complaint, error);

			if (value === '') {
				// the caret is on screen from the first frame rather than from the
				// first keystroke: a prompt that only shows where it will type once
				// something has been typed is the same bug one keystroke smaller
				const hint = opts.placeholder ? opts.placeholder : (opts.default ?? '');
				const end = boundary(hint, 0, 1);
				before.setText('');
				// not dimmed along with the rest: it is under the reverse video either
				// way, and dimming it is how a caret comes to read as part of the hint
				// rather than as the place the next character goes
				caret.setText(hint.slice(0, end) || ' ');
				after.setText(hint.slice(end));
				after.setProps({ class: 'sigil-prompt-placeholder sigil-muted' });
				return;
			}

			const pane = windowOf(value, cursor, room());
			before.setText(shown(pane.before));
			// past the last character there is nothing to mark, so the caret is a
			// column of its own rather than a mark on one
			caret.setText(shown(pane.under) || ' ');
			after.setText(shown(pane.after));
			after.setProps({ class: '' });
		}

		/**
		 * Types text in at the cursor, which is what a key and a paste both are.
		 *
		 * @param input - What to insert.
		 */
		function insert(input: string): void {
			({ cursor, value } = insertAt(value, cursor, input));
		}

		draw();

		return {
			async key(k) {
				error = undefined;

				if (k.name === 'enter') {
					const answer = value === '' ? (opts.default ?? '') : value;
					const failed = await opts.validate?.(answer);
					if (typeof failed === 'string' && failed) {
						error = failed;
						draw();
						return;
					}
					return { value: answer };
				}

				if (k.name === 'backspace') {
					({ cursor, value } = deleteBefore(value, cursor));
				} else if (k.name === 'delete') {
					({ cursor, value } = deleteAfter(value, cursor));
				} else if (k.name === 'left') {
					cursor = boundary(value, cursor, -1);
				} else if (k.name === 'right') {
					cursor = boundary(value, cursor, 1);
				} else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
					cursor = 0;
				} else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
					cursor = value.length;
				} else if (k.ctrl && k.name === 'u') {
					value = value.slice(cursor);
					cursor = 0;
				} else {
					// a printable key, and `typedText()` is what decides whether this was
					// one: a character arrives with its name and its sequence the same
					// string, while a named key's name is one the terminal never sent. What
					// is inserted is the sequence rather than the name
					insert(typedText(k) ?? '');
				}

				draw();
			},

			paste(block: string): void {
				// a one-line field, so the line breaks a pasted block carries are
				// flattened rather than obeyed -- `pastedLine()` is that rule, and it sits
				// beside `pastedBlock()`, which is the multiline field's opposite answer
				// to the same question
				insert(pastedLine(block));
				draw();
			},

			settle(answer: string): void {
				answered(mark);
				before.setText('');
				caret.setText('');
				caret.setProps({ class: '' });
				after.setText(opts.mask === undefined ? answer : opts.mask.repeat(stringWidth(answer)));
				after.setProps({ class: 'sigil-prompt-answer sigil-muted' });
				setNote(complaint, undefined);
			},

			view,
		};
	});
}

/**
 * Asks for a line of text without showing it.
 *
 * @param opts - What to ask.
 * @returns What was typed.
 */
export function password(opts: TextOptions): Promise<string> {
	return text({ mask: '•', ...opts });
}

/**
 * The key that submits a multiline answer, since Enter cannot.
 *
 * A spec rather than a predicate, because the hint the field draws has to say
 * which key it is: a `(k: Key) => boolean` is more flexible and would need a
 * second option beside it for the label, and two options that can disagree
 * about one key is how a prompt comes to tell the reader to press something
 * that does nothing.
 *
 * `{ meta: true, name: 'enter' }` is Alt-Enter, which is also what
 * Escape-then-Enter arrives as when the two are pressed inside
 * `ESCAPE_TIMEOUT` of each other -- so that sequence is reachable without the
 * field having to hold a mode nothing on screen could show.
 */
export interface SubmitKey {
	/** Whether Ctrl is held. */
	ctrl?: boolean;
	/** Whether Alt is held, which a terminal sends as a leading `ESC`. */
	meta?: boolean;
	/** The key's name, as `decodeKeys()` names it. */
	name: string;
}

export interface MultilineOptions extends PromptOptions {
	/**
	 * What the field starts with, which the person can then edit.
	 *
	 * There is deliberately no `default`: `text()` has one because Enter alone is
	 * the common gesture there, and here Enter is a newline -- so a field that is
	 * meant to come up with something in it comes up with it *visible and
	 * editable*, which is the better answer anyway.
	 *
	 * Its line endings are normalized the way a paste's are, so that the value
	 * holds one spelling of a line break and nothing else.
	 */
	initial?: string;
	/** Shown dimmed when nothing has been typed. */
	placeholder?: string;
	/**
	 * The most rows the field takes before it scrolls. Ten by default, and capped
	 * by what the terminal has left under the question.
	 *
	 * The field *grows* into it rather than starting there: one that reserved ten
	 * rows for a one-line answer would hold nine blank rows of the user's
	 * scrollback open for the life of the prompt, which is the same argument the
	 * auto-height canvas is written for.
	 */
	rows?: number;
	/** What submits the answer. Ctrl-D by default. */
	submit?: SubmitKey;
	/**
	 * Checks the answer. Return a string to reject it with that message, or
	 * anything falsy to accept.
	 */
	validate?: (value: string) => string | undefined | false | Promise<string | undefined | false>;
}

/**
 * The field arithmetic below is exported for a test and is deliberately *not*
 * in the components barrel.
 *
 * What a multiline field claims is a coordinate -- a caret derived from an
 * offset, a goal column that survives a short row and a wide cluster -- and
 * those are functions of a string, an offset and a width. The screen model a
 * component test reads holds characters rather than styling, so asserting them
 * through it is asserting them through a keyhole: the cell under the caret holds
 * the same character whether or not a caret was drawn there. So the arithmetic
 * is asserted directly and the field is asserted through the screen, which is
 * the split `rowWindow()` and `thumbExtent()` already keep for the scroll box.
 *
 * Not barrel-exported, because only the barrel is published: `FieldLayout` is a
 * shape this module owes nobody, and a type in the public API is a promise.
 */

/** One cluster of a field's value, and where it was drawn. */
export interface FieldCell {
	/** The cluster's offset in the value. */
	at: number;
	/** What is drawn for it, which is what a `text` would draw for it. */
	text: string;
	/** How many columns it takes. */
	width: number;
	/** The column it starts at. */
	x: number;
}

/** One row of a field, which is a row on screen rather than a line of the value. */
export interface FieldRow {
	cells: FieldCell[];
	/** The offset the row begins at, which is where an empty row's caret goes. */
	start: number;
	/** The columns its cells take. */
	width: number;
}

/** A value laid out at a width, with the caret placed in it. */
export interface FieldLayout {
	/** Where the caret is drawn, and the cluster it marks. */
	caret: { row: number; text: string; x: number };
	rows: FieldRow[];
	/** The columns the field asks for: its widest row, plus the caret's own. */
	width: number;
}

/** What the two layers of a field read: the rows, the window, and the caret. */
export interface FieldFrame {
	layout: FieldLayout;
	/** The first row on screen, when the value is taller than the field. */
	top: number;
	/** How many of its rows are on screen. */
	visible: number;
}

/** A cluster of the value, with where it is. */
interface Cluster {
	at: number;
	text: string;
}

/** A run of clusters that are all whitespace or all not, which is what wraps. */
interface ClusterRun {
	clusters: Cluster[];
	space: boolean;
	width: number;
}

/**
 * What one cluster draws, which is what a `text` draws for it.
 *
 * A newline is the line terminator rather than something to draw: it is a
 * cluster of the value and therefore an offset the caret can sit on, and it
 * takes no column. Everything else goes through the same function a `text`
 * reads, which is what makes a tab one space here as well -- the grid models no
 * tab stops, and a field that disagreed with every other text in the library
 * about what a tab is would be a column out per tab.
 *
 * The newline branch fails its own sabotage and is kept, because the sabotage is
 * **equivalent** rather than the branch dead: `cellWidth('\n')` is zero --
 * measured, along with every other control character -- so the cell comes out
 * unpaintable either way. What it buys is that nothing can ever hand a raw `\n`
 * to `CellBuffer.put()`, which *throws* on one. Dropping the mapping altogether
 * is the sharper sabotage and is caught.
 *
 * @param cluster - One grapheme cluster of the value.
 * @returns What to paint, which is empty for anything with no cell.
 */
function clusterText(cluster: string): string {
	return cluster === '\n' ? '' : toDisplayText(cluster);
}

/** How many columns one cluster takes, which is what the grid will give it. */
function clusterWidth(cluster: string): number {
	const text = clusterText(cluster);
	return text === '' ? 0 : cellWidth(text);
}

/** Splits a line's clusters into the runs `wrap()` breaks between. */
function clusterRuns(clusters: readonly Cluster[]): ClusterRun[] {
	const runs: ClusterRun[] = [];
	let current: Cluster[] = [];
	let space = false;
	let width = 0;

	for (const cluster of clusters) {
		const blank = isSpaceCluster(cluster.text);
		if (current.length > 0 && blank !== space) {
			runs.push({ clusters: current, space, width });
			current = [];
			width = 0;
		}
		space = blank;
		current.push(cluster);
		width += clusterWidth(cluster.text);
	}
	if (current.length > 0) {
		runs.push({ clusters: current, space, width });
	}

	return runs;
}

/**
 * Where a caret goes on a row, given the column it would like.
 *
 * **A caret may not be painted on the far half of a wide cluster**, and that is
 * not about how it looks: `CellBuffer` carries a write on either half of one to
 * the other, so a space on the continuation blanks the lead and the character is
 * *gone*. Measured -- `漢` in a two-column grid, a space at column one, and the
 * row comes back as two blanks.
 *
 * Two columns are the only place it can happen and both are reachable. A cluster
 * wider than the wrap limit is placed at column zero anyway, because the break
 * guard asks `x > 0` -- there is nowhere else to put it -- so a field of one or
 * two columns holds a row two columns wide, the reported width is the room, and
 * the clamp under `edge` lands on column one. And a zero-width cell is clamped
 * to the wrap column by `place()`, so a newline after such a cluster is *already*
 * there: `漢\nmore` with End pressed on the first line is the same cell.
 *
 * So the caret backs up to the cluster's lead and **marks the cluster**, which is
 * this field's own rule applied to the only cluster there is room for. It is
 * wrong about where the next character goes -- in a two-column field holding a
 * wide character there is no column that is right about that -- and it is the only
 * answer that keeps the character on screen.
 *
 * @param row - The row the caret is on.
 * @param at - The column it would like.
 * @returns The column to paint in, and what to paint there.
 */
function caretOn(row: FieldRow, at: number): { text: string; x: number } {
	for (const cell of row.cells) {
		if (cell.width > 0 && at >= cell.x && at < cell.x + cell.width) {
			return { text: cell.text, x: cell.x };
		}
	}

	return { text: ' ', x: at };
}

/**
 * A value laid out as rows of cells, with the caret placed among them.
 *
 * **This is what the `raw` node buys and why the field is one.** A wrapping
 * field is the problem the single-line prompt scrolls sideways to avoid: there
 * is no inline layout, so the three pieces the caret splits a value into are
 * three flex items, and a wrapped first item leaves the other two beside its
 * *box* rather than after its last line. A `raw` is one node that measures like
 * a text and paints its own cells, so the value is wrapped once here and the
 * caret is a cell coordinate derived from the offset.
 *
 * **Soft wrap only.** The value keeps exactly the breaks the person typed, and a
 * row is where the field *drew* a break rather than anything in the value.
 *
 * **The caret marks the cluster at the cursor**, which is the single-line
 * field's own rule -- reverse video over a whole grapheme cluster -- and it is
 * what answers the end-of-a-row-versus-start-of-the-next question with no second
 * rule to remember: a cursor at a soft break is drawn at the start of the next
 * row, because that is where the cluster it names was placed. Past the last
 * cluster there is nothing to mark, so the caret is a column of its own.
 *
 * **Every cluster is placed, including the whitespace a break throws away.**
 * `wrap()` drops the trailing whitespace of a line and is right to -- a terminal
 * draws nothing for it. A field cannot: a space is an offset the caret has to be
 * able to sit on, so the gap stays on the row it ended. What that costs is one
 * declared divergence: whitespace that would land past the wrap column is placed
 * *at* it, so a run of several spaces at a break shares one column. They are all
 * blanks, so nothing on screen says so; what it buys is that the caret is always
 * inside the box, with no phantom row for an invisible character.
 *
 * **It wraps at one column less than the room**, which is the single-line
 * field's own rule said again: the caret always takes a column, whether it is on
 * a character or past the last one. The alternative is a caret at column
 * `width`, drawn on a row below the one it belongs to -- and then pressing End
 * on a full row makes the field a row taller, so a key that moved nothing
 * reflows everything under it.
 *
 * @param value - What has been typed, or the placeholder standing in for it.
 * @param cursor - Where the caret is, as an offset into it.
 * @param room - The columns the field has.
 * @returns The rows, the caret, and the width the field asks for.
 */
export function layoutField(value: string, cursor: number, room: number): FieldLayout {
	const limit = Math.max(1, room - 1);
	const at = snap(value, Math.max(0, Math.min(cursor, value.length)));
	const rows: FieldRow[] = [];

	let cells: FieldCell[] = [];
	let start = 0;
	/** The column the next cluster would take, before the clamp. */
	let x = 0;

	/** Ends the row being built and starts one at `next`. */
	const flush = (next: number): void => {
		let width = 0;
		for (const cell of cells) {
			width = Math.max(width, cell.x + cell.width);
		}
		rows.push({ cells, start, width });
		cells = [];
		start = next;
		x = 0;
	};

	const place = (cluster: Cluster): void => {
		const text = clusterText(cluster.text);
		const width = text === '' ? 0 : cellWidth(text);
		cells.push({ at: cluster.at, text, width, x: Math.min(x, limit) });
		x += width;
	};

	// the value's clusters, grouped into the logical lines its newlines define.
	// The terminator belongs to the line it ends, because its offset is a place
	// the caret goes: pressing End on a line puts it there
	const lines: { clusters: Cluster[]; start: number; terminator: Cluster | undefined }[] = [];
	let line: Cluster[] = [];
	let lineStart = 0;
	let offset = 0;

	for (const text of graphemes(value)) {
		const cluster = { at: offset, text };
		offset += text.length;
		if (text === '\n') {
			lines.push({ clusters: line, start: lineStart, terminator: cluster });
			line = [];
			lineStart = offset;
		} else {
			line.push(cluster);
		}
	}
	lines.push({ clusters: line, start: lineStart, terminator: undefined });

	for (const logical of lines) {
		start = logical.start;

		/** The whitespace since the last word, which decides where a break falls. */
		let gap: Cluster[] = [];
		let gapWidth = 0;

		for (const run of clusterRuns(logical.clusters)) {
			if (run.space) {
				gap = run.clusters;
				gapWidth = run.width;
				continue;
			}

			const breaking = x > 0 && x + gapWidth + run.width > limit;
			// the gap goes on the row it ended either way, which is where this parts
			// company with `wrap()` and why
			for (const cluster of gap) {
				place(cluster);
			}
			gap = [];
			gapWidth = 0;
			if (breaking) {
				flush(run.clusters[0].at);
			}

			for (const cluster of run.clusters) {
				// only reachable for a word that did not fit a row of its own, since
				// the row was already broken for one that did: this is where it is cut
				if (x > 0 && x + clusterWidth(cluster.text) > limit) {
					flush(cluster.at);
				}
				place(cluster);
			}
		}

		for (const cluster of gap) {
			place(cluster);
		}
		if (logical.terminator) {
			place(logical.terminator);
		}
		flush(logical.terminator ? logical.terminator.at + 1 : value.length);
	}

	let widest = 0;
	for (const row of rows) {
		widest = Math.max(widest, row.width);
	}
	// the caret's own column is what the `+ 1` is, and it is what makes the clamp
	// below a no-op anywhere but a one-column field -- where `limit` cannot be
	// zero, so a cell really can land on the column the box ends at
	const width = Math.min(Math.max(1, room), widest + 1);
	const edge = width - 1;

	for (const [row, built] of rows.entries()) {
		for (const cell of built.cells) {
			if (cell.at === at) {
				// through `caretOn()` whatever the cell is, which is one rule rather
				// than two: a cell of positive width finds itself there and takes its
				// own text, and a cell with no cell at all -- a newline, a lone
				// combining mark, a control character a caller handed in -- has nothing
				// to mark, so it comes back a blank unless the column it was clamped to
				// belongs to a cluster. `place()` clamps a zero-width cell to the wrap
				// column, which a wide cluster may already be sitting on
				const on = caretOn(built, Math.min(edge, cell.x));
				return { caret: { row, text: on.text, x: on.x }, rows, width };
			}
		}
	}

	// past the last cluster, which is the one position no cluster owns -- and it is
	// the last row's, because every other row's end is the next row's start
	const last = rows.at(-1);
	const on = last ? caretOn(last, Math.min(edge, last.width)) : { text: ' ', x: 0 };
	return { caret: { row: rows.length - 1, text: on.text, x: on.x }, rows, width };
}

/**
 * The offset a vertical move lands on, given the column it is aiming for.
 *
 * **The goal is a display column rather than an offset**, which is the thing a
 * from-scratch textarea gets wrong: a remembered offset drifts left through a
 * short row, and an offset and a column stop being the same number the moment a
 * row holds a wide character. So Up-Up-Down comes back to the column it started
 * in, through a short row and through a row of CJK.
 *
 * The last cluster whose column is at or before the goal, which is where a caret
 * can be: aiming past the end of a row lands on its last position, and aiming at
 * the far half of a wide cluster lands on that cluster rather than between its
 * halves.
 *
 * @param layout - The value as it is drawn.
 * @param length - The value's length, for the one position no cluster owns.
 * @param row - The row to land on.
 * @param column - The column to aim for.
 * @returns The offset.
 */
export function offsetIn(layout: FieldLayout, length: number, row: number, column: number): number {
	const index = Math.max(0, Math.min(row, layout.rows.length - 1));
	const target = layout.rows[index];

	// the position past the last cluster, which only the last row has: every other
	// row's end is the next row's start, and belongs to that row.
	//
	// Aimed at the column the caret would be *drawn* in rather than at the row's
	// own extent, because the two part company exactly where the whitespace clamp
	// bit: a row ending in a run of spaces is `limit + 1` wide while the caret past
	// it is drawn at `limit`, so a goal column -- which can never exceed the edge --
	// could not reach the end of the value at all. `layoutField()` computes that
	// column the same way, which is what keeps the two agreeing
	if (index === layout.rows.length - 1 && column >= Math.min(layout.width - 1, target.width)) {
		return length;
	}

	let found = target.start;
	for (const cell of target.cells) {
		if (cell.x > column) {
			break;
		}
		// at or before, and the *last* such cell: a run of whitespace clamped to the
		// wrap column shares it, and the caret belongs on the last of them
		found = cell.at;
	}

	return found;
}

/**
 * The offset the logical line holding `at` starts at.
 *
 * **Home, End, Ctrl-A, Ctrl-E, Ctrl-U and Ctrl-K are the logical line and not
 * the row on screen**, which is the one place this field is a terminal field
 * rather than a textarea. Three reasons, and the third is the deciding one.
 * Ctrl-A and Ctrl-E *are* readline's names for the ends of a line, so making
 * them mean something else here is the surprise rather than the consistency.
 * nano, vim and emacs all answer the logical line for Home. And the visual
 * reading has a wart it cannot avoid: the last caret position on a
 * soft-wrapped row is *on* its last cluster rather than after it -- there is no
 * column after it, which is the whole reason the row broke -- so a visual End
 * leaves the caret one character short of where "end" reads.
 *
 * Vertical movement stays visual, because that is what the person can see and
 * because a goal column is a column.
 *
 * @param value - What has been typed.
 * @param at - An offset in it.
 * @returns The offset after the previous newline, or zero.
 */
export function lineStart(value: string, at: number): number {
	return (at <= 0 ? -1 : value.lastIndexOf('\n', at - 1)) + 1;
}

/**
 * The offset the logical line holding `at` ends at, which is its newline's own.
 *
 * Before the newline rather than after it, so that End leaves the caret where
 * the next character would go on *this* line and Ctrl-K kills the line's text
 * without joining it to the next -- which is what readline's `kill-line` does.
 *
 * @param value - What has been typed.
 * @param at - An offset in it.
 * @returns The offset of the next newline, or the end of the value.
 */
export function lineEnd(value: string, at: number): number {
	const found = value.indexOf('\n', Math.max(0, at));
	return found === -1 ? value.length : found;
}

/**
 * The field and its caret, as two `raw` elements over one rectangle.
 *
 * **Two elements because one cannot resolve two styles**, which is the scroll
 * bar's own shape and the decrypt's: the caret carries `.sigil-caret` and is
 * therefore `inverse` through the ordinary cascade, so a theme reaches it where
 * it reaches everything else. At colour level 0 the seven attributes go, so no
 * caret is drawn there at all -- which is the rule the single-line field's caret
 * already follows and is right: a reverse-video caret would be the one sequence
 * `NO_COLOR` could not switch off.
 *
 * **The caret paints at the field's box rather than at its own.** Its insets
 * resolve against the host's padding box, so a `padding` an app writes on the
 * host would otherwise put every caret a column away from the character it
 * marks. Reading the box of the frame it is in is what a `raw` is for.
 *
 * **`drawsText` on both, rather than `selectable: true`.** A `raw` is not
 * selectable unless something says so, which is right for a sparkline and wrong
 * for a field whose cells *are* the text; `drawsText` changes the **default**, so
 * a `selectable={false}` on a pane still reaches the field the way it reaches
 * the texts inside it, where an answer would have beaten it. On the caret layer
 * too, and that is not decoration: it repaints the cluster under the caret, so
 * without it that one cell would be the one character of the field a selection
 * could not copy.
 *
 * A function of a frame rather than part of `multiline()`, so that what it draws
 * is testable with no terminal and no keystrokes -- which is the rule the layout
 * engine and the selector engine already keep, and is the only way to ask what a
 * cell's `selectable` came out as.
 *
 * @param read - The frame to draw: the rows, the window, and the caret.
 * @returns The two elements, the field named first because it is the one in flow.
 */
export function fieldLayers(read: () => FieldFrame): { caret: Element; field: Element } {
	const field = raw(
		{
			drawsText: true,
			// the frame's own width rather than the one it was offered, because the
			// layout was taken at a room the component already knew
			measure: () => {
				const { layout, visible } = read();
				return {
					height: visible,
					minHeight: visible,
					minWidth: layout.width,
					width: layout.width,
				};
			},
			paint: (painter, area, element) => {
				const { layout, top, visible } = read();
				const style = cellStyle(element.style);

				// the window rather than the box, and a `Math.min` of the two was written
				// here and taken out again for failing its sabotage: the measure asks for
				// exactly `visible` rows, so the box's own height is that number -- and
				// where a parent gave it more, drawing the rows that were not asked for
				// would be drawing outside the window rather than inside the box
				for (let row = 0; row < visible && top + row < layout.rows.length; row++) {
					for (const cell of layout.rows[top + row].cells) {
						// a cluster with no cell is not painted, and the guard is a tripwire
						// rather than a saving: `CellBuffer.put()` *throws* on a control
						// character rather than dropping it, and a throw from inside paint
						// takes the frame and the renderer with it. `clusterText()` already
						// gives one no text, so nothing the field itself produces reaches
						// this -- what does is a `FieldCell` somebody else built
						if (cell.width > 0) {
							painter.text(area.x + cell.x, area.y + row, cell.text, style);
						}
					}
				}
			},
		},
		{ class: 'sigil-prompt-field' }
	);

	const caret = raw(
		{
			drawsText: true,
			// never asked, because a box given both insets on an axis is as wide as
			// they say
			measure: () => ({ height: 0, width: 0 }),
			paint: (painter, _area, element) => {
				const { layout, top, visible } = read();
				const area = field.content ?? field.box;
				const row = layout.caret.row - top;
				// the window rather than the box, which is the same number: the measure
				// asked for `visible` rows and nothing in this tree squeezes the cross
				// axis below what a line's largest item reported. A second bound on
				// `area.height` was written here and taken out again for failing its
				// sabotage -- the grid refuses a cell outside itself, so what it was
				// standing against was a box this component cannot produce
				if (!area || row < 0 || row >= visible) {
					return;
				}
				painter.text(
					area.x + layout.caret.x,
					area.y + row,
					layout.caret.text,
					cellStyle(element.style)
				);
			},
		},
		{
			bottom: 0,
			class: 'sigil-caret',
			left: 0,
			position: 'absolute',
			right: 0,
			top: 0,
		}
	);

	return { caret, field };
}

/**
 * How many rows a field may take, from what the caller asked for.
 *
 * **Enumerated rather than clamped**, which is the rule the typewriter's own
 * interval keeps and the trap it keeps it for: `Math.min(NaN, anything)` is
 * `NaN`, so a `rows` of `NaN` reached the measure as a height of `NaN` and the
 * layout engine was handed a box no arithmetic can place -- and a fractional one
 * reached it as a fractional height, which is the thing a declaration is refused
 * for. `Infinity` is fine on its own, because the terminal's own cap is the
 * other half of the `Math.min`, and it is read here anyway so that one function
 * answers for every value rather than three guards agreeing.
 *
 * @param rows - What the caller asked for.
 * @returns A whole number of rows, or the default.
 */
function rowCap(rows: number | undefined): number {
	return rows !== undefined && Number.isFinite(rows) && rows >= 1 ? Math.floor(rows) : 10;
}

/** `ctrl-d`, as a reader would type it. */
function keyLabel(key: SubmitKey): string {
	return `${key.ctrl ? 'ctrl-' : ''}${key.meta ? 'alt-' : ''}${key.name}`;
}

/** Whether a key is the one that submits. */
function isSubmitKey(k: Key, spec: SubmitKey): boolean {
	return k.name === spec.name && k.ctrl === (spec.ctrl ?? false) && k.meta === (spec.meta ?? false);
}

/**
 * Asks for several lines of text.
 *
 * Enter inserts a newline, so submitting is a key of its own -- Ctrl-D by
 * default, and `submit` names another. That is the one thing that *had* to move
 * from `text()`; everything else here is the same editing rules over a list of
 * lines, shared through `editing.ts` rather than written twice. The caret is
 * painted into the frame rather than by moving the terminal's own cursor, which
 * is what keeps the region's repaint arithmetic honest and is not this ticket's
 * to renegotiate.
 *
 * **A pasted block keeps its line breaks**, which is the deliberate inverse of
 * what `text()` does with one. The two rules sit next to each other in
 * `editing.ts` so that the inversion is visible rather than discovered: a
 * one-line field flattens a paste because obeying a break there submits half an
 * address, and a multiline field keeps them because keeping them is the entire
 * point of having more than one line.
 *
 * @param opts - What to ask, and how to check the answer.
 * @returns What was typed.
 */
export function multiline(opts: MultilineOptions): Promise<string> {
	const terminal = opts.terminal ?? defaultTerminal;
	const submit = opts.submit ?? { ctrl: true, name: 'd' };

	// a key with no name is one `decodeKeys()` never produces, so a field given one
	// has no way to be submitted at all -- which is the hang `PromptError` exists
	// for, and is refused the way a choice list with nothing to offer is rather
	// than by quietly putting the default back
	if (submit.name === '') {
		return Promise.reject(
			new PromptError(`"${opts.message}" has no key to submit with: \`submit.name\` is empty`)
		);
	}
	// through the same normalizer a paste goes through, so that the value holds
	// one spelling of a line break and every rule below can split on it
	let value = pastedBlock(opts.initial ?? '');
	let cursor = value.length;
	let error: string | undefined;
	/**
	 * The column a run of vertical moves is aiming for.
	 *
	 * Cleared by anything else, which is what makes Up-Up-Down end in the column
	 * it started in rather than wherever the shortest row on the way left it.
	 */
	let goal: number | undefined;
	/** The first row on screen, when the value is taller than the field. */
	let top = 0;

	return run<string>(opts, () => {
		const hint = textNode(`(${keyLabel(submit)} to submit)`, {
			class: 'sigil-prompt-hint sigil-muted',
		});
		const answer = textNode('', { class: 'sigil-prompt-answer sigil-muted', display: 'none' });
		const head = headWidths(opts.message, Math.max(1, terminal.width));
		const { line, mark } = promptHead(opts.message, head.message, hint, answer);
		const complaint = note('sigil-prompt-error sigil-error');

		/** The columns the field has, once the indent under the question is taken. */
		const room = Math.max(1, Math.max(1, terminal.width) - 2);
		/**
		 * The rows the field may take before it scrolls.
		 *
		 * Capped by what is left under the question and over the error line, which
		 * is reserved either way so that showing one does not push the last row of
		 * the field off the screen -- the rule the choice list already keeps.
		 */
		const cap = Math.max(
			1,
			Math.min(rowCap(opts.rows), Math.max(1, terminal.height) - head.lines - 1)
		);

		/**
		 * The layout on screen, as a plain field.
		 *
		 * Computed in `draw()` at a room the component already knows rather than at
		 * the width the box was given, which is the rule the single-line field keeps
		 * -- `windowOf()` is handed `head.rest` -- and is what makes the measure and
		 * the paint one answer rather than two that have to be kept in agreement.
		 */
		let layout = layoutField(value, cursor, room);
		/** How many of its rows are on screen. */
		let visible = 1;

		const { caret: caretLayer, field } = fieldLayers(() => ({ layout, top, visible }));

		const view = box(
			{ class: 'sigil-prompt', 'flex-direction': 'column' },
			line,
			// `position: relative` with no insets moves nothing and is what gives the
			// caret layer a containing block to resolve its own against
			box(
				{ class: 'sigil-prompt-multiline', 'padding-left': 2, position: 'relative' },
				field,
				caretLayer
			),
			box({ 'padding-left': 2 }, complaint)
		);

		function draw(): void {
			setNote(complaint, error);

			// the placeholder is drawn by the field with its class switched rather than
			// by a layer of its own: one element cannot resolve two styles, and there
			// is only ever one of the two to draw
			const shown = value === '' ? opts.placeholder : undefined;
			layout = layoutField(shown ?? value, shown === undefined ? cursor : 0, room);
			visible = Math.max(1, Math.min(layout.rows.length, cap));
			top = windowStart(layout.rows.length, layout.caret.row, visible, top);

			field.setProps({
				class:
					shown === undefined
						? 'sigil-prompt-field'
						: 'sigil-prompt-field sigil-prompt-placeholder sigil-muted',
			});
			field.invalidateMeasure();
			caretLayer.invalidatePaint();
		}

		/**
		 * Moves the caret, which is the one place a cursor is written.
		 *
		 * Through `snap()` and clamped, so that an offset worked out from a row of
		 * the *placeholder* -- which is what the rows describe while the value is
		 * empty -- can never be stored as a cursor into the value.
		 *
		 * **Declared rather than claimed**: it cannot change an answer today and it
		 * fails its own sabotage, because the one way an offset from the wrong
		 * string gets here is with a value of `''` -- the placeholder shows only
		 * then -- and every rule below answers the same for any offset into that.
		 * What it buys is that this is the one place a cursor is written, so the
		 * invariant every rule below reads is asserted here rather than assumed of
		 * each of them.
		 *
		 * @param to - Where to put it.
		 */
		function move(to: number): void {
			cursor = snap(value, Math.max(0, Math.min(to, value.length)));
		}

		/**
		 * Moves the caret by rows, keeping the column it is aiming for.
		 *
		 * Going up from the first row and down from the last land on the ends of the
		 * value, which is what a textarea does: there is no row to go to, and a caret
		 * that moved nowhere reads as a key that did not work.
		 *
		 * @param by - How many rows, signed.
		 */
		function vertical(by: number): void {
			goal ??= layout.caret.x;
			const to = layout.caret.row + by;

			if (to < 0) {
				move(0);
			} else if (to >= layout.rows.length) {
				move(value.length);
			} else {
				move(offsetIn(layout, value.length, to, goal));
			}
		}

		draw();

		return {
			// Ctrl-D is this field's submit key and `isAbort()` would otherwise take
			// it: end of input and "that is my answer" are the same gesture, and a
			// field escaped by the key that submits it has no way out. Ctrl-C is never
			// claimable, which `run()` is what enforces
			claims(k) {
				return isSubmitKey(k, submit);
			},

			async key(k) {
				error = undefined;

				if (isSubmitKey(k, submit)) {
					const failed = await opts.validate?.(value);
					if (typeof failed === 'string' && failed) {
						error = failed;
						draw();
						return;
					}
					return { value };
				}

				const vertically = k.name === 'up' || k.name === 'down';
				const paging = k.name === 'pageup' || k.name === 'pagedown';
				const word = k.ctrl || k.meta;

				if (k.name === 'enter') {
					({ cursor, value } = insertAt(value, cursor, '\n'));
				} else if (k.name === 'backspace') {
					({ cursor, value } = word
						? deleteRange(value, wordBefore(value, cursor), cursor)
						: deleteBefore(value, cursor));
				} else if (k.name === 'delete') {
					({ cursor, value } = word
						? deleteRange(value, cursor, wordAfter(value, cursor))
						: deleteAfter(value, cursor));
				} else if (k.ctrl && k.name === 'w') {
					({ cursor, value } = deleteRange(value, wordBefore(value, cursor), cursor));
				} else if (k.meta && k.name === 'd') {
					({ cursor, value } = deleteRange(value, cursor, wordAfter(value, cursor)));
				} else if (k.name === 'left') {
					move(word ? wordBefore(value, cursor) : boundary(value, cursor, -1));
				} else if (k.name === 'right') {
					move(word ? wordAfter(value, cursor) : boundary(value, cursor, 1));
				} else if (k.meta && k.name === 'b') {
					move(wordBefore(value, cursor));
				} else if (k.meta && k.name === 'f') {
					move(wordAfter(value, cursor));
				} else if (vertically) {
					vertical(k.name === 'up' ? -1 : 1);
				} else if (paging) {
					vertical(k.name === 'pageup' ? -visible : visible);
				} else if (k.ctrl && (k.name === 'home' || k.name === 'end')) {
					// the whole value rather than the line, which is the one place the
					// modifier means something here
					move(k.name === 'home' ? 0 : value.length);
				} else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
					move(lineStart(value, cursor));
				} else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
					move(lineEnd(value, cursor));
				} else if (k.ctrl && k.name === 'u') {
					({ cursor, value } = deleteRange(value, lineStart(value, cursor), cursor));
				} else if (k.ctrl && k.name === 'k') {
					({ cursor, value } = deleteRange(value, cursor, lineEnd(value, cursor)));
				} else {
					({ cursor, value } = insertAt(value, cursor, typedText(k) ?? ''));
				}

				// a run of vertical moves keeps the column it is aiming for and
				// everything else gives it up, which is the whole of what a goal column
				// is. Cleared after the move, because `vertical()` is what reads it
				if (!vertically && !paging) {
					goal = undefined;
				}

				draw();
			},

			paste(block: string): void {
				// the opposite of what `text()` does with a block, and the reason is
				// under `pastedBlock()`: the breaks are what a multiline field is for
				({ cursor, value } = insertAt(value, cursor, pastedBlock(block)));
				goal = undefined;
				draw();
			},

			settle(written: string): void {
				answered(mark);
				hint.setProps({ display: 'none' });
				// one line in the log, which is the house style every other prompt here
				// keeps -- `select()` leaves its label and `multiselect()` leaves a comma
				// list. The whole of what was written is the caller's return value, and a
				// log holding a fifty-line paste per prompt is a log nobody reads
				const lines = written.split('\n');
				const more = lines.length - 1;
				answer.setText(
					written === ''
						? '(empty)'
						: more > 0
							? `${lines[0]} (+${more} more ${more === 1 ? 'line' : 'lines'})`
							: lines[0]
				);
				answer.setProps({ display: 'flex' });
				field.setProps({ display: 'none' });
				caretLayer.setProps({ display: 'none' });
				setNote(complaint, undefined);
			},

			view,
		};
	});
}

/**
 * Asks a yes or no question.
 *
 * @param opts - What to ask.
 * @returns The answer.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
	const fallback = opts.default ?? true;

	return run<boolean>(opts, () => {
		const tail = textNode(`(${fallback ? 'Y/n' : 'y/N'})`, {
			class: 'sigil-prompt-hint sigil-muted',
		});
		const { line, mark } = promptHead(
			opts.message,
			headWidths(opts.message, Math.max(1, (opts.terminal ?? defaultTerminal).width)).message,
			tail
		);

		return {
			key(k) {
				if (k.name === 'enter') {
					return { value: fallback };
				}
				const ch = k.name.toLowerCase();
				if (ch === 'y') {
					return { value: true };
				}
				if (ch === 'n') {
					return { value: false };
				}
			},

			settle(answer: boolean): void {
				answered(mark);
				tail.setText(answer ? 'yes' : 'no');
				tail.setProps({ class: 'sigil-prompt-answer sigil-muted' });
			},

			view: line,
		};
	});
}

/** One row of a choice list, and the parts of it that change. */
interface ChoiceRow {
	hint: Element;
	label: Element;
	mark: Element;
	pointer: Element;
	row: Element;
}

/**
 * Builds the rows a choice list is drawn as.
 *
 * @param choices - The choices.
 * @param ticked - Whether each row carries a tick box, for a multiselect.
 * @returns The rows and the box holding them.
 */
function choiceRows<T>(
	choices: readonly Choice<T>[],
	ticked: boolean
): { list: Element; rows: ChoiceRow[] } {
	const rows = choices.map((choice) => {
		// the cursor on every row, hidden where it is not the active one: a text of
		// nothing but spaces measures zero, since `white-space: normal` collapses a
		// run of them, so a blank standing in for the cursor indented an inactive
		// row one column less than an active one. Hidden content still takes its
		// space, and reserving it with the same glyph is what keeps the column the
		// cursor's own width rather than a guess at it.
		const pointer = textNode(SYMBOL.cursor, { 'margin-right': 1, visibility: 'hidden' });
		const mark = textNode(SYMBOL.off, { class: 'sigil-choice-mark', 'margin-right': 1 });
		const label = textNode(choice.label);
		const hint = textNode(choice.hint ?? '', {
			class: 'sigil-choice-hint sigil-muted',
			display: choice.hint ? 'flex' : 'none',
			'margin-left': 1,
		});

		if (!ticked) {
			mark.setProps({ display: 'none' });
		}

		return {
			hint,
			label,
			mark,
			pointer,
			row: box({ class: 'sigil-choice' }, pointer, mark, label, hint),
		};
	});

	return {
		list: box({ 'flex-direction': 'column' }, ...rows.map((row) => row.row)),
		rows,
	};
}

/**
 * Which rows are on screen, keeping the active one among them.
 *
 * A canvas is a fixed number of rows and what does not fit is clipped, where the
 * live region wrote every line and let the terminal scroll -- which was broken in
 * its own way, since the repaint then walked the cursor up into the log. So a
 * list longer than the screen shows a window of itself and the window follows the
 * highlight, which is what every prompt library does and what stops an arrow key
 * moving a cursor nobody can see.
 *
 * Kept as the smallest move rather than as stored scroll state: the only thing
 * that has to be true is that `active` is on screen, and recomputing it from
 * `active` alone means nothing to keep in agreement.
 *
 * @param count - How many choices there are.
 * @param active - Which is highlighted.
 * @param room - How many rows the list may take.
 * @param from - Where the window starts now.
 * @returns Where it starts next.
 */
function windowStart(count: number, active: number, room: number, from: number): number {
	const visible = Math.max(1, Math.min(room, count));
	const start = Math.min(Math.max(0, from), Math.max(0, count - visible));

	if (active < start) {
		return active;
	}
	if (active >= start + visible) {
		return active - visible + 1;
	}
	return start;
}

/**
 * Draws which row is highlighted, which are ticked, and which are on screen.
 *
 * @param rows - The rows.
 * @param active - Which is highlighted.
 * @param start - The first row on screen.
 * @param room - How many rows the list may take.
 * @param ticked - Which are ticked, for a multiselect.
 */
function paintChoices(
	rows: ChoiceRow[],
	active: number,
	start: number,
	room: number,
	ticked?: ReadonlySet<number>
): void {
	const visible = Math.max(1, Math.min(room, rows.length));

	for (const [i, row] of rows.entries()) {
		const here = i === active;
		row.pointer.setProps({
			class: here ? 'sigil-choice-pointer' : '',
			visibility: here ? 'visible' : 'hidden',
		});
		row.row.setProps({
			class: here ? 'sigil-choice is-active sigil-accent' : 'sigil-choice',
			display: i >= start && i < start + visible ? 'flex' : 'none',
		});
		if (ticked) {
			const on = ticked.has(i);
			row.mark.setText(on ? SYMBOL.on : SYMBOL.off);
			row.mark.setProps({
				class: on ? 'sigil-choice-mark is-on sigil-success' : 'sigil-choice-mark',
			});
		}
	}
}

/**
 * Asks for one of a list.
 *
 * @param opts - What to ask and what to offer.
 * @returns The chosen value.
 */
export function select<T = string>(opts: SelectOptions<T>): Promise<T> {
	const choices = opts.choices.map((choice) => toChoice<T>(choice));

	if (!choices.length) {
		return Promise.reject(new PromptError(`"${opts.message}" has no choices to offer`));
	}

	let active = Math.min(Math.max(0, opts.initial ?? 0), choices.length - 1);
	let start = 0;
	const terminal = opts.terminal ?? defaultTerminal;

	return run<T>(opts, () => {
		const answer = textNode('', { class: 'sigil-prompt-answer sigil-muted', display: 'none' });
		const head = headWidths(opts.message, Math.max(1, terminal.width));
		const { line, mark } = promptHead(opts.message, head.message, answer);
		const { list, rows } = choiceRows(choices, false);
		const view = box({ class: 'sigil-prompt', 'flex-direction': 'column' }, line, list);

		/** The rows the list has, once the question has taken its own. */
		const room = (): number => Math.max(1, Math.max(1, terminal.height) - head.lines);

		function draw(): void {
			start = windowStart(choices.length, active, room(), start);
			paintChoices(rows, active, start, room());
		}

		draw();

		return {
			key(k) {
				if (k.name === 'enter') {
					return { value: valueOf(choices[active]) };
				}
				// wrapping, because a list you cannot get to the end of by going up is
				// a list you have to know the length of
				if (k.name === 'up') {
					active = (active - 1 + choices.length) % choices.length;
				} else if (k.name === 'down') {
					active = (active + 1) % choices.length;
				} else if (k.name === 'home') {
					active = 0;
				} else if (k.name === 'end') {
					active = choices.length - 1;
				}
				draw();
			},

			settle(): void {
				answered(mark);
				answer.setText(choices[active].label);
				answer.setProps({ display: 'flex' });
				// the list goes: what is left is the question and its answer, which is
				// the one line worth keeping in a log
				list.setProps({ display: 'none' });
			},

			view,
		};
	});
}

/**
 * Asks for any number of a list.
 *
 * @param opts - What to ask and what to offer.
 * @returns The chosen values, in the order they are listed.
 */
export function multiselect<T = string>(opts: MultiselectOptions<T>): Promise<T[]> {
	const choices = opts.choices.map((choice) => toChoice<T>(choice));

	if (!choices.length) {
		return Promise.reject(new PromptError(`"${opts.message}" has no choices to offer`));
	}

	let active = Math.min(Math.max(0, opts.initial ?? 0), choices.length - 1);
	const ticked = new Set<number>(
		choices.map((choice, i) => (choice.selected ? i : -1)).filter((i) => i >= 0)
	);
	let error: string | undefined;
	let start = 0;
	const terminal = opts.terminal ?? defaultTerminal;

	function chosen(): T[] {
		return [...ticked].sort((a, b) => a - b).map((i) => valueOf(choices[i]));
	}

	return run<T[]>(opts, () => {
		const hint = textNode('(space to select, enter to confirm)', {
			class: 'sigil-prompt-hint sigil-muted',
		});
		const head = headWidths(opts.message, Math.max(1, terminal.width));
		const { line, mark } = promptHead(opts.message, head.message, hint);
		const { list, rows } = choiceRows(choices, true);
		const complaint = note('sigil-prompt-error sigil-error');
		const view = box(
			{ class: 'sigil-prompt', 'flex-direction': 'column' },
			line,
			list,
			box({ 'padding-left': 2 }, complaint)
		);

		// the question's rows, and the line an error would take: reserved either
		// way, so that showing one does not push the last choice off the screen
		const room = (): number => Math.max(1, Math.max(1, terminal.height) - head.lines - 1);

		function draw(): void {
			start = windowStart(choices.length, active, room(), start);
			setNote(complaint, error);
			paintChoices(rows, active, start, room(), ticked);
		}

		draw();

		return {
			key(k) {
				error = undefined;

				if (k.name === 'enter') {
					if (opts.required && ticked.size === 0) {
						error = 'Choose at least one';
						draw();
						return;
					}
					return { value: chosen() };
				}

				if (k.name === 'space') {
					if (ticked.has(active)) {
						ticked.delete(active);
					} else {
						ticked.add(active);
					}
				} else if (k.name === 'up') {
					active = (active - 1 + choices.length) % choices.length;
				} else if (k.name === 'down') {
					active = (active + 1) % choices.length;
				} else if (k.name === 'a' && k.ctrl) {
					// all, or none if everything is already ticked
					if (ticked.size === choices.length) {
						ticked.clear();
					} else {
						for (let i = 0; i < choices.length; i++) {
							ticked.add(i);
						}
					}
				}

				draw();
			},

			settle(values: T[]): void {
				answered(mark);
				hint.setText(
					values.length
						? choices
								.filter((_, i) => ticked.has(i))
								.map((choice) => choice.label)
								.join(', ')
						: 'none'
				);
				hint.setProps({ class: 'sigil-prompt-answer sigil-muted' });
				list.setProps({ display: 'none' });
				setNote(complaint, undefined);
			},

			view,
		};
	});
}
