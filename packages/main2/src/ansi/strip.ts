import { ESC } from './codes.js';

/**
 * Every escape sequence a terminal might be handed, in the order the
 * alternation has to try them.
 *
 * The generic two-character form at the end would otherwise swallow the `[` of
 * a CSI sequence or the `]` of an OSC and leave the parameters behind as text,
 * so the framed sequences come first.
 *
 * The string sequences -- OSC, DCS, and the rest -- run to their terminator,
 * but they also stop at everything a terminal stops them at: `CAN` and `SUB`
 * cancel one, and an `ESC` that is not the `ESC \` of a string terminator ends
 * one and begins something else. A sequence that just runs off the end of the
 * string ends there. Without that, one unterminated OSC would swallow every
 * printable character after it.
 *
 * What this does not model is a sequence interrupted mid-parameter by a control
 * character -- `ESC [ 3 1 LF m` is, to a terminal, a line feed performed in the
 * middle of `ESC[31m`. Matching that needs the state machine rather than a
 * regular expression, and the failure is in the safe direction: the parameter
 * bytes survive as text rather than real text being eaten.
 */
const sequences = [
	// OSC -- ESC ] ... terminated by BEL or ST. Used for hyperlinks and window
	// titles, and the payload may contain `;` and spaces.
	string('\\u001B\\]|\\u009D'),

	// DCS, SOS, PM, and APC -- ESC P/X/^/_ ... terminated by ST
	string('\\u001B[P^_X]|[\\u0090\\u0098\\u009E\\u009F]'),

	// CSI -- ESC [ parameters intermediates final. SGR is the one that matters
	// here, but cursor movement and erase share the shape.
	'(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*(?:[@-~]|$)',

	// everything else -- ESC, optional intermediates, one final byte
	'\\u001B[ -/]*[0-~]?',
].join('|');

/**
 * One of the sequences that frames a string payload.
 *
 * @param introducer - The alternation that opens it, both the `ESC` form and
 * the single-byte C1 one.
 * @returns The pattern source.
 */
function string(introducer: string): string {
	// the payload runs until something ends it, and the empty alternative at the
	// end of the terminator group is what lets an ESC that is not `ESC \` end the
	// payload without being consumed by it
	return `(?:${introducer})[^\\u0007\\u0018\\u001A\\u001B\\u009C]*(?:\\u0007|\\u001B\\\\|\\u009C|\\u0018|\\u001A|)`;
}

/**
 * Matches one escape sequence, and nothing else.
 *
 * Built fresh per call rather than shared, because a `g` flagged regex carries
 * `lastIndex` and sharing one across calls makes `test()` and `exec()` answer
 * differently depending on what ran before.
 *
 * Exported because removing sequences is not the only thing anything wants to
 * do with them: the wrapper has to find them in order to keep them out of a
 * column count and out of the middle of a line break, which is the opposite of
 * stripping them.
 *
 * @returns The matcher.
 */
export function matcher(): RegExp {
	return new RegExp(sequences, 'g');
}

/**
 * Removes every escape sequence from a string.
 *
 * This is the first half of measuring a styled string honestly -- a sequence
 * occupies no columns at all, so nothing can be measured until they are gone.
 * It is only the first half: what is left is still text whose width is not its
 * length, since a lone control character prints nothing, a combining mark
 * prints on top of what came before, and an East Asian character takes two
 * columns. That is the display-width module's job, not this one's.
 *
 * @param str - The string to strip.
 * @returns The string with no escape sequences left in it.
 */
export function strip(str: string): string {
	return str.includes(ESC) || hasC1(str) ? str.replace(matcher(), '') : str;
}

/**
 * Whether a string contains an escape sequence.
 *
 * @param str - The string to test.
 * @returns `true` when at least one sequence is present.
 */
export function hasAnsi(str: string): boolean {
	return matcher().test(str);
}

/**
 * The single-byte C1 introducers, which start a sequence without an `ESC` in
 * front of them. Rare, but `strip()` would otherwise have to run the full
 * matcher over every string to find out, and the common case is a string with
 * no sequences in it at all.
 *
 * @param str - The string to test.
 * @returns `true` when the string contains a C1 introducer.
 */
function hasC1(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i);
		if (code >= 0x80 && code <= 0x9f) {
			return true;
		}
	}
	return false;
}
