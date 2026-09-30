import {
	type DecodeOptions,
	decodeKeys,
	isAbort,
	pendingLength,
} from '../../src/components/keys.js';
import { describe, expect, it } from 'vitest';

/** The one key in a chunk, for the cases that are about decoding rather than splitting. */
function one(input: string, opts?: DecodeOptions) {
	const keys = decodeKeys(input, opts);
	expect(keys, `expected exactly one key from ${JSON.stringify(input)}`).toHaveLength(1);
	return keys[0];
}

describe('decodeKeys()', () => {
	describe('characters', () => {
		it('should read a printable character as itself', () => {
			expect(one('a').name).to.equal('a');
			expect(one('Z').name).to.equal('Z');
			expect(one('7').name).to.equal('7');
		});

		it('should name the space bar', () => {
			expect(one(' ').name).to.equal('space');
		});

		// half a surrogate pair is not a key
		it('should keep an astral character whole', () => {
			const k = one('😀');
			expect(k.name).to.equal('😀');
			expect(k.sequence).to.equal('😀');
		});

		it('should read a multi-byte character as one key', () => {
			expect(one('日').name).to.equal('日');
		});
	});

	describe('control bytes', () => {
		it.each([
			['\r', 'enter'],
			['\n', 'enter'],
			['\t', 'tab'],
			['\u007f', 'backspace'],
			['\b', 'backspace'],
		])('should name %j as %s', (input, name) => {
			expect(one(input).name).to.equal(name);
		});

		it.each([
			['\u0003', 'c'],
			['\u0004', 'd'],
			['\u0001', 'a'],
			['\u0015', 'u'],
			['\u0017', 'w'],
		])('should read %j as a ctrl key', (input, name) => {
			const k = one(input);
			expect(k.name).to.equal(name);
			expect(k.ctrl).to.equal(true);
		});
	});

	describe('escape sequences', () => {
		it.each([
			['\u001b[A', 'up'],
			['\u001b[B', 'down'],
			['\u001b[C', 'right'],
			['\u001b[D', 'left'],
			['\u001b[H', 'home'],
			['\u001b[F', 'end'],
			['\u001b[3~', 'delete'],
			['\u001b[5~', 'pageup'],
			['\u001b[6~', 'pagedown'],
		])('should name %j as %s', (input, name) => {
			expect(one(input).name).to.equal(name);
		});

		// a terminal in application cursor mode sends SS3 instead of CSI
		it.each([
			['\u001bOA', 'up'],
			['\u001bOB', 'down'],
			['\u001bOC', 'right'],
			['\u001bOD', 'left'],
		])('should name the application-mode %j as %s', (input, name) => {
			expect(one(input).name).to.equal(name);
		});

		it('should read shift-tab', () => {
			const k = one('\u001b[Z');
			expect(k.name).to.equal('tab');
			expect(k.shift).to.equal(true);
		});

		// the modifier is the second parameter, as a bitmask over 1
		it('should read a modified arrow', () => {
			expect(one('\u001b[1;5A')).toMatchObject({ ctrl: true, name: 'up', shift: false });
			expect(one('\u001b[1;2A')).toMatchObject({ ctrl: false, name: 'up', shift: true });
			expect(one('\u001b[1;3A')).toMatchObject({ meta: true, name: 'up' });
		});

		it('should read a lone escape as Escape', () => {
			expect(one('\u001b').name).to.equal('escape');
		});

		// terminals send Alt-x as ESC then x in the same chunk
		it('should read ESC followed by a character as meta', () => {
			const k = one('\u001bb');
			expect(k).toMatchObject({ meta: true, name: 'b' });
			expect(k.sequence).to.equal('\u001bb');
		});

		it('should not split an unfinished sequence into stray keys', () => {
			const k = one('\u001b[1;');
			expect(k.name).to.equal('unknown');
			expect(k.sequence).to.equal('\u001b[1;');
		});

		it('should name a sequence it does not know rather than guess', () => {
			expect(one('\u001b[200~').name).to.equal('unknown');
		});

		// a CSI ends on a byte in 0x40-0x7e, and taking anything at all as the
		// terminator swallowed whatever was pressed while one was still arriving:
		// `ESC [` and then ctrl-c was one unknown sequence and a prompt that could
		// not be escaped
		it('should not swallow a key pressed while a sequence was arriving', () => {
			const abort = decodeKeys('[');
			expect(abort.map((k) => k.name)).to.deep.equal(['unknown', 'c']);
			expect(abort[1].ctrl).to.equal(true);

			expect(decodeKeys('[\r').map((k) => k.name)).to.deep.equal(['unknown', 'enter']);
			expect(decodeKeys('O').map((k) => k.name)).to.deep.equal(['unknown', 'c']);
		});

		// the sequence used to stop at the ESC and leave `[A` to be read as two
		// characters, which a text prompt types into the answer
		it('should read a whole sequence after one that could not finish', () => {
			expect(decodeKeys('[[A').map((k) => k.name)).to.deep.equal(['unknown', 'up']);
		});

		// the parameter bytes are 0x30-0x3f, not just the digits and the semicolon:
		// the `<` a mouse report leads with was read as the terminator, and
		// `0;1;1M` was then typed a character at a time
		it('should read a mouse report as one sequence', () => {
			expect(decodeKeys('[<0;1;1M').map((k) => k.name)).to.deep.equal(['unknown']);
		});
	});

	describe('chunks carrying more than one key', () => {
		// a paste arrives as one chunk, and dropping all but the first key loses
		// most of what was pasted
		it('should read every key in a chunk', () => {
			expect(decodeKeys('abc').map((k) => k.name)).to.deep.equal(['a', 'b', 'c']);
		});

		it('should read a pasted line and its newline', () => {
			expect(decodeKeys('hi\r').map((k) => k.name)).to.deep.equal(['h', 'i', 'enter']);
		});

		it('should read a sequence among characters', () => {
			expect(decodeKeys('a\u001b[Ab').map((k) => k.name)).to.deep.equal(['a', 'up', 'b']);
		});

		it('should read repeated arrows', () => {
			expect(decodeKeys('\u001b[A\u001b[B').map((k) => k.name)).to.deep.equal(['up', 'down']);
		});

		it('should read nothing from an empty chunk', () => {
			expect(decodeKeys('')).to.deep.equal([]);
		});
	});
});

describe('pendingLength()', () => {
	// `decodeKeys()` answers for the bytes it was given and cannot wait for more,
	// so this is what a caller holds back until it has them: the tail that could
	// still be the start of a longer key
	it('should hold a trailing escape', () => {
		expect(pendingLength('')).to.equal(1);
		expect(pendingLength('ab')).to.equal(1);
	});

	it('should hold a sequence with no final byte yet', () => {
		expect(pendingLength('[')).to.equal(2);
		expect(pendingLength('O')).to.equal(2);
		expect(pendingLength('[1;')).to.equal(4);
		expect(pendingLength('a[A[1')).to.equal(3);
	});

	// the modifier is the ESC in front of the sequence, so all three bytes are
	// what the `A` after them completes
	it('should hold an alt held over a sequence that has not finished', () => {
		expect(pendingLength('[')).to.equal(3);
	});

	// a byte that can neither carry a sequence on nor end it has ended it, so
	// there is nothing to wait for -- and waiting would hold a ctrl-c
	it('should hold nothing when a sequence was cut short by another key', () => {
		expect(pendingLength('[')).to.equal(0);
		expect(pendingLength('[\r')).to.equal(0);
	});

	it('should hold nothing when the chunk ends on a whole key', () => {
		for (const input of ['', 'a', 'hi\r', '[A', 'OA', 'b', '[200~', '😀']) {
			expect(pendingLength(input), JSON.stringify(input)).to.equal(0);
		}
	});

	// the two are read by the same walk rather than by a search for the last ESC,
	// which would find one inside a sequence that had already finished
	it('should agree with the decoder about where the last key starts', () => {
		const input = 'x[A[';
		const held = pendingLength(input);
		expect(decodeKeys(input.slice(0, input.length - held)).map((k) => k.name)).to.deep.equal([
			'x',
			'up',
		]);
	});
});

describe('isAbort()', () => {
	// a prompt that cannot be escaped is worse than no prompt
	it('should abort on ctrl-c and ctrl-d', () => {
		expect(isAbort(decodeKeys('\u0003')[0])).to.equal(true);
		expect(isAbort(decodeKeys('\u0004')[0])).to.equal(true);
	});

	it('should not abort on anything else', () => {
		for (const input of ['a', '\r', '\u001b', '\u001b[A', '\u0001']) {
			expect(isAbort(decodeKeys(input)[0]), input).to.equal(false);
		}
	});
});

describe('control strings', () => {
	const ESC = '\u001b';
	const BEL = '\u0007';
	const ST = `${ESC}\\`;

	/**
	 * A terminal answers a query on the stream the user types on, so a reply lands
	 * here -- and read as keys it is typed into somebody's answer one character at a
	 * time. Measured before this existed: an OSC 11 reply came through as 23 keys of
	 * which a text prompt inserted 21, and XTVersion's carried the terminal's own
	 * name into it. What the decoder owes is one read; what it *is* is
	 * `isCapabilityResponse()`'s question.
	 */
	it('should read an OSC reply as one read rather than as its characters', () => {
		expect(one(`${ESC}]11;rgb:1111/2222/3333${BEL}`).sequence).to.equal(
			`${ESC}]11;rgb:1111/2222/3333${BEL}`
		);
		expect(one(`${ESC}]11;rgb:1111/2222/3333${ST}`).name).to.equal('unknown');
		expect(one(`${ESC}]10;rgb:0/0/0\u009c`).name).to.equal('unknown');
	});

	it('should read a DCS reply as one read', () => {
		expect(one(`${ESC}P>|Ghostty 1.0.1${ST}`).sequence).to.equal(`${ESC}P>|Ghostty 1.0.1${ST}`);
	});

	// `ESC ]` is the OSC introducer *and* it is Alt-], and nothing in the bytes
	// tells them apart. The default is the conservative reading: a control string
	// is claimed only where its payload could not be a key that was typed
	it('should still read Alt-] and Alt-Shift-P as keys', () => {
		expect(one(`${ESC}]`).name).to.equal(']');
		expect(one(`${ESC}]`).meta).to.equal(true);
		expect(one(`${ESC}P`).name).to.equal('P');
		expect(decodeKeys(`${ESC}]x`).map((k) => k.name)).to.deep.equal([']', 'x']);
	});

	// which is what `strings` is for: only a reader that has asked the terminal a
	// question knows that `ESC ]` is an answer, and it says so for exactly the
	// window in which one can arrive
	it('should claim an introducer whatever follows it while a query is open', () => {
		expect(decodeKeys(`${ESC}]x${BEL}`, { strings: true }).map((k) => k.name)).to.deep.equal([
			'unknown',
		]);
		expect(pendingLength(`${ESC}]`, { strings: true })).to.equal(2);
		expect(pendingLength(`${ESC}]`)).to.equal(0);
	});

	it('should hold a control string whose terminator has not arrived', () => {
		expect(pendingLength(`${ESC}]11;rgb:1111`)).to.equal(13);
		expect(pendingLength(`${ESC}P>|Ghost`)).to.equal(9);
		expect(pendingLength(`${ESC}]11;rgb:1111${BEL}`)).to.equal(0);
	});

	// the same walk answers both, which is what stops the two disagreeing about
	// where the last key starts
	it('should agree with the decoder about a split reply', () => {
		const input = `a${ESC}]11;rgb:`;
		const held = pendingLength(input);
		expect(decodeKeys(input.slice(0, input.length - held)).map((k) => k.name)).to.deep.equal(['a']);
		expect(input.slice(input.length - held)).to.equal(`${ESC}]11;rgb:`);
	});

	// a key pressed while a reply was arriving must survive, which is the rule the
	// CSI path already keeps: an abort byte does not end a control string here, so
	// the whole tail is held and flushed rather than half read
	it('should not lose a control string to a stray ESC that is not a terminator', () => {
		expect(one(`${ESC}]11;rgb:${ESC}[A`, { strings: true }).name).to.equal('unknown');
	});
});
