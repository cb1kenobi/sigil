/**
 * Turns what a terminal writes to stdin in raw mode into key presses.
 *
 * In raw mode there are no lines and no editing: what arrives is bytes, and one
 * press may be one byte (`a`), two (`ESC` then a letter, for Alt), or a whole
 * escape sequence (`ESC [ A` for Up). Several presses may also arrive in one
 * chunk, which is what a paste is -- so this reads a chunk as a list rather than
 * as a single key.
 *
 * Only the keys a prompt acts on are named. Anything else printable comes
 * through as itself, which is what makes a text prompt work without this
 * knowing about every key on every keyboard.
 */

export interface Key {
	/** True for `Ctrl`, which terminals send as a control byte. */
	ctrl: boolean;
	/** True for `Alt`, which terminals send as a leading `ESC`. */
	meta: boolean;
	/** The key's name: a character, or one of the named keys below. */
	name: string;
	/** Exactly what the terminal sent, for anything that wants to look again. */
	sequence: string;
	/** True only where the terminal actually distinguishes it, such as Shift-Tab. */
	shift: boolean;
}

/**
 * The CSI and SS3 sequences worth naming, keyed by what follows the introducer.
 *
 * A terminal in application cursor mode sends `ESC O A` for Up where one in
 * normal mode sends `ESC [ A`, and both are common enough that both are here.
 */
const SEQUENCES: Record<string, string> = {
	A: 'up',
	B: 'down',
	C: 'right',
	D: 'left',
	F: 'end',
	H: 'home',
	Z: 'tab', // shift-tab, which carries the shift flag below
	'1~': 'home',
	'3~': 'delete',
	'4~': 'end',
	'5~': 'pageup',
	'6~': 'pagedown',
	'7~': 'home',
	'8~': 'end',
};

/** The control bytes worth naming. Everything else falls through to `ctrl+<letter>`. */
const CONTROLS: Record<string, string> = {
	'\r': 'enter',
	'\n': 'enter',
	'\t': 'tab',
	'\b': 'backspace',
	'\u007f': 'backspace',
	'\u0003': 'c', // ctrl-c
	'\u0004': 'd', // ctrl-d
	' ': 'space',
};

function key(partial: Partial<Key> & { name: string; sequence: string }): Key {
	return { ctrl: false, meta: false, shift: false, ...partial };
}

/**
 * Reads one escape sequence from `input` at `start`.
 *
 * @param input - The whole chunk.
 * @param start - The index of the `ESC`.
 * @returns The key and how much of the input it took.
 */
function readEscape(input: string, start: number): { key: Key; length: number } {
	const next = input[start + 1];

	// a lone ESC, or one at the very end of a chunk. Terminals send Alt-x as ESC
	// followed by x in the same chunk, so a trailing ESC really is Escape
	if (next === undefined) {
		return { key: key({ name: 'escape', sequence: input.slice(start, start + 1) }), length: 1 };
	}

	if (next === '[' || next === 'O') {
		// the parameters, then the byte that ends it. A CSI ends on a byte in
		// 0x40-0x7e; the digits and semicolons before it are parameters
		let i = start + 2;
		while (i < input.length && /[\d;]/.test(input[i])) {
			i++;
		}

		const final = input[i];
		if (final === undefined) {
			// an unfinished sequence: take what is here rather than leaving the
			// bytes to be read as separate keys on the next chunk
			const sequence = input.slice(start);
			return { key: key({ name: 'unknown', sequence }), length: sequence.length };
		}

		const params = input.slice(start + 2, i);
		const sequence = input.slice(start, i + 1);
		const name = SEQUENCES[final] ?? SEQUENCES[`${params}${final}`] ?? 'unknown';

		// `ESC [ 1 ; 5 A` is Ctrl-Up and `ESC [ 1 ; 2 A` is Shift-Up: the modifier is
		// the second parameter, one more than a bitmask of 1 shift, 2 alt, 4 ctrl,
		// and 8 meta
		const modifier = Number.parseInt(params.split(';')[1] ?? '', 10);
		const bits = Number.isNaN(modifier) ? 0 : modifier - 1;

		return {
			key: key({
				ctrl: (bits & 4) !== 0,
				meta: (bits & 2) !== 0 || (bits & 8) !== 0,
				name,
				sequence,
				// Shift-Tab is its own sequence rather than a modifier
				shift: final === 'Z' || (bits & 1) !== 0,
			}),
			length: sequence.length,
		};
	}

	// ESC followed by anything else is Alt-that
	const read = readOne(input, start + 1);
	return {
		key: key({ ...read.key, meta: true, sequence: input.slice(start, start + 1 + read.length) }),
		length: 1 + read.length,
	};
}

/**
 * Reads one key from `input` at `start`.
 *
 * @param input - The whole chunk.
 * @param start - Where to read from.
 * @returns The key and how much of the input it took.
 */
function readOne(input: string, start: number): { key: Key; length: number } {
	const ch = input[start];

	if (ch === '\u001b') {
		return readEscape(input, start);
	}

	const named = CONTROLS[ch];
	if (named !== undefined) {
		// the two that are control bytes rather than keys of their own
		const ctrl = ch === '\u0003' || ch === '\u0004';
		return { key: key({ ctrl, name: named, sequence: ch }), length: 1 };
	}

	// read from the whole string, not from `ch`: `input[start]` is one UTF-16 code
	// unit, so an emoji's high surrogate on its own reports itself as the code
	// point and the low surrogate is then read as a second key
	const code = input.codePointAt(start) as number;

	// the rest of the C0 range is Ctrl with a letter: 0x01 is Ctrl-A
	if (code < 0x20) {
		return {
			key: key({ ctrl: true, name: String.fromCharCode(code + 0x60), sequence: ch }),
			length: 1,
		};
	}

	// anything else is the character itself, taken whole: an emoji is a surrogate
	// pair and half of one is not a key
	const char = String.fromCodePoint(code);
	return { key: key({ name: char, sequence: char }), length: char.length };
}

/**
 * Decodes a chunk of raw input into the keys it carries.
 *
 * @param input - What the terminal sent.
 * @returns The keys, in order.
 */
export function decodeKeys(input: string): Key[] {
	const keys: Key[] = [];
	let i = 0;

	while (i < input.length) {
		const { key: k, length } = readOne(input, i);
		keys.push(k);
		i += length;
	}

	return keys;
}

/**
 * Whether a key is one a prompt should treat as "give up and go away".
 *
 * Ctrl-C is the signal, and Ctrl-D on an empty prompt is end of input. Both mean
 * the person is not going to answer, and a prompt that keeps asking is a prompt
 * that cannot be escaped.
 *
 * @param k - The key.
 * @returns `true` when the prompt should abort.
 */
export function isAbort(k: Key): boolean {
	return k.ctrl && (k.name === 'c' || k.name === 'd');
}
