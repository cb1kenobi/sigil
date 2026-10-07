/**
 * A command palette: the command registry, filtered.
 *
 * The whole of what makes this cheap is that there is no second catalog --
 * `commandCatalog()` reads the registries the parser already built, exactly as
 * help reads the context chain rather than a separate list of what a command
 * inherits. What is left here is the part that is genuinely a component: a filter
 * field, a ranked list, and the prompts that collect whatever the chosen command
 * needs before it can run.
 *
 * It resolves with an **argv** rather than running anything. Running a selection
 * is dispatching a command, which `main()` already does, so the palette's answer
 * is the argv a person would have typed:
 *
 * ```js
 * const chosen = await commandPalette(state);
 * if (chosen) {
 *   await main({ argv: chosen.argv, schema });
 * }
 * ```
 *
 * That is also the rule the value prompts follow: the palette types what you
 * would have typed, and the parser is the one thing that decides what a value
 * means. Nothing here coerces a value into argv -- `checkSlotValue()` runs
 * `transformValue()` to find out whether the parser *will* accept what was typed,
 * and then the string goes through untouched, so there is one producer of every
 * value and one definition of what a valid one is.
 */

import { box, type Element, text as textNode, toDisplayText } from '../element/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { transformValue } from '../util/transform.js';
import {
	type CatalogOptions,
	type CatalogTarget,
	commandCatalog,
	type PaletteEntry,
	type PaletteSlot,
	slotTokens,
} from './catalog.js';
import { boundary, deleteAfter, deleteBefore, insertAt, pastedLine, typedText } from './editing.js';
import { highlightRuns, type Ranked, rankBy } from './fuzzy.js';
import {
	type Choice,
	confirm,
	listWindow,
	multiline,
	multiselect,
	PROMPT_SYMBOLS,
	promptAnswered,
	promptHeadLine,
	promptHeadWidths,
	type PromptOptions,
	promptWindow,
	runPrompt,
	select,
	text,
} from './prompt.js';

export interface PaletteOptions extends Omit<PromptOptions, 'message'>, CatalogOptions {
	/** What is being asked. Defaults to `Run a command`. */
	message?: string;
	/**
	 * Whether to ask for the values the chosen command needs. Defaults to `true`.
	 *
	 * Turned off, the answer is the command's path and nothing else, which is
	 * what a caller that wants to collect the values itself -- or to fill them in
	 * from somewhere that is not a person -- asks for.
	 */
	prompt?: boolean;
	/**
	 * How many rows the list may take. Defaults to what the terminal has left
	 * under the question.
	 */
	rows?: number;
}

/** What the palette answered. */
export interface PaletteResult {
	/** The argv a person would have typed, from the root. */
	readonly argv: string[];
	/** The command that was chosen. */
	readonly entry: PaletteEntry;
	/** What each slot was answered with, in the order the slots are listed. */
	readonly values: readonly (readonly string[])[];
}

/** What an optional list of allowed values offers in place of none of them. */
const SKIP = '(skip)';

/**
 * How a value is spelled as an argv token.
 *
 * A `choices` list holds whatever the declaration wrote, which may not be a
 * string -- and what reaches argv always is. A primitive goes through `String()`
 * and an object through `JSON.stringify()`, which is what makes an object choice
 * on a `json` declaration round-trip. Whether it round-trips at all is the app's
 * to get right and not this function's to second-guess: a `string` declaration
 * with `choices: [1]` rejects `--level=1` from a command line too, because the
 * parser compares the *coerced* value, and the palette types what you would have
 * typed.
 *
 * @param value - A declared choice.
 * @returns The token.
 */
function tokenOf(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value !== null && typeof value === 'object') {
		return JSON.stringify(value) ?? String(value);
	}
	return String(value);
}

/** A token `optionLikeRE` would read as an option rather than as a value. */
const OPTION_LIKE_RE = /^--?\w/;

/**
 * Whether the parser will take what was typed, and why not when it will not.
 *
 * This is the one place the palette asks anything about a value, and it asks it
 * with `transformValue()` -- the function the parser itself coerces with -- so
 * there is one answer to "is this a valid value" rather than a second validator
 * that drifts from the first. What it does **not** do is keep the coerced value:
 * the string goes into argv and the parser coerces it again, which is what keeps
 * the parser the only producer.
 *
 * `choices` is compared against the coerced value, which is what `assertChoices()`
 * does. That means a `date` declaration with `choices` can never match, because
 * `includes()` compares `Date` objects by identity -- true of a command line too,
 * and being wrong in the same way is the point.
 *
 * A positional value the parser would read as an **option** is refused, and that
 * is not a rule this invents: `optionLikeRE` is `/^--?\w/`, so `-5` and `-foo`
 * reach the parser as options whatever slot they were meant for, and a command
 * line cannot express them either -- `--` makes what follows it an extra argument
 * rather than a positional one. Accepting such a value would be handing the
 * parser an argv it misroutes, which is the divergence the whole design is
 * written against.
 *
 * @param slot - What is being asked for.
 * @param value - What was typed.
 * @returns A complaint, or nothing when the value is good.
 */
export function checkSlotValue(slot: PaletteSlot, value: string): string | undefined {
	if (value === '') {
		return slot.required ? `${slot.label} needs a value` : undefined;
	}

	if (slot.spelling === undefined && OPTION_LIKE_RE.test(value)) {
		return `${slot.label} cannot be given "${value}": the parser reads it as an option`;
	}

	let coerced: unknown;
	try {
		coerced = transformValue(value, slot.type);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}

	if (slot.choices && !slot.choices.includes(coerced)) {
		return `Invalid value "${value}" for ${slot.label}`;
	}
}

/** What a slot's prompt says, on one line. */
function slotMessage(slot: PaletteSlot): string {
	// through `toDisplayText()` with the newlines taken out, because a `desc` is
	// prose an app wrote and a prompt's head is one line: a tab measures nothing
	// and draws a space, so measuring the raw string would leave the field a
	// column out per tab
	const hint = slot.desc ? `${slot.label} -- ${slot.desc}` : slot.label;
	return toDisplayText(hint).replaceAll('\n', ' ');
}

/**
 * Asks for one slot's values.
 *
 * Which prompt depends on what the declaration says, and the rule is one
 * sentence: an optional slot always gets a prompt that can be left empty.
 *
 * - `choices`, one value: `select()`, with a `(skip)` entry in front of them when
 *   the slot is optional, because a list of allowed values has no way to say
 *   "none of them" otherwise.
 * - `choices`, many values: `multiselect()`, which is empty-able already.
 * - `bool` or `yesno`, one value, required: `confirm()`, which is the question
 *   somebody means. Optional, it is a text field instead, since a confirm always
 *   answers and would make the declaration's own default unreachable. The token
 *   is `true`/`false` for `bool` and `yes`/`no` for `yesno`, because those are
 *   the words each type's own vocabulary takes -- `transformValue('true',
 *   'yesno')` throws, which is the sharp edge of sharing one function.
 * - many values, no `choices`: `multiline()`, one value per line. Splitting one
 *   answer on whitespace was the other option and it cannot express a value with
 *   a space in it; a line each can. A value containing a newline is what this
 *   cannot express, which is the smaller loss.
 * - anything else: `text()`, validated with `checkSlotValue()`.
 *
 * @param slot - What to ask for.
 * @param opts - Where to read and draw.
 * @returns The values, which is an empty list for a slot that was skipped.
 */
async function askSlot(slot: PaletteSlot, opts: PaletteOptions): Promise<string[]> {
	const message = slotMessage(slot);
	const shared = { ...opts, message };

	if (slot.choices) {
		const offered: Choice<string | undefined>[] = slot.choices.map((choice) => {
			const token = tokenOf(choice);
			return { label: token, value: token };
		});

		if (slot.multiple) {
			const picked = await multiselect<string | undefined>({
				...shared,
				choices: offered,
				required: slot.required,
			});
			return picked.filter((value): value is string => value !== undefined);
		}

		const picked = await select<string | undefined>({
			...shared,
			choices: slot.required ? offered : [{ label: SKIP, value: undefined }, ...offered],
		});
		return picked === undefined ? [] : [picked];
	}

	if (slot.multiple) {
		// a required variadic slot is asked again when it comes back with nothing,
		// which is `text()`'s own validate loop one level up: a multiline field has
		// no `validate`, and a loop a person ends by answering properly is the same
		// shape as the one `text()` already has
		for (;;) {
			const block = await multiline({ ...shared, message: `${message} (one per line)` });
			const values = block
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line !== '');

			if (values.length === 0) {
				if (!slot.required) {
					return [];
				}
				continue;
			}

			if (!values.some((value) => checkSlotValue(slot, value) !== undefined)) {
				return values;
			}
		}
	}

	if (slot.required && (slot.type === 'bool' || slot.type === 'yesno')) {
		const yes = await confirm(shared);
		return [slot.type === 'yesno' ? (yes ? 'yes' : 'no') : yes ? 'true' : 'false'];
	}

	const answer = await text({
		...shared,
		validate: (value) => checkSlotValue(slot, value),
	});

	return answer === '' ? [] : [answer];
}

/**
 * Asks for everything the chosen command needs.
 *
 * Positional arguments stop at the first one left empty, because a positional
 * slot cannot be skipped over: `initArgs()` already promotes an optional argument
 * sitting before a required one, so once one is left out every argument after it
 * is optional too and leaving them out is the only coherent reading. The option
 * slots are not positional and are asked for either way.
 *
 * @param entry - The chosen command.
 * @param opts - Where to read and draw.
 * @returns What each slot was answered with.
 */
async function askSlots(entry: PaletteEntry, opts: PaletteOptions): Promise<string[][]> {
	const values: string[][] = [];
	let stopPositional = false;

	for (const slot of entry.slots) {
		const positional = slot.spelling === undefined;

		if (positional && stopPositional) {
			values.push([]);
			continue;
		}

		const answered = await askSlot(slot, opts);
		values.push(answered);

		// `positional &&` here is **declared** rather than pinned: an option slot
		// is always required and a required slot is never answered empty -- every
		// prompt `askSlot()` reaches for one either validates against empty or
		// cannot produce it -- so the conjunct cannot fire today. It is written
		// because the rule is about *positions*, and "any empty answer stops the
		// rest" is a different rule that happens to agree
		if (positional && answered.length === 0) {
			stopPositional = true;
		}
	}

	return values;
}

/** One row of the list, and the elements the filter rewrites. */
interface PaletteRow {
	/** The box holding the highlight runs. */
	readonly label: Element;
	/** The pointer column, reserved on every row. */
	readonly pointer: Element;
	/** The row. */
	readonly row: Element;
}

/**
 * Builds a row per entry, once.
 *
 * One element per catalog entry rather than a list rebuilt per keystroke, for
 * `For`'s own reason: a row that is still in the list is the same row, so keeping
 * it keeps its resolved style and its text measurement, both of which are keyed
 * on the style object and are worth nothing to a fresh element. What the filter
 * moves is the `order` property, which the layout engine reads: `order` changes
 * where a child is placed and not where it lives, so `result.children[i]` still
 * answers for `node.children[i]` and nothing above has to match a box back to a
 * row that moved.
 *
 * @param entries - The catalog.
 * @returns The list, and a row per entry in the same order.
 */
function paletteRows(entries: readonly PaletteEntry[]): { list: Element; rows: PaletteRow[] } {
	const rows = entries.map((entry) => {
		// the pointer is on every row and `visibility` takes it off the ones that
		// are not active, because hidden content still takes its space: a text of
		// one space would measure nothing at all, since `white-space: normal`
		// collapses a run of them, and every inactive label would sit one column
		// left of the active one
		const pointer = textNode(PROMPT_SYMBOLS.cursor, {
			class: 'sigil-palette-pointer',
			'margin-right': 1,
			visibility: 'hidden',
			'white-space': 'nowrap',
		});
		const label = box({ class: 'sigil-palette-label', 'flex-shrink': 0 });
		const desc = textNode(entry.desc ?? '', {
			class: 'sigil-palette-desc sigil-muted',
			display: entry.desc ? 'flex' : 'none',
			'margin-left': 2,
			// a row is one line, so a description too long for what is left of it is
			// cut rather than wrapped -- which is what `text-overflow` is for, and it
			// bites only on a line that does not fit. `min-width: 0` is what lets the
			// column shrink at all: a text's automatic minimum is content-based, and
			// a declaration is the only thing that beats it
			'min-width': 0,
			'text-overflow': 'ellipsis',
			'white-space': 'nowrap',
		});

		return {
			label,
			pointer,
			row: box({ class: 'sigil-palette-row', display: 'none' }, pointer, label, desc),
		};
	});

	return {
		list: box(
			{ class: 'sigil-palette-list', 'flex-direction': 'column', 'padding-left': 2 },
			...rows.map(({ row }) => row)
		),
		rows,
	};
}

/**
 * Rewrites a row's label into the runs a match highlights.
 *
 * The runs come from `highlightRuns()`, which builds them over grapheme
 * clusters -- so a run is always something a cell can hold. A lone combining
 * mark in a `text` of its own measures zero columns and the grid refuses it a
 * cell, which would lose the character the highlight was drawing attention to.
 *
 * Rebuilt rather than restyled, because how many runs there are depends on the
 * query. Only a row that is on screen is rewritten: the rest are `display: none`
 * and are neither measured nor painted, so what they are holding cannot be seen.
 *
 * @param label - The box to fill.
 * @param shown - What is shown.
 * @param matched - Which of its code points matched.
 */
function paintLabel(label: Element, shown: string, matched: readonly number[]): void {
	// from the front rather than over a copy of the list: `children` is the live
	// array, so iterating it while removing from it skips every other child
	while (label.children.length > 0) {
		label.removeChild(label.children[0] as Element);
	}

	for (const run of highlightRuns(shown, matched)) {
		label.append(
			textNode(run.text, {
				class: run.on ? 'sigil-palette-match sigil-heading' : '',
				'white-space': 'nowrap',
			})
		);
	}
}

/**
 * The command palette.
 *
 * Reads the registries, ranks them against what is typed, and answers with the
 * argv that runs what was chosen. Escape closes it and answers with nothing,
 * which is not an error: a palette is a thing you dismiss. Ctrl-C is still the
 * abort every prompt takes, because an app that cannot be quit because a filter
 * field swallowed it is the failure the binding order exists to prevent.
 *
 * @param target - The parse state, or anything carrying a context chain.
 * @param opts - What to ask, what to leave out, and where to draw.
 * @returns The chosen command and its argv, or nothing when it was dismissed.
 */
export async function commandPalette(
	target: CatalogTarget,
	opts: PaletteOptions = {}
): Promise<PaletteResult | undefined> {
	const entries = commandCatalog(target, opts);
	const message = opts.message ?? 'Run a command';
	const entry = await runList(entries, { ...opts, message });

	if (!entry) {
		return undefined;
	}

	const values =
		opts.prompt === false ? entry.slots.map(() => [] as string[]) : await askSlots(entry, opts);

	const argv = [...entry.path];
	for (const [i, slot] of entry.slots.entries()) {
		argv.push(...slotTokens(slot, values[i] ?? []));
	}

	return { argv, entry, values };
}

/** The filter field and the ranked list, as one prompt. */
function runList(
	entries: readonly PaletteEntry[],
	opts: PaletteOptions & { message: string }
): Promise<PaletteEntry | undefined> {
	const terminal = opts.terminal ?? defaultTerminal;
	// where each entry's row is, so that moving a row is a lookup rather than a
	// scan: `draw()` runs per keystroke and an `indexOf()` in it is the catalog
	// walked once per row
	const at = new Map(entries.map((entry, i) => [entry, i]));
	let value = '';
	let cursor = 0;
	let active = 0;
	let start = 0;

	return runPrompt<PaletteEntry | undefined>(opts, () => {
		const before = textNode('', { 'white-space': 'nowrap' });
		const caret = textNode('', { class: 'sigil-caret', 'white-space': 'nowrap' });
		const after = textNode('', { 'white-space': 'nowrap' });
		const field = box({ class: 'sigil-prompt-field' }, before, caret, after);
		const answer = textNode('', { class: 'sigil-prompt-answer sigil-muted', display: 'none' });
		const head = promptHeadWidths(opts.message, Math.max(1, terminal.width));
		const { line, mark } = promptHeadLine(opts.message, head.message, field, answer);
		const { list, rows } = paletteRows(entries);
		const empty = textNode('No commands match', {
			class: 'sigil-palette-empty sigil-muted',
			display: 'none',
			'padding-left': 2,
		});
		const view = box({ class: 'sigil-palette', 'flex-direction': 'column' }, line, list, empty);

		/** What the query ranked to, rebuilt whenever anything moves. */
		let shown: Ranked<PaletteEntry>[] = [];

		/** The rows the list has, once the question has taken its own. */
		const room = (): number => Math.max(1, opts.rows ?? Math.max(1, terminal.height) - head.lines);

		function draw(): void {
			shown = rankBy(value, entries, (entry) => entry.search);
			active = Math.min(Math.max(0, active), Math.max(0, shown.length - 1));
			start = listWindow(shown.length, active, room(), start);
			const visible = Math.max(1, Math.min(room(), shown.length));

			// every row goes off first, because a row the query no longer matches is
			// not in the list below and would otherwise keep the place it had
			for (const { pointer, row } of rows) {
				row.setProps({ class: 'sigil-palette-row', display: 'none', order: 0 });
				pointer.setProps({ visibility: 'hidden' });
			}

			for (const [rank, { item, match }] of shown.entries()) {
				const here = rows[at.get(item) as number] as PaletteRow;
				const on = rank >= start && rank < start + visible;
				const current = rank === active;

				here.row.setProps({
					class: current ? 'sigil-palette-row is-active sigil-accent' : 'sigil-palette-row',
					display: on ? 'flex' : 'none',
					order: rank,
				});
				here.pointer.setProps({ visibility: current ? 'visible' : 'hidden' });

				// a **fast path**, declared: a row that is `display: none` is neither
				// measured nor painted, so what it holds cannot be seen and
				// rewriting it changes no answer. What it buys is that a keystroke
				// rebuilds the runs of the rows on screen rather than of the whole
				// catalog
				if (on) {
					paintLabel(here.label, item.label, match.matched);
				}
			}

			empty.setProps({ display: shown.length === 0 ? 'flex' : 'none' });

			const pane = promptWindow(value, cursor, head.rest);
			before.setText(pane.before);
			// past the last character there is nothing to mark, so the caret is a
			// column of its own rather than a mark on one
			caret.setText(pane.under || ' ');
			after.setText(pane.after);
		}

		draw();

		/** Types text in at the cursor, which is what a key and a paste both are. */
		function insert(input: string): void {
			({ cursor, value } = insertAt(value, cursor, input));
			// a new query is a new list, so the highlight goes back to the top: the
			// row that was active is very likely not in it, and keeping an index
			// would land on whatever the new ranking put there
			active = 0;
		}

		return {
			key(k) {
				if (k.name === 'escape') {
					return { value: undefined };
				}
				if (k.name === 'enter') {
					// a list with nothing in it has nothing to answer with, so Enter
					// does nothing rather than resolving with a row that is not there
					const chosen = shown[active];
					if (chosen) {
						return { value: chosen.item };
					}
				} else if (k.name === 'up') {
					// wrapping, for `select()`'s reason: a list you cannot get to the
					// end of by going up is one you have to know the length of
					active = shown.length === 0 ? 0 : (active - 1 + shown.length) % shown.length;
				} else if (k.name === 'down') {
					active = shown.length === 0 ? 0 : (active + 1) % shown.length;
				} else if (k.name === 'pageup') {
					active = Math.max(0, active - Math.max(1, room() - 1));
				} else if (k.name === 'pagedown') {
					active = Math.min(Math.max(0, shown.length - 1), active + Math.max(1, room() - 1));
				} else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
					cursor = 0;
				} else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
					cursor = value.length;
				} else if (k.name === 'backspace') {
					({ cursor, value } = deleteBefore(value, cursor));
					active = 0;
				} else if (k.name === 'delete') {
					({ cursor, value } = deleteAfter(value, cursor));
					active = 0;
				} else if (k.name === 'left') {
					cursor = boundary(value, cursor, -1);
				} else if (k.name === 'right') {
					cursor = boundary(value, cursor, 1);
				} else if (k.ctrl && k.name === 'u') {
					value = value.slice(cursor);
					cursor = 0;
					active = 0;
				} else {
					// a printable key, and `typedText()` is what decides whether this
					// was one: a character arrives with its name and its sequence the
					// same string, while a named key's name is one the terminal never
					// sent. What is inserted is the sequence rather than the name.
					//
					// Asked before inserting rather than inserting whatever it answered,
					// because `insert()` puts the highlight back to the top: a key this
					// field has no use for -- a function key, an unrecognised sequence
					// -- would otherwise move the selection while changing nothing on
					// screen that says why
					const typed = typedText(k);
					if (typed !== undefined) {
						insert(typed);
					}
				}

				draw();
			},

			paste(block: string): void {
				// a one-line filter, so a pasted block's line breaks are flattened --
				// the same answer `text()` gives, and the opposite of the multiline
				// field's, which is the pair `editing.ts` keeps side by side
				insert(pastedLine(block));
				draw();
			},

			settle(chosen): void {
				promptAnswered(mark);
				before.setText('');
				caret.setText('');
				caret.setProps({ class: '' });
				after.setText('');
				answer.setText(chosen ? chosen.label : '(dismissed)');
				answer.setProps({ display: 'flex' });
				// the list goes: what is left is the question and its answer, which is
				// the one line worth keeping in a log
				list.setProps({ display: 'none' });
				empty.setProps({ display: 'none' });
			},

			view,
		};
	});
}
