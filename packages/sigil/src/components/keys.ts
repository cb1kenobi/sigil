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
 *
 * Not everything on stdin is a key, which is the other half of the job. A
 * terminal answers a query on the same stream the user types on, so an OSC or a
 * DCS reply arrives here -- and read as keys it is typed into somebody's answer
 * one character at a time. Measured before it was fixed: an OSC 11 reply came
 * through as twenty-three keys of which twenty-one a text prompt inserted, and
 * XTVersion's came through with the terminal's own name in them. This reads a
 * control string as *one* read, so that `isCapabilityResponse()` can be asked
 * about it and it can be thrown away. A CSI reply already arrived as one read
 * and was already dropped by a prompt, because its name is `unknown` and a
 * prompt only inserts a key whose name is its own sequence -- so the hole was
 * OSC and DCS, which nothing framed at all.
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
 * A byte that carries on a CSI rather than ending one.
 *
 * ECMA-48 puts the parameter bytes in 0x30-0x3f -- the digits and the
 * semicolon, plus the private-use markers a mouse report leads with -- and the
 * intermediates in 0x20-0x2f. Only `[\d;]` was read before, which ended the
 * sequence on the `<` of `ESC [ < 0 ; 1 ; 1 M` and left `0;1;1M` to be typed
 * into the answer a character at a time.
 *
 * @param code - The byte.
 * @returns Whether the sequence continues through it.
 */
function isParameter(code: number): boolean {
	return code >= 0x20 && code <= 0x3f;
}

/**
 * One key read out of a chunk, and whether the chunk ran out while reading it.
 *
 * `pending` is what `decodeKeys()` decides not to act on and `pendingLength()`
 * reports: the chunk ended where a longer sequence could still have continued,
 * so the key is the best reading of what is there rather than a reading of a
 * whole key. Only the last read of a chunk can carry it, because a pending read
 * consumes everything to the end.
 */
interface Read {
	key: Key;
	length: number;
	pending: boolean;
	/** Whether this read was a control string rather than a key. */
	string?: boolean;
}

/**
 * How to read a chunk, for the one question the bytes cannot answer.
 *
 * `ESC ]` is the OSC introducer *and* it is Alt-]; `ESC P` is the DCS introducer
 * *and* it is Alt-Shift-P. Nothing in the bytes tells the two apart, and the
 * difference matters in both directions: read as keys, a terminal's reply is
 * typed into somebody's answer a character at a time, and read as a control
 * string, Alt-] is a key the user pressed and lost.
 *
 * What does know is the reader, because only the reader knows whether it asked
 * the terminal a question. So it says.
 */
export interface DecodeOptions {
	/**
	 * Whether an OSC or DCS introducer starts a control string whatever follows.
	 *
	 * `false` by default, which is the conservative reading: a control string is
	 * claimed only where its payload could not plausibly be a key that was typed
	 * -- a digit after `ESC ]`, since every OSC command is numeric, and `>` or a
	 * digit after `ESC P`. That keeps Alt-] and Alt-Shift-P working while still
	 * keeping a terminal's unsolicited chatter out of a prompt.
	 *
	 * `true` is what a reader that has just written a query passes, for the window
	 * in which a reply can arrive. It closes the one case the default cannot: a
	 * read that splits between `ESC ]` and its payload, where the default has
	 * nothing left to go on and reads Alt-] followed by the payload as keys. What
	 * it costs is Alt-] pressed inside that window -- one key lost for as long as
	 * a probe is outstanding, which is the same asymmetry `ESCAPE_TIMEOUT` is
	 * written for with the window chosen rather than permanent.
	 */
	strings?: boolean;
}

/** The introducer of a control string, and which payloads the default claims. */
const STRINGS: Record<string, RegExp> = {
	// every OSC command is a number, so a digit is the whole of the test
	']': /^\d$/,
	// `ESC P > | name ST` is XTVersion's reply and `ESC P 1 $ r ... ST` is
	// DECRQSS's. `ESC P q` is Sixel, which nothing here asks for
	P: /^[>\d]$/,
};

/**
 * Where a control string ends.
 *
 * BEL is what xterm's OSC has always accepted and what most terminals write;
 * `ESC \` is the real ST, and U+009C is its C1 spelling. `src/ansi/strip.ts`
 * reads the same three and also treats CAN and SUB as ending one -- those are
 * deliberately not read here, because a stripper only has to get *past* a
 * sequence while this has to say where the reply is, and a reply truncated by an
 * abort byte is better read as one that never finished arriving.
 *
 * @param input - The whole chunk.
 * @param from - Where the payload starts.
 * @returns Where the terminator is and how long it is, or `undefined` when the
 *   chunk ran out first.
 */
function stringEnd(input: string, from: number): { end: number; length: number } | undefined {
	for (let i = from; i < input.length; i++) {
		const ch = input[i];
		if (ch === '\u0007' || ch === '\u009c') {
			return { end: i, length: 1 };
		}
		if (ch === '\u001b' && input[i + 1] === '\\') {
			return { end: i, length: 2 };
		}
	}
	return undefined;
}

/**
 * Reads an OSC or DCS control string at `start`.
 *
 * Named `unknown` like every other sequence this does not have a key for: a
 * control string is not a key at all, and what it *is* is
 * `isCapabilityResponse()`'s question rather than the decoder's. One read rather
 * than twenty is the whole of what the decoder owes -- it is what lets a reply
 * be recognised, and thrown away, before it reaches a prompt.
 *
 * @param input - The whole chunk.
 * @param start - The index of the `ESC`.
 * @param opts - Whether an introducer is claimed whatever follows it.
 * @returns The read, or `undefined` where this is not a control string and the
 *   escape should be read the way it always was.
 */
function readString(input: string, start: number, opts: DecodeOptions): Read | undefined {
	const claim = STRINGS[input[start + 1]];
	if (claim === undefined) {
		return undefined;
	}

	const first = input[start + 2];
	if (first === undefined) {
		// the introducer is the whole of what arrived. Held only where a query is
		// outstanding: otherwise `ESC ]` on its own is Alt-], and holding it would
		// lose that key outright rather than delay it, since Alt-] typed by itself
		// *is* the whole chunk and nothing will ever follow it
		return opts.strings
			? {
					key: key({ name: 'unknown', sequence: input.slice(start) }),
					length: input.length - start,
					pending: true,
					string: true,
				}
			: undefined;
	}

	if (!opts.strings && !claim.test(first)) {
		return undefined;
	}

	const found = stringEnd(input, start + 2);
	if (!found) {
		// take the tail rather than leaving it to be read as keys, which is what
		// `readEscape()` already does with an unfinished CSI and for its reason: the
		// alternative puts the payload in somebody's answer
		const sequence = input.slice(start);
		return {
			key: key({ name: 'unknown', sequence }),
			length: sequence.length,
			pending: true,
			string: true,
		};
	}

	const sequence = input.slice(start, found.end + found.length);
	return {
		key: key({ name: 'unknown', sequence }),
		length: sequence.length,
		pending: false,
		string: true,
	};
}

/**
 * Reads one escape sequence from `input` at `start`.
 *
 * @param input - The whole chunk.
 * @param start - The index of the `ESC`.
 * @param opts - How to read an OSC or DCS introducer.
 * @returns The key, how much of the input it took, and whether it finished.
 */
function readEscape(input: string, start: number, opts: DecodeOptions): Read {
	const next = input[start + 1];

	// a lone ESC, or one at the very end of a chunk. Terminals send Alt-x as ESC
	// followed by x in the same chunk, so a trailing ESC really is Escape -- and
	// it is pending, because a read that split puts the x in the next chunk
	if (next === undefined) {
		return {
			key: key({ name: 'escape', sequence: input.slice(start, start + 1) }),
			length: 1,
			pending: true,
		};
	}

	// asked before the CSI and before Alt, because it is the narrower claim: the
	// two introducers it reads are ones `readOne()` would otherwise take for keys
	const string = readString(input, start, opts);
	if (string) {
		return string;
	}

	if (next === '[' || next === 'O') {
		// the parameters, then the byte that ends it. A CSI ends on a byte in
		// 0x40-0x7e; everything before it carries on the sequence
		let i = start + 2;
		while (i < input.length && isParameter(input.charCodeAt(i))) {
			i++;
		}

		const final = input[i];
		if (final === undefined) {
			// an unfinished sequence: take what is here rather than leaving the
			// bytes to be read as separate keys on the next chunk
			const sequence = input.slice(start);
			return { key: key({ name: 'unknown', sequence }), length: sequence.length, pending: true };
		}

		// a byte that can neither carry the sequence on nor end it, which is a key
		// pressed while one was still arriving. Taking it as the terminator anyway
		// swallowed it -- `ESC [` and then Ctrl-C was one unknown sequence and a
		// prompt that could not be escaped, and the window for that is as wide as
		// the wait for the rest of a split read. The sequence stops in front of it
		// and it is read as the key it is
		const code = input.charCodeAt(i);
		if (code < 0x40 || code > 0x7e) {
			const sequence = input.slice(start, i);
			return { key: key({ name: 'unknown', sequence }), length: sequence.length, pending: false };
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
			pending: false,
		};
	}

	// ESC followed by anything else is Alt-that. Whether it finished is whatever
	// that key says: `ESC ESC [` is Alt held over a sequence still arriving, and
	// holding all three is what lets the `A` after it make Alt-Up
	const read = readOne(input, start + 1, opts);
	return {
		key: key({ ...read.key, meta: true, sequence: input.slice(start, start + 1 + read.length) }),
		length: 1 + read.length,
		pending: read.pending,
		// carried, or Alt held over a reply still arriving reports itself as a
		// half-arrived key -- and a caller that reads that decides the wrong deadline
		string: read.string,
	};
}

/**
 * Reads one key from `input` at `start`.
 *
 * @param input - The whole chunk.
 * @param start - Where to read from.
 * @param opts - How to read an OSC or DCS introducer.
 * @returns The key, how much of the input it took, and whether it finished.
 */
function readOne(input: string, start: number, opts: DecodeOptions): Read {
	const ch = input[start];

	if (ch === '\u001b') {
		return readEscape(input, start, opts);
	}

	const named = CONTROLS[ch];
	if (named !== undefined) {
		// the two that are control bytes rather than keys of their own
		const ctrl = ch === '\u0003' || ch === '\u0004';
		return { key: key({ ctrl, name: named, sequence: ch }), length: 1, pending: false };
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
			pending: false,
		};
	}

	// anything else is the character itself, taken whole: an emoji is a surrogate
	// pair and half of one is not a key
	const char = String.fromCodePoint(code);
	return { key: key({ name: char, sequence: char }), length: char.length, pending: false };
}

/**
 * How much of the end of a chunk is a sequence that has not finished arriving.
 *
 * `decodeKeys()` is a pure reading of one chunk and has to stay one: it answers
 * for the bytes it was given and cannot wait for more. What it cannot know is
 * whether a chunk that ends mid-sequence ended because the key ended or because
 * the read split -- a terminal sends Alt-x as `ESC x` and Up as `ESC [ A`, both
 * in one write, but ssh, a pty under load, or a small read buffer can deliver
 * the halves separately. Decoded on their own the halves are an unknown
 * sequence and a literal `A`, and the `A` is what a text prompt puts in the
 * answer.
 *
 * So the waiting belongs to whatever feeds the decoder, and this is what it
 * needs to do it: the tail to hold back, measured by the same reader, so that
 * the two can never disagree about where the last key starts. Searching for the
 * last `ESC` instead would find one inside a sequence that had already finished.
 *
 * Nothing is held forever. A caller flushes what it held after a short silence,
 * which is where the reading this returns to would have been used anyway.
 *
 * @param input - What the terminal sent.
 * @param opts - How to read an OSC or DCS introducer. Must be the same as the
 *   one `decodeKeys()` is given, or the two disagree about where the last key
 *   starts, which is exactly what this exists to prevent.
 * @returns The length of the unfinished tail, or `0` when the chunk ends on a
 *   whole key.
 */
export function pendingLength(input: string, opts: DecodeOptions = {}): number {
	return tail(input, opts).length;
}

/**
 * Whether the tail being held is an unterminated control string.
 *
 * The one question a caller needs that the length cannot answer, and the reason
 * is a deadline. A half-arrived *key* has to be given up on quickly, because what
 * follows an `ESC [` may be a Ctrl-C somebody is pressing to get out -- that is
 * what `ESCAPE_TIMEOUT` is for and why it is fifty milliseconds. A half-arrived
 * *reply* is not a key at all, so the wait for the rest of it is governed by the
 * query's own deadline, and flushing it on the key timeout instead leaves the
 * payload to arrive as a chunk with no introducer in front of it -- which is the
 * payload typed into somebody's answer, by the one route the framing does not
 * close.
 *
 * Answered by the same walk `pendingLength()` uses rather than by looking at the
 * first two bytes, for the reason that function exists at all: a second reader
 * with its own idea of what an introducer is, is a second reader to disagree with.
 *
 * @param input - What the terminal sent.
 * @param opts - How to read an OSC or DCS introducer.
 * @returns Whether the held tail is a control string. `false` when nothing is
 *   held, and `false` for a key that merely has not finished arriving.
 */
export function pendingIsString(input: string, opts: DecodeOptions = {}): boolean {
	return tail(input, opts).string;
}

/** The last read of a chunk, where it did not finish. */
function tail(input: string, opts: DecodeOptions): { length: number; string: boolean } {
	let i = 0;
	let held = { length: 0, string: false };

	while (i < input.length) {
		const read = readOne(input, i, opts);
		i += read.length;
		held = read.pending
			? { length: read.length, string: read.string === true }
			: { length: 0, string: false };
	}

	return held;
}

/**
 * Decodes a chunk of raw input into the keys it carries.
 *
 * @param input - What the terminal sent.
 * @param opts - How to read an OSC or DCS introducer.
 * @returns The keys, in order.
 */
export function decodeKeys(input: string, opts: DecodeOptions = {}): Key[] {
	const keys: Key[] = [];
	let i = 0;

	while (i < input.length) {
		const { key: k, length } = readOne(input, i, opts);
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
