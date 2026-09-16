import { ansi as defaultAnsi, type Ansi } from '../ansi/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { createLiveRegion, type LiveRegion } from '../terminal/live.js';
import { stringWidth } from '../width/index.js';
import { decodeKeys, isAbort, type Key } from './keys.js';
import { StringDecoder } from 'node:string_decoder';

/**
 * Only what a prompt asks of an input stream.
 *
 * Events rather than async iteration, which is not a style preference: leaving a
 * `for await (const chunk of stdin)` loop calls the iterator's `return()`, and
 * Node's implementation of that *destroys* the stream. Destroying
 * `process.stdin` leaves the next prompt with nothing to read, and the one that
 * did it exits through an `AbortError` rather than with its answer.
 */
export interface PromptInput {
	isTTY?: boolean;
	off?(event: string, listener: (...args: unknown[]) => void): unknown;
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	pause?(): unknown;
	removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
	resume?(): unknown;
}

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

export interface PromptOptions {
	/** The styler to mark up with. Defaults to the process's. */
	ansi?: Ansi;
	/** What is being asked. */
	message: string;
	/** The region to draw in. One is made if not given. */
	region?: LiveRegion;
	/** Where keys come from. Defaults to the terminal's input. */
	stdin?: PromptInput;
	/** The terminal to draw through. Defaults to the process's. */
	terminal?: Terminal;
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

/**
 * Runs a prompt: raw mode on, keys in, frames out, and everything put back
 * whichever way it ends.
 *
 * @param opts - Where to read and draw.
 * @param handlers - How to draw, and what each key does.
 * @returns The answer.
 */
function run<T>(
	opts: PromptOptions,
	handlers: {
		/** The frame to draw. */
		draw: () => string;
		/** The line left behind once it is answered. */
		final: (value: T) => string;
		/** Handles a key. Returning `{ value }` finishes. */
		key: (k: Key) => Promise<{ value: T } | void> | ({ value: T } | void);
	}
): Promise<T> {
	const terminal = opts.terminal ?? opts.region?.terminal ?? defaultTerminal;
	const region = opts.region ?? createLiveRegion({ terminal });
	const stdin = (opts.stdin ?? terminal.stdin) as PromptInput | undefined;

	// nobody is there to answer, and waiting on a stdin that will never produce a
	// keystroke is a hung build with no explanation. The message names the prompt,
	// because "no TTY" on its own does not say which question went unanswered
	if (!terminal.isTTY || !stdin?.isTTY) {
		return Promise.reject(
			new PromptError(`Cannot prompt for "${opts.message}" because the input is not a terminal`)
		);
	}

	terminal.setRawMode(true);
	region.render(handlers.draw());

	return new Promise<T>((resolve, reject) => {
		// a decoder of its own rather than `setEncoding()` on the stream: a
		// character may be split across two chunks, and this keeps the half byte
		// without changing what the stream hands anything else that reads it
		const decoder = new StringDecoder('utf8');

		let settled = false;

		// one chunk at a time. `handlers.key` may be async -- a `validate` that asks
		// a server -- and a chunk read while the last one is still being handled
		// would apply its keys to a state that has not caught up
		let queue: Promise<void> = Promise.resolve();

		function detach(): void {
			const off = stdin!.off ?? stdin!.removeListener;
			off?.call(stdin, 'data', onData);
			off?.call(stdin, 'end', onEnd);
			off?.call(stdin, 'error', onError);

			// the stream is left as it was found: paused, undestroyed, and readable
			// by whatever reads it next
			stdin!.pause?.();
			terminal.setRawMode(false);
		}

		function fail(err: unknown): void {
			if (!settled) {
				settled = true;
				detach();
				region.stop();
				reject(err);
			}
		}

		function succeed(value: T): void {
			if (!settled) {
				settled = true;
				detach();
				region.done(handlers.final(value));
				resolve(value);
			}
		}

		function onData(...args: unknown[]): void {
			const chunk = args[0] as string | Uint8Array;

			queue = queue
				.then(async () => {
					if (settled) {
						return;
					}

					const input = typeof chunk === 'string' ? chunk : decoder.write(Buffer.from(chunk));

					for (const k of decodeKeys(input)) {
						if (settled) {
							return;
						}

						if (isAbort(k)) {
							fail(new PromptError('Cancelled', true));
							return;
						}

						const done = await handlers.key(k);
						if (done) {
							succeed(done.value);
							return;
						}
					}

					if (!settled) {
						region.render(handlers.draw());
					}
				})
				.catch(fail);
		}

		function onEnd(): void {
			// the same nobody-is-there problem as the check above, arriving later
			fail(new PromptError('Input ended before the prompt was answered'));
		}

		function onError(...args: unknown[]): void {
			fail(args[0]);
		}

		stdin.on('data', onData);
		stdin.on('end', onEnd);
		stdin.on('error', onError);
		stdin.resume?.();
	});
}

/**
 * Asks for a line of text.
 *
 * @param opts - What to ask, and how to check the answer.
 * @returns What was typed, or the default.
 */
export function text(opts: TextOptions): Promise<string> {
	const ansi = opts.ansi ?? defaultAnsi;
	let value = '';
	let cursor = 0;
	let error: string | undefined;

	function shown(): string {
		if (opts.mask !== undefined) {
			return opts.mask.repeat(stringWidth(value));
		}
		return value;
	}

	function draw(): string {
		const head = `${ansi.cyan(SYMBOL.question)} ${ansi.bold(opts.message)}`;
		const body =
			value === ''
				? opts.placeholder
					? ansi.dim(opts.placeholder)
					: opts.default
						? ansi.dim(opts.default)
						: ''
				: shown();

		return error ? `${head} ${body}\n  ${ansi.red(error)}` : `${head} ${body}`;
	}

	return run<string>(
		{ ...opts },
		{
			draw,
			final: (answer) =>
				`${ansi.green(SYMBOL.question)} ${ansi.bold(opts.message)} ${ansi.dim(
					opts.mask === undefined ? answer : opts.mask.repeat(stringWidth(answer))
				)}`,

			async key(k) {
				error = undefined;

				if (k.name === 'enter') {
					const answer = value === '' ? (opts.default ?? '') : value;
					const failed = await opts.validate?.(answer);
					if (typeof failed === 'string' && failed) {
						error = failed;
						return;
					}
					return { value: answer };
				}

				if (k.name === 'backspace') {
					if (cursor > 0) {
						value = value.slice(0, cursor - 1) + value.slice(cursor);
						cursor--;
					}
					return;
				}

				if (k.name === 'delete') {
					value = value.slice(0, cursor) + value.slice(cursor + 1);
					return;
				}

				if (k.name === 'left') {
					cursor = Math.max(0, cursor - 1);
					return;
				}

				if (k.name === 'right') {
					cursor = Math.min(value.length, cursor + 1);
					return;
				}

				if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
					cursor = 0;
					return;
				}

				if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
					cursor = value.length;
					return;
				}

				if (k.ctrl && k.name === 'u') {
					value = value.slice(cursor);
					cursor = 0;
					return;
				}

				// a printable key, which is anything that named itself rather than a
				// key this knows about. Space is named, and is still a character
				if (!k.ctrl && !k.meta && (k.name === 'space' || stringWidth(k.name) > 0)) {
					const ch = k.name === 'space' ? ' ' : k.name;
					if (ch.length > 0 && ![...'\r\n\t'].includes(ch)) {
						value = value.slice(0, cursor) + ch + value.slice(cursor);
						cursor += ch.length;
					}
				}
			},
		}
	);
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
	const ansi = opts.ansi ?? defaultAnsi;
	const fallback = opts.default ?? true;
	const hint = fallback ? 'Y/n' : 'y/N';

	return run<boolean>(
		{ ...opts },
		{
			draw: () =>
				`${ansi.cyan(SYMBOL.question)} ${ansi.bold(opts.message)} ${ansi.dim(`(${hint})`)}`,
			final: (answer) =>
				`${ansi.green(SYMBOL.question)} ${ansi.bold(opts.message)} ${ansi.dim(
					answer ? 'yes' : 'no'
				)}`,

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
		}
	);
}

/**
 * Draws a list of choices with one of them highlighted.
 *
 * @param choices - The choices.
 * @param active - Which is highlighted.
 * @param ansi - The styler.
 * @param ticked - Which are ticked, for a multiselect.
 * @returns The lines.
 */
function choiceLines<T>(
	choices: readonly Choice<T>[],
	active: number,
	ansi: Ansi,
	ticked?: ReadonlySet<number>
): string {
	return choices
		.map((choice, i) => {
			const here = i === active;
			const pointer = here ? ansi.cyan(SYMBOL.cursor) : ' ';
			const box = ticked ? `${ticked.has(i) ? ansi.green(SYMBOL.on) : SYMBOL.off} ` : '';
			const label = here ? ansi.cyan(choice.label) : choice.label;
			const hint = choice.hint ? ` ${ansi.dim(choice.hint)}` : '';
			return `${pointer} ${box}${label}${hint}`;
		})
		.join('\n');
}

/**
 * Asks for one of a list.
 *
 * @param opts - What to ask and what to offer.
 * @returns The chosen value.
 */
export function select<T = string>(opts: SelectOptions<T>): Promise<T> {
	const ansi = opts.ansi ?? defaultAnsi;
	const choices = opts.choices.map((choice) => toChoice<T>(choice));

	if (!choices.length) {
		return Promise.reject(new PromptError(`"${opts.message}" has no choices to offer`));
	}

	let active = Math.min(Math.max(0, opts.initial ?? 0), choices.length - 1);

	return run<T>(
		{ ...opts },
		{
			draw: () =>
				`${ansi.cyan(SYMBOL.question)} ${ansi.bold(opts.message)}\n${choiceLines(
					choices,
					active,
					ansi
				)}`,
			final: () =>
				`${ansi.green(SYMBOL.question)} ${ansi.bold(opts.message)} ${ansi.dim(
					choices[active].label
				)}`,

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
			},
		}
	);
}

/**
 * Asks for any number of a list.
 *
 * @param opts - What to ask and what to offer.
 * @returns The chosen values, in the order they are listed.
 */
export function multiselect<T = string>(opts: MultiselectOptions<T>): Promise<T[]> {
	const ansi = opts.ansi ?? defaultAnsi;
	const choices = opts.choices.map((choice) => toChoice<T>(choice));

	if (!choices.length) {
		return Promise.reject(new PromptError(`"${opts.message}" has no choices to offer`));
	}

	let active = Math.min(Math.max(0, opts.initial ?? 0), choices.length - 1);
	const ticked = new Set<number>(
		choices.map((choice, i) => (choice.selected ? i : -1)).filter((i) => i >= 0)
	);
	let error: string | undefined;

	function chosen(): T[] {
		return [...ticked].sort((a, b) => a - b).map((i) => valueOf(choices[i]));
	}

	return run<T[]>(
		{ ...opts },
		{
			draw: () => {
				const head = `${ansi.cyan(SYMBOL.question)} ${ansi.bold(opts.message)} ${ansi.dim(
					'(space to select, enter to confirm)'
				)}`;
				const body = choiceLines(choices, active, ansi, ticked);
				return error ? `${head}\n${body}\n  ${ansi.red(error)}` : `${head}\n${body}`;
			},
			final: (values) =>
				`${ansi.green(SYMBOL.question)} ${ansi.bold(opts.message)} ${ansi.dim(
					values.length
						? choices
								.filter((_, i) => ticked.has(i))
								.map((c) => c.label)
								.join(', ')
						: 'none'
				)}`,

			key(k) {
				error = undefined;

				if (k.name === 'enter') {
					if (opts.required && ticked.size === 0) {
						error = 'Choose at least one';
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
			},
		}
	);
}
