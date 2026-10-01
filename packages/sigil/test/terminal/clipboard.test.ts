import { ESC } from '../../src/ansi/index.js';
import {
	CLIPBOARD_LIMIT,
	clipboardSequence,
	copyToClipboard,
	createTerminal,
	type Terminal,
} from '../../src/terminal/index.js';
import { describe, expect, it } from 'vitest';

/**
 * OSC 52, and the three things the ticket named: base64, a size cap, and no
 * success claim.
 *
 * What a terminal does with the bytes is not testable here and is not pretended
 * to be -- there is no reply to an OSC 52, which is the whole reason
 * `ClipboardCopy.written` says what it says. `terminal-probe.mjs --clipboard` is
 * where the other half lives.
 */

interface Harness {
	out: string[];
	terminal: Terminal;
}

/** A terminal whose writes are collected. */
function harness(opts: { fail?: boolean } = {}): Harness {
	const out: string[] = [];
	const terminal = createTerminal({
		env: {},
		isTTY: true,
		proc: { on() {}, pid: 1, removeListener() {} } as never,
		stderr: { isTTY: true, write: (chunk: string) => void out.push(chunk) } as never,
		stdin: undefined,
		stdout: {
			isTTY: true,
			write(chunk: string) {
				if (opts.fail === true) {
					const err = new Error('gone') as NodeJS.ErrnoException;
					err.code = 'EPIPE';
					throw err;
				}
				out.push(chunk);
				return true;
			},
		} as never,
	});
	return { out, terminal };
}

/** The base64 group of a sequence, which is the only part a caller supplies. */
function encodedOf(sequence: string): string {
	const found = new RegExp(`^${ESC}\\]52;([cp]);(.*)${ESC}\\\\$`, 's').exec(sequence);
	expect(found, `not an OSC 52: ${JSON.stringify(sequence)}`).not.toBe(null);
	return found![2];
}

/** Reads the payload back out of a sequence. */
function payloadOf(sequence: string): string {
	return Buffer.from(encodedOf(sequence), 'base64').toString('utf8');
}

describe('clipboardSequence', () => {
	it('should write an OSC 52 whose payload is base64 of the text', () => {
		const built = clipboardSequence('hello');
		expect(built.sequence).toBe(`${ESC}]52;c;aGVsbG8=${ESC}\\`);
		expect(payloadOf(built.sequence)).toBe('hello');
		expect(built).toMatchObject({ bytes: 5, refused: undefined, truncated: false });
	});

	it('should terminate with ST rather than BEL', () => {
		// the rule `canvas/style.ts` already keeps for OSC 8: BEL is a control
		// character in the middle of output, so a terminal that does not know the
		// sequence beeps rather than doing nothing
		const built = clipboardSequence('x');
		expect(built.sequence.endsWith(`${ESC}\\`)).toBe(true);
		expect(built.sequence).not.toContain('\u0007');
	});

	it('should write the primary selection when asked', () => {
		expect(clipboardSequence('x', { target: 'primary' }).sequence).toContain(`]52;p;`);
	});

	it('should refuse a target that is not one rather than writing undefined', () => {
		// the rule every lookup table here follows: a plain object answers
		// `constructor` with a truthy function and an unknown key with `undefined`,
		// and either one goes out inside the sequence -- which is the failure
		// `normalize()` already records, met through a selection parameter
		for (const target of ['constructor', 'toString', '__proto__', 'nonsense']) {
			expect(() => clipboardSequence('x', { target: target as never })).toThrow(
				/Invalid clipboard target/
			);
		}
	});

	it('should make a control character in the text inert rather than refusing it', () => {
		// base64 is *why* OSC 52 is safe to build out of user input: a control
		// character inside an OSC payload would end the sequence early and the rest
		// would reach the terminal as commands. The guard is the encoding, in the
		// encoder, so a caller cannot opt out of it
		const nasty = `a${ESC}]0;title${ESC}\\b\u0007c`;
		const built = clipboardSequence(nasty);
		expect(encodedOf(built.sequence)).not.toMatch(/\p{Cc}/u);
		expect(payloadOf(built.sequence)).toBe(nasty);
	});

	it('should write nothing for empty text', () => {
		// an empty payload *clears* the clipboard on most terminals, and "copy
		// nothing" is not a request to throw away what the user copied an hour ago
		expect(clipboardSequence('')).toMatchObject({
			bytes: 0,
			refused: 'empty',
			sequence: '',
			truncated: false,
		});
	});

	it('should refuse text over the cap rather than sending it to be dropped', () => {
		const built = clipboardSequence('x'.repeat(20), { limit: 10 });
		expect(built).toMatchObject({
			bytes: 20,
			refused: 'too-large',
			sequence: '',
			truncated: false,
		});
	});

	it('should truncate deliberately when asked, and say so', () => {
		const built = clipboardSequence('x'.repeat(20), { limit: 10, truncate: true });
		expect(built).toMatchObject({ bytes: 10, refused: undefined, truncated: true });
		expect(payloadOf(built.sequence)).toBe('x'.repeat(10));
	});

	it('should cut on a cluster boundary rather than mid-character', () => {
		// a cut inside a cluster leaves a lone surrogate, which encodes to bytes no
		// decoder can read -- and the whole point of truncating is to send
		// *something* the terminal can take
		const text = '👍👍👍'; // four UTF-8 bytes each
		const built = clipboardSequence(text, { limit: 7, truncate: true });
		expect(payloadOf(built.sequence)).toBe('👍');
		expect(built.bytes).toBe(4);
	});

	it('should refuse rather than clear when the limit holds no whole cluster', () => {
		const built = clipboardSequence('👍', { limit: 2, truncate: true });
		expect(built).toMatchObject({ refused: 'too-large', sequence: '', truncated: true });
	});

	it('should cut by cluster rather than by code point', () => {
		// a flag is two regional indicators, four UTF-8 bytes each, and a cut
		// between them is a lone indicator -- which renders as a letter in a box
		// rather than as half a flag, and is not what anybody selected. Code points
		// are not the unit: `for..of` would take the first four bytes happily
		const flag = '\u{1F1EF}\u{1F1F5}';
		expect(Buffer.byteLength(flag, 'utf8')).toBe(8);
		expect(clipboardSequence(flag, { limit: 5, truncate: true })).toMatchObject({
			bytes: 0,
			refused: 'too-large',
		});
		expect(clipboardSequence(`${flag}${flag}`, { limit: 12, truncate: true }).bytes).toBe(8);
	});

	it('should count UTF-8 bytes rather than characters', () => {
		// a terminal's cap is on the bytes of the sequence; a string's length says
		// nothing about those
		expect(clipboardSequence('é'.repeat(5)).bytes).toBe(10);
		expect(clipboardSequence('é'.repeat(5), { limit: 9 }).refused).toBe('too-large');
	});

	it('should accept any size where the limit is turned off', () => {
		const built = clipboardSequence('x'.repeat(CLIPBOARD_LIMIT + 1), { limit: 0 });
		expect(built.refused).toBeUndefined();
		expect(built.bytes).toBe(CLIPBOARD_LIMIT + 1);
	});

	it('should default to the limit every other OSC 52 tool uses', () => {
		// derived rather than chosen: a 100,000-byte ceiling over base64's 4-for-3
		// leaves 74,994 bytes of input. Pinned at **100,001** rather than at the
		// ceiling, because the derivation forgets the nine bytes of wrapper -- which
		// `--clipboard` printed on its first run. Kept anyway: being the same number
		// as every other tool is worth more than nine bytes against a cap nobody
		// will state
		expect(CLIPBOARD_LIMIT).toBe(74_994);
		expect(clipboardSequence('x'.repeat(CLIPBOARD_LIMIT)).sequence.length).toBe(100_001);
		expect(clipboardSequence('x'.repeat(CLIPBOARD_LIMIT)).refused).toBeUndefined();
		expect(clipboardSequence('x'.repeat(CLIPBOARD_LIMIT + 1)).refused).toBe('too-large');
	});
});

describe('copyToClipboard', () => {
	it('should write the sequence and report that it did, and nothing more', () => {
		const h = harness();
		const copy = copyToClipboard(h.terminal, 'hello');
		expect(copy.written).toBe(true);
		expect(h.out).toEqual([`${ESC}]52;c;aGVsbG8=${ESC}\\`]);
	});

	it('should write nothing and report nothing written for a refusal', () => {
		const h = harness();
		expect(copyToClipboard(h.terminal, '').written).toBe(false);
		expect(copyToClipboard(h.terminal, 'x'.repeat(20), { limit: 10 }).written).toBe(false);
		expect(h.out).toEqual([]);
	});

	it('should report nothing written once the far end has gone', () => {
		const h = harness({ fail: true });
		expect(copyToClipboard(h.terminal, 'hello').written).toBe(false);
	});

	it('should put no mode on the restore list, because it sets none', () => {
		// OSC 52 is a write rather than a mode: there is nothing for `restore()` to
		// put back, unlike the paste markers and the tracking modes beside it
		const h = harness();
		copyToClipboard(h.terminal, 'hello');
		h.out.length = 0;
		h.terminal.restore();
		expect(h.out).toEqual([]);
	});
});
