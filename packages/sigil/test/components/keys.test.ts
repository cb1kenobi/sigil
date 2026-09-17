import { decodeKeys, isAbort } from '../../src/components/keys.js';
import { describe, expect, it } from 'vitest';

/** The one key in a chunk, for the cases that are about decoding rather than splitting. */
function one(input: string) {
	const keys = decodeKeys(input);
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
