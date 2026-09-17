import { stringWidth } from '../width/index.js';
import { createSgrState, type SgrState } from './sgr-state.js';
import { type Token, tokenize } from './tokens.js';

export { createSgrState, type SgrState } from './sgr-state.js';
export { type Token, tokenize } from './tokens.js';

/** What a terminal is assumed to be when there is no terminal to ask. */
export const DEFAULT_WIDTH = 80;

/**
 * How wide generated output is allowed to get.
 *
 * A line of prose is hard to read much past this, and a maximized window on a
 * wide display is three times it -- so a terminal's width is a ceiling on how
 * much room there is, not an instruction to use all of it.
 */
export const MAX_WIDTH = 100;

export interface TerminalWidthOptions {
	/** The environment to read `COLUMNS` from. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** What to use when there is nothing to ask. Defaults to 80. */
	fallback?: number;
	/** The widest result. Defaults to 100; pass `Infinity` for no cap. */
	max?: number;
	/** The stream to measure. Defaults to `process.stdout`. */
	stream?: { columns?: number };
}

/**
 * How many columns there are to write into.
 *
 * `process.stdout.columns` is the answer when there is a terminal. When there is
 * not -- a pipe, a file, a CI log -- there is no width to detect, and 80 is the
 * convention for what to assume.
 *
 * `COLUMNS` is read first, because it is how a caller says what to use when the
 * stream cannot be asked, and how a test says it without a pseudo-terminal.
 *
 * @param opts - Where to read the width from.
 * @returns The number of columns.
 */
export function terminalWidth(opts: TerminalWidthOptions = {}): number {
	const env = opts.env ?? process.env;
	const stream = 'stream' in opts ? opts.stream : process.stdout;

	// a cap or a fallback that is not a width is no instruction at all, and
	// carrying it through would come back out as the answer
	const max = opts.max !== undefined && opts.max > 0 ? opts.max : MAX_WIDTH;
	const fallback = positive(opts.fallback) ?? DEFAULT_WIDTH;

	const columns = positive(env.COLUMNS) ?? positive(stream?.columns) ?? fallback;

	return Math.min(columns, max);
}

/**
 * A column count, or `undefined` for anything that is not one. A stream that is
 * not a terminal reports no columns at all, and `COLUMNS` is whatever some shell
 * happened to export.
 *
 * @param value - The value to read.
 * @returns The count, when it is one.
 */
function positive(value: string | number | undefined): number | undefined {
	if (typeof value === 'string') {
		// the whole string, not as much of it as parses: `COLUMNS=12junk` is not
		// somebody saying twelve
		return /^\s*\d+\s*$/.test(value) ? positive(Number(value)) : undefined;
	}

	return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export interface WrapOptions {
	/**
	 * Whether to break a word too long for a line of its own. On by default: a
	 * path or a URL longer than the terminal is wide is the case that makes this
	 * matter, and letting it run past the edge is what wrapping was supposed to
	 * prevent. Off, such a word overflows on a line of its own.
	 */
	hard?: boolean;
	/**
	 * Added to every line after the first, on top of `indent`. This is the
	 * hanging indent a two-column list is made of: the first line carries the
	 * term, and what wraps under it lines up with the definition.
	 *
	 * The first line means the first line of the output, not the first line of
	 * each paragraph. The term it hangs from is printed once, so everything
	 * under it lines up -- including what follows a newline already in the text.
	 */
	hangingIndent?: number | string;
	/** Added to the front of every line. Counts against the width. */
	indent?: number | string;
	/** The column to wrap at. Defaults to `terminalWidth()`. */
	width?: number;
}

/**
 * Wraps text to a column count, keeping the styling and the characters intact.
 *
 * Three things make this more than splitting on spaces:
 *
 * - A break may not fall inside an escape sequence or inside a grapheme
 *   cluster. Both are found rather than assumed, so a flag emoji and a
 *   `ESC[38;2;...m` each come out whole.
 * - A style open at a break is closed at the end of that line and opened again
 *   on the next, so nothing bleeds into an indent or into whatever reads the
 *   output a line at a time.
 * - A column is not a character. `日本語` is three characters and
 *   six columns, and wrapping to the wrong one of those is how a table stops
 *   lining up.
 *
 * Newlines already in the text are kept, each line wrapped on its own, and the
 * styling carries across them. A tab is treated as one space: how wide a tab is
 * depends on the column it lands in, and wrapping is the thing that moves it.
 *
 * Trailing whitespace is dropped from every line, including a line that did not
 * need wrapping. A terminal draws nothing for it, it is what a break at a space
 * would leave behind anyway, and leaving it makes a measured line wider than
 * what anybody can see. Leading whitespace is kept: that is indentation.
 *
 * @param text - The text to wrap.
 * @param opts - The width to wrap at, or the options.
 * @returns The wrapped text.
 */
export function wrap(text: string, opts: WrapOptions | number = {}): string {
	const settings = typeof opts === 'number' ? { width: opts } : opts;
	const { hard = true, hangingIndent = 0, indent = 0 } = settings;

	const first = prefix(indent);
	const rest = first + prefix(hangingIndent);
	const limit = settings.width ?? terminalWidth();

	// an indent as wide as the width leaves nowhere to put the text, and one
	// column is the least that can hold anything
	const firstRoom = Math.max(limit - stringWidth(first), 1);
	const restRoom = Math.max(limit - stringWidth(rest), 1);

	// the styling carries across the newlines already in the text, so one state
	// walks the whole thing rather than one per line
	const state = createSgrState();
	const lines: string[] = [];

	for (const line of text.split(/\r?\n/)) {
		wrapLine(
			tokenize(line),
			lines.length === 0 ? firstRoom : restRoom,
			restRoom,
			hard,
			state,
			lines
		);
	}

	return lines
		.map((line, index) => (line === '' ? '' : (index === 0 ? first : rest) + line))
		.join('\n');
}

/**
 * Wraps one line of the input into one or more output lines.
 *
 * A sequence takes effect on the state when it is committed to a line rather
 * than when it is read, which is what keeps a break honest. Reading ahead and
 * applying as it went would mean closing a line with the styling from further
 * along it: a word carrying `ESC[39m` would have turned the foreground off
 * before the line that still has it open got to close it.
 *
 * @param tokens - The line's tokens.
 * @param first - The room on the first output line.
 * @param rest - The room on the lines after it.
 * @param hard - Whether to break a word too long for a line.
 * @param state - The styling in effect, carried in and out.
 * @param lines - The output lines to append to.
 */
function wrapLine(
	tokens: Token[],
	first: number,
	rest: number,
	hard: boolean,
	state: SgrState,
	lines: string[]
): void {
	let room = first;
	let used = 0;
	let content = '';
	// whether the output line being built is also the start of the input line.
	// Leading spaces there are the text's own indentation and are kept; the same
	// spaces after a break are what the break left behind, and are dropped.
	let atLineStart = true;
	// captured when the line takes its first token, because that is when the
	// styling it has to reopen is known. A line with no content opens nothing and
	// closes nothing.
	let opened = '';
	let started = false;

	// read but not committed: the spaces between two words, and any sequences
	// among them. A break here drops the spaces; the sequences are dropped from
	// the output too, because opening the next line from the state is what puts
	// them back.
	let pending: Token[] = [];
	let pendingWidth = 0;

	// the word being read. Sequences inside it travel with it, so a word that
	// moves to the next line takes its own styling along.
	let word: Token[] = [];
	let wordWidth = 0;

	/** Writes tokens to the current line, and lets their styling take effect. */
	const emit = (list: Token[]) => {
		for (const token of list) {
			if (!started) {
				opened = state.open();
				started = true;
			}
			content += token.text;
			used += token.width;
			if (token.type === 'sequence') {
				state.apply(token.text);
			}
		}
	};

	/** Ends the current line, closing whatever it left open. */
	const endLine = () => {
		lines.push(started ? opened + content + state.close() : '');
		content = '';
		opened = '';
		started = false;
		used = 0;
		room = rest;
		atLineStart = false;
	};

	/**
	 * Throws away the pending run, keeping the effect of the sequences in it: the
	 * text they styled is not being written here, but they still happened.
	 */
	const dropPending = () => {
		for (const token of pending) {
			if (token.type === 'sequence') {
				state.apply(token.text);
			}
		}
		pending = [];
		pendingWidth = 0;
	};

	/** Writes a word too long for one line, breaking between clusters. */
	const emitBroken = () => {
		for (const token of word) {
			if (used > 0 && used + token.width > room) {
				endLine();
			}
			emit([token]);
		}
	};

	const placeWord = () => {
		if (word.length === 0) {
			return;
		}

		if (used + pendingWidth + wordWidth <= room) {
			emit(pending);
			emit(word);
		} else if (used > 0) {
			// there is something to break away from, so the word moves down whole
			endLine();
			dropPending();
			if (hard && wordWidth > room) {
				emitBroken();
			} else {
				emit(word);
			}
		} else if (atLineStart && pendingWidth > 0) {
			// the spaces in front of the first word of the input line are the text's
			// own indentation, so they are kept even though the word does not fit
			// beside them
			emit(pending);
			pending = [];
			pendingWidth = 0;
			if (hard && used + wordWidth > room) {
				emitBroken();
			} else {
				emit(word);
			}
		} else {
			// already at the start of a line: no break will help, so the word is
			// either split or allowed to run over
			dropPending();
			if (hard && wordWidth > room) {
				emitBroken();
			} else {
				emit(word);
			}
		}

		pending = [];
		pendingWidth = 0;
		word = [];
		wordWidth = 0;
	};

	for (const token of tokens) {
		if (token.type === 'sequence') {
			if (word.length === 0) {
				pending.push(token);
			} else {
				word.push(token);
			}
			continue;
		}

		if (token.text === ' ' || token.text === '\t') {
			placeWord();
			// a tab counts as one space and is written as one, so that what was
			// measured is what comes out
			pending.push({ text: ' ', type: 'cluster', width: 1 });
			pendingWidth += 1;
			continue;
		}

		word.push(token);
		wordWidth += token.width;
	}

	placeWord();

	// the sequences that came after the last word. They are written as they were
	// and they are not closed: they are how the text ends, and closing them would
	// be inventing something the text never said. Dropping them would be worse --
	// a caller joining wrapped pieces would lose the styling the next piece was
	// meant to inherit.
	const trailing = pending
		.filter((token) => token.type === 'sequence')
		.map((token) => token.text)
		.join('');

	// read before the trailing sequences take effect, because they are written
	// after it: the close is only for what they do not turn off themselves, and a
	// text ending in its own close does not need a second one
	const closing = state.close();
	dropPending();

	lines.push(
		started || trailing !== '' ? opened + content + (state.active ? closing : '') + trailing : ''
	);
}

/**
 * Reads an indent, which may be a count of spaces or the string to use.
 *
 * @param indent - The count or the string.
 * @returns The prefix.
 */
function prefix(indent: number | string): string {
	return typeof indent === 'number' ? ' '.repeat(Math.max(indent, 0)) : indent;
}
