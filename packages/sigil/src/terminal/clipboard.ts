/**
 * OSC 52: asking the terminal to put something on the system clipboard.
 *
 * `ESC ] 52 ; Pc ; <base64> ST`, and the whole of what makes it worth having is
 * that it works over ssh -- the terminal is the thing holding the clipboard, so
 * a remote app can reach it without a channel of its own.
 *
 * **There is no success to report.** A terminal does not answer an OSC 52 write,
 * several refuse it by default, and tmux needs `set -g set-clipboard on` before
 * it will pass one through -- so nothing here may claim the clipboard changed.
 * What `ClipboardCopy.written` says is that the bytes were handed to the output
 * stream, which is the strongest true statement available.
 *
 * **Reading is not implemented and is not an omission.** `ESC ] 52 ; c ; ? ST`
 * asks the terminal to send the clipboard back on the input stream, which is a
 * remote app exfiltrating whatever the user last copied -- which is why it is
 * disabled by default nearly everywhere and why it should be. Paste arrives
 * through bracketed paste, which the router already reads and which the user has
 * to actually perform.
 */

import { ESC } from '../ansi/codes.js';
import { graphemes } from '../width/index.js';
import type { Terminal } from './index.js';

/**
 * How many UTF-8 bytes of text a terminal is assumed to accept.
 *
 * 74,994 is what every other OSC 52 tool uses, and it is derived rather than
 * chosen: a 100,000-byte ceiling over base64's 4-for-3 leaves 74,994 bytes of
 * input, since 74,994 encodes to 99,992.
 *
 * It is **not** exact, and the probe is what said so: the nine bytes of
 * `ESC ] 5 2 ; c ;` and `ESC \` around the payload put the whole sequence at
 * 100,001, one past the number the derivation starts from. Kept anyway, because
 * being the same number as every other tool is worth more than nine bytes: this
 * is a **guess about other people's software** -- xterm, tmux, Ghostty and
 * iTerm2 each cap it somewhere, several of them far lower, and none of them will
 * tell you where, because there is no reply. `terminal-probe.mjs --clipboard` is
 * what asks a real terminal, one size at a time; this is the floor to be wrong
 * about conservatively.
 */
export const CLIPBOARD_LIMIT: number = 74_994;

/** Which selection to write. `clipboard` is `c` and `primary` is `p`. */
export type ClipboardTarget = 'clipboard' | 'primary';

/** Why nothing was written. */
export type ClipboardRefusal = 'empty' | 'too-large';

export interface ClipboardOptions {
	/**
	 * The most UTF-8 bytes to send. `CLIPBOARD_LIMIT` by default.
	 *
	 * `0` or less means no limit, for a caller who knows their terminal and has
	 * measured it.
	 */
	limit?: number;
	/** Which selection. The system clipboard by default. */
	target?: ClipboardTarget;
	/**
	 * Whether to cut the text to fit rather than refusing it.
	 *
	 * Off by default, which is the decision the ticket asked for: a selection over
	 * the cap is **refused** unless somebody says to truncate it, because a
	 * terminal that is handed too much drops the whole sequence silently -- so the
	 * default is a refusal the caller can see rather than a copy that did nothing.
	 * Truncation is on cluster boundaries, so a cut never lands inside an emoji
	 * and produces bytes no terminal can decode.
	 */
	truncate?: boolean;
}

export interface ClipboardSequence {
	/** How many UTF-8 bytes were encoded, after any truncation. */
	readonly bytes: number;
	/** Why the sequence is empty, if it is. */
	readonly refused: ClipboardRefusal | undefined;
	/** The sequence to write, or `''` where there is nothing to write. */
	readonly sequence: string;
	/** Whether the text was cut to fit. */
	readonly truncated: boolean;
}

export interface ClipboardCopy extends ClipboardSequence {
	/**
	 * Whether the bytes reached the output stream.
	 *
	 * **Never a claim that the clipboard changed.** There is no reply to an OSC
	 * 52, so "the terminal accepted this" is not a thing anybody can know; this is
	 * false only where nothing was written at all -- a refusal, or a stream whose
	 * far end has gone.
	 */
	readonly written: boolean;
}

/**
 * `Pc`, the selection parameter.
 *
 * Null-prototype, which is the rule this repo records for every lookup table it
 * has -- and the failure it closes is the one `normalize()` already carries an
 * entry for: `TARGETS['constructor']` on a plain object is a truthy function, so
 * `ESC ] 52 ; function Object() ... ;` would reach the terminal, and an unknown
 * key reads back `undefined`, which goes out as `ESC ] 52 ; undefined ;` --
 * output the terminal drops with nobody able to trace it back. Refused rather
 * than defaulted, for the reason `palette()` refuses a channel rather than
 * clamping it.
 *
 * One mechanism rather than a prototype *and* an `Object.hasOwn`: this is a
 * constant nobody writes to, so the half of the convention about a dropped write
 * cannot apply, and a sabotage pass found the two covering each other.
 */
const TARGETS: Record<string, string> = { clipboard: 'c', primary: 'p' };
Object.setPrototypeOf(TARGETS, null);

/**
 * The selection parameter for a target, or a thrown error.
 *
 * @param target - What the caller asked for.
 * @returns `c` or `p`.
 */
function targetOf(target: ClipboardTarget): string {
	const found = TARGETS[target];
	if (found === undefined) {
		throw new TypeError(
			`Invalid clipboard target ${String(target)}: expected "clipboard" or "primary"`
		);
	}
	return found;
}

/** How many UTF-8 bytes a string takes. */
function utf8Length(text: string): number {
	return Buffer.byteLength(text, 'utf8');
}

/**
 * The longest prefix of `text` that fits in `limit` UTF-8 bytes, cut on a
 * grapheme cluster boundary.
 *
 * Clusters rather than code points, for the reason the prompt's own editing
 * already gives: cutting inside one leaves a lone surrogate or an orphaned
 * combining mark, which is a string no terminal can draw and, encoded, bytes no
 * decoder can read. A cluster that does not fit is dropped whole.
 *
 * @param text - The text.
 * @param limit - The byte budget.
 * @returns The prefix.
 */
function cutToBytes(text: string, limit: number): string {
	let out = '';
	let used = 0;
	for (const cluster of graphemes(text)) {
		const size = utf8Length(cluster);
		if (used + size > limit) {
			break;
		}
		out += cluster;
		used += size;
	}
	return out;
}

/**
 * The OSC 52 sequence that puts `text` on the clipboard.
 *
 * The payload is base64 and that is **not** a formality: an OSC sequence runs
 * until its terminator, so a control character inside it ends the sequence early
 * and everything after it reaches the terminal as commands. That is the same
 * injection `assertLink()` refuses for a hyperlink URI, and here it is closed by
 * construction, because base64's alphabet holds nothing a terminal acts on. The
 * guard therefore lives **in the encoder** rather than in each caller: there is
 * one way to build this sequence and it always encodes, so a caller cannot opt
 * out of the safety by passing something raw. The assertion under it is for the
 * day somebody adds a "send it verbatim" option -- the sequence is checked for a
 * control character before it is handed back, so that option would fail here
 * rather than on somebody's terminal.
 *
 * `ESC \` terminates rather than BEL, which is the rule `canvas/style.ts`
 * already keeps for OSC 8: BEL is accepted more widely and is a control
 * character in the middle of output, so a terminal that does not know the
 * sequence beeps rather than doing nothing.
 *
 * An **empty** text writes nothing. OSC 52 with an empty payload *clears* the
 * clipboard on most terminals, and "copy nothing" is not a request to throw away
 * what the user copied an hour ago -- so it is refused, which a caller sees.
 *
 * @param text - What to copy.
 * @param opts - The cap, the selection, and whether to cut rather than refuse.
 * @returns The sequence and what was done to get there.
 */
export function clipboardSequence(text: string, opts: ClipboardOptions = {}): ClipboardSequence {
	const limit = opts.limit ?? CLIPBOARD_LIMIT;
	const target = targetOf(opts.target ?? 'clipboard');

	if (text === '') {
		return Object.freeze({ bytes: 0, refused: 'empty' as const, sequence: '', truncated: false });
	}

	let payload = text;
	let truncated = false;

	if (limit > 0 && utf8Length(payload) > limit) {
		if (opts.truncate !== true) {
			return Object.freeze({
				bytes: utf8Length(payload),
				refused: 'too-large' as const,
				sequence: '',
				truncated: false,
			});
		}
		payload = cutToBytes(payload, limit);
		truncated = true;
		if (payload === '') {
			// a limit too small for the first cluster: there is nothing to send, and
			// sending an empty payload would clear the clipboard instead
			return Object.freeze({
				bytes: 0,
				refused: 'too-large' as const,
				sequence: '',
				truncated: true,
			});
		}
	}

	const encoded = Buffer.from(payload, 'utf8').toString('base64');
	const sequence = `${ESC}]52;${target};${encoded}${ESC}\\`;

	// what base64 guarantees, asserted rather than assumed. The payload is the
	// only part a caller supplies, so this can only fail if the encoding stopped
	// being base64 -- which is exactly the change that would reopen the injection.
	// `\p{Cc}` names the set rather than enumerating it, so there is no control
	// character in this source and no suppression for a formatter to detach
	if (/\p{Cc}/u.test(encoded)) {
		throw new TypeError(
			'Invalid clipboard payload: control characters would end the sequence early'
		);
	}

	return Object.freeze({ bytes: utf8Length(payload), refused: undefined, sequence, truncated });
}

/**
 * Writes `text` to the terminal's clipboard, and says what it did.
 *
 * Not a method on `Terminal` and not on the restore list, which is the question
 * the ticket asked to settle: OSC 52 is a **write** rather than a mode. Nothing
 * is turned on, so there is nothing for `restore()` to put back -- unlike the
 * paste markers and the mouse tracking modes beside it, which a CLI that dies
 * leaves a shell wearing.
 *
 * @param terminal - Where to write. Its own `EPIPE` guard applies.
 * @param text - What to copy.
 * @param opts - The cap, the selection, and whether to cut rather than refuse.
 * @returns What was sent, and never a claim that the clipboard changed.
 */
export function copyToClipboard(
	terminal: Terminal,
	text: string,
	opts: ClipboardOptions = {}
): ClipboardCopy {
	const built = clipboardSequence(text, opts);
	if (built.sequence === '') {
		return Object.freeze({ ...built, written: false });
	}
	// `write()` answers `false` once the far end has gone, which is the one
	// failure available here -- a terminal that took the bytes and ignored them is
	// indistinguishable from one that acted on them
	return Object.freeze({ ...built, written: terminal.write(built.sequence) });
}
