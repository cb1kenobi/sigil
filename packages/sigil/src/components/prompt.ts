import { box, type Element, text as textNode, toDisplayText } from '../element/index.js';
import { createInput, type InputRouter, type InputStream, type Key } from '../input/index.js';
import { isAbort } from '../input/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { graphemes, stringWidth } from '../width/index.js';
import { wrap } from '../wrap/index.js';
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

/**
 * A C0 or C1 control character.
 *
 * `decodeKeys()` names every C0 byte -- as Enter, Tab, Backspace, or Ctrl with a
 * letter -- so the only one that reaches a text prompt as a character is a C1,
 * which a paste can carry. It draws as nothing or as a command, and neither is
 * something to put in an answer.
 */
const controlChar = /^\p{Cc}$/u;

/** Every run of whitespace in a pasted block, which a one-line field flattens. */
const pastedBreak = /\s+/gu;

function toChoice<T>(choice: Choice<T> | string): Choice<T> {
	return typeof choice === 'string' ? { label: choice, value: choice as T } : choice;
}

function valueOf<T>(choice: Choice<T>): T {
	return 'value' in choice ? (choice.value as T) : (choice.label as T);
}

/** What a prompt's tree and its key handling are, built together under an owner. */
interface Handlers<T> {
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
			if (isAbort(key)) {
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

/**
 * The offset of the cluster boundary one step from `at`.
 *
 * The cursor is an offset into the value rather than an index into its clusters,
 * so that inserting and slicing stay ordinary string work -- but it only ever
 * lands where `graphemes()` says one character ends and the next begins.
 * `cursor ± 1` walks UTF-16 code units instead: an emoji is two of them, so a
 * backspace over one left a lone surrogate in the value and every edit after it
 * was working on a string no terminal can draw.
 *
 * An offset that is somehow not on a boundary snaps to one rather than being
 * refused, because the alternative to moving is a cursor that cannot move.
 *
 * @param value - What has been typed.
 * @param at - Where the cursor is.
 * @param direction - `-1` for the boundary before it, `1` for the one after.
 * @returns The offset, clamped to the ends of the value.
 */
function boundary(value: string, at: number, direction: -1 | 1): number {
	let offset = 0;
	let previous = 0;

	for (const cluster of graphemes(value)) {
		offset += cluster.length;

		if (direction === 1) {
			if (offset > at) {
				return offset;
			}
		} else if (offset >= at) {
			return previous;
		}

		previous = offset;
	}

	return direction === 1 ? value.length : previous;
}

/**
 * Where an offset lands once the clusters around it are taken into account.
 *
 * An insertion is the one edit that does not move by whole clusters: what was
 * typed can join the cluster that follows the cursor rather than standing on its
 * own. A combining mark with nothing before it is its own cluster, so typing a
 * letter in front of one makes the two a single cluster two code units long and
 * leaves the cursor one unit into it -- and the backspace after that splits the
 * pair and leaves the mark behind, which is the same damage the astral case
 * causes with a surrogate.
 *
 * @param value - What has been typed.
 * @param at - The offset to place.
 * @returns `at` when it is already a boundary, else the end of the cluster it
 *   fell inside.
 */
function snap(value: string, at: number): number {
	let offset = 0;

	for (const cluster of graphemes(value)) {
		if (offset >= at) {
			return offset;
		}
		offset += cluster.length;
	}

	return value.length;
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
 * Said out loud rather than left to flexing, which is the same piece of
 * arithmetic the help template kept and for the same reason: a row's intrinsic
 * height is taken with every child offered the whole content box and placed with
 * each given a share, so a question measured at the full width and placed in a
 * share of it came out one line tall -- and the choice list under it was drawn
 * over the rest of the question. A declared width is measured at the width it
 * will be placed at, which is the whole of what this needs.
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
	const mark = textNode(SYMBOL.question, { class: 'sigil-symbol', 'margin-right': 1 });
	return {
		line: box(
			{ class: 'sigil-prompt-line' },
			mark,
			textNode(message, {
				class: 'sigil-prompt-message',
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
	mark.setProps({ class: 'sigil-symbol is-success' });
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
		const complaint = note('sigil-prompt-error');
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
				after.setProps({ class: 'sigil-prompt-placeholder' });
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
			if (input === '') {
				return;
			}
			value = value.slice(0, cursor) + input + value.slice(cursor);
			cursor = snap(value, cursor + input.length);
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
					const start = boundary(value, cursor, -1);
					if (start < cursor) {
						value = value.slice(0, start) + value.slice(cursor);
						cursor = start;
					}
				} else if (k.name === 'delete') {
					value = value.slice(0, cursor) + value.slice(boundary(value, cursor, 1));
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
				} else if (!k.ctrl && !k.meta && (k.name === 'space' || k.name === k.sequence)) {
					// a printable key, which is anything that named itself rather than a
					// key this knows about: a character arrives with its name and its
					// sequence the same string, while a named key's name is one the
					// terminal never sent -- `up` for `ESC [ A`, `tab` for a `\t`. Space
					// is named, and is still a character. What is inserted is the
					// sequence rather than the name, so that the two can never disagree
					const ch = k.name === 'space' ? ' ' : k.sequence;
					if (!controlChar.test(ch)) {
						insert(ch);
					}
				}

				draw();
			},

			paste(block: string): void {
				// a one-line field, so the line breaks a pasted block carries are
				// flattened rather than obeyed: obeying one is what makes a paste
				// submit half an address, which is the whole reason a terminal brackets
				// a paste in the first place
				insert(
					[...graphemes(block.replaceAll(pastedBreak, ' '))]
						.filter((cluster) => !controlChar.test(cluster))
						.join('')
				);
				draw();
			},

			settle(answer: string): void {
				answered(mark);
				before.setText('');
				caret.setText('');
				caret.setProps({ class: '' });
				after.setText(opts.mask === undefined ? answer : opts.mask.repeat(stringWidth(answer)));
				after.setProps({ class: 'sigil-prompt-answer' });
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
 * Asks a yes or no question.
 *
 * @param opts - What to ask.
 * @returns The answer.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
	const fallback = opts.default ?? true;

	return run<boolean>(opts, () => {
		const tail = textNode(`(${fallback ? 'Y/n' : 'y/N'})`, { class: 'sigil-prompt-hint' });
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
				tail.setProps({ class: 'sigil-prompt-answer' });
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
			class: 'sigil-choice-hint',
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
			class: here ? 'sigil-choice is-active' : 'sigil-choice',
			display: i >= start && i < start + visible ? 'flex' : 'none',
		});
		if (ticked) {
			const on = ticked.has(i);
			row.mark.setText(on ? SYMBOL.on : SYMBOL.off);
			row.mark.setProps({ class: on ? 'sigil-choice-mark is-on' : 'sigil-choice-mark' });
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
		const answer = textNode('', { class: 'sigil-prompt-answer', display: 'none' });
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
		const hint = textNode('(space to select, enter to confirm)', { class: 'sigil-prompt-hint' });
		const head = headWidths(opts.message, Math.max(1, terminal.width));
		const { line, mark } = promptHead(opts.message, head.message, hint);
		const { list, rows } = choiceRows(choices, true);
		const complaint = note('sigil-prompt-error');
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
				hint.setProps({ class: 'sigil-prompt-answer' });
				list.setProps({ display: 'none' });
				setNote(complaint, undefined);
			},

			view,
		};
	});
}
