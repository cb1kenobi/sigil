/**
 * The editing rules, asserted where they live.
 *
 * `prompt.test.ts` is the regression suite for the *extraction* -- it drives the
 * single-line field through a terminal and must not move -- and this is the
 * other half: the rules as functions of a string and an offset, which is where
 * the inputs that are awkward to type land. A lone combining mark, a CRLF
 * cluster and a word movement over a line break are each one line here and a
 * keystroke sequence through a screen model there.
 */

import {
	boundary,
	deleteAfter,
	deleteBefore,
	deleteRange,
	insertAt,
	isControlChar,
	isSpaceCluster,
	pastedBlock,
	pastedLine,
	snap,
	typedText,
	wordAfter,
	wordBefore,
} from '../../src/components/editing.js';
import type { Key } from '../../src/components/keys.js';
import { describe, expect, it } from 'vitest';

/** A key as the decoder hands one over. */
function key(partial: Partial<Key> & { name: string }): Key {
	return { ctrl: false, meta: false, sequence: partial.name, shift: false, ...partial };
}

describe('boundary()', () => {
	it('should step over a whole cluster rather than a code unit', () => {
		const value = 'a\u{1f600}b';
		// the emoji is two code units, so one step back from the `b` is 1 and not 2
		expect(boundary(value, 3, -1)).to.equal(1);
		expect(boundary(value, 1, 1)).to.equal(3);
		expect(boundary(value, 4, -1)).to.equal(3);
	});

	it('should clamp at the ends', () => {
		expect(boundary('ab', 0, -1)).to.equal(0);
		expect(boundary('ab', 2, 1)).to.equal(2);
		expect(boundary('', 0, 1)).to.equal(0);
		expect(boundary('', 0, -1)).to.equal(0);
	});

	it('should snap an offset that is not a boundary rather than refusing it', () => {
		// the alternative to moving is a cursor that cannot move
		expect(boundary('\u{1f600}b', 1, 1)).to.equal(2);
		expect(boundary('\u{1f600}b', 1, -1)).to.equal(0);
	});

	it('should keep a combining mark with what it modifies', () => {
		expect(boundary('aé', 3, -1)).to.equal(1);
	});
});

describe('snap()', () => {
	it('should leave a boundary where it is', () => {
		expect(snap('ab', 1)).to.equal(1);
		expect(snap('ab', 2)).to.equal(2);
	});

	it('should move forward to the end of the cluster it fell inside', () => {
		expect(snap('\u{1f600}', 1)).to.equal(2);
	});

	it('should answer the length past the end', () => {
		expect(snap('ab', 9)).to.equal(2);
	});
});

describe('insertAt()', () => {
	it('should put text in at the cursor and move past it', () => {
		expect(insertAt('ad', 1, 'bc')).to.deep.equal({ cursor: 3, value: 'abcd' });
	});

	it('should change nothing for nothing', () => {
		expect(insertAt('ab', 1, '')).to.deep.equal({ cursor: 1, value: 'ab' });
	});

	it('should snap forward when what was typed joined the cluster after it', () => {
		// a letter typed in front of a lone combining mark makes the two one cluster
		// two code units long, and a cursor left inside it is a backspace away from
		// splitting the pair
		expect(insertAt('́', 0, 'e')).to.deep.equal({ cursor: 2, value: 'é' });
	});
});

describe('deleteBefore()', () => {
	it('should take a whole cluster out', () => {
		expect(deleteBefore('a\u{1f600}', 3)).to.deep.equal({ cursor: 1, value: 'a' });
	});

	it('should change nothing at the start', () => {
		expect(deleteBefore('ab', 0)).to.deep.equal({ cursor: 0, value: 'ab' });
	});

	it('should leave the cursor on a boundary where the splice merged two clusters', () => {
		expect(deleteBefore('e\t\u0301', 2)).to.deep.equal({ cursor: 2, value: 'e\u0301' });
	});
});

describe('deleteAfter()', () => {
	it('should take a whole cluster out and leave the cursor', () => {
		expect(deleteAfter('\u{1f600}a', 0)).to.deep.equal({ cursor: 0, value: 'a' });
	});

	it('should change nothing at the end', () => {
		expect(deleteAfter('ab', 2)).to.deep.equal({ cursor: 2, value: 'ab' });
	});

	it('should move the cursor where the two clusters either side turned out to be one', () => {
		expect(deleteAfter('e\t\u0301', 1)).to.deep.equal({ cursor: 2, value: 'e\u0301' });
	});
});

describe('deleteRange()', () => {
	it('should take out what is between two offsets', () => {
		expect(deleteRange('abcdef', 2, 4)).to.deep.equal({ cursor: 2, value: 'abef' });
	});

	it('should take the ends either way round', () => {
		expect(deleteRange('abcdef', 4, 2)).to.deep.equal({ cursor: 2, value: 'abef' });
	});

	it('should change nothing for an empty range', () => {
		expect(deleteRange('ab', 1, 1)).to.deep.equal({ cursor: 1, value: 'ab' });
	});

	it('should clamp to the value', () => {
		expect(deleteRange('ab', -4, 9)).to.deep.equal({ cursor: 0, value: '' });
	});

	it('should leave the cursor on a boundary when the splice merged two clusters', () => {
		// both ends are boundaries of the *old* value, and splicing puts two
		// characters next to each other that were not. `e`, a tab and a combining
		// acute are three clusters; take the tab out and they are one, with offset 1
		// inside it
		expect(deleteRange('e\t\u0301', 1, 2)).to.deep.equal({ cursor: 2, value: 'e\u0301' });
	});

	it('should do the same where no control character is involved at all', () => {
		// a pair of regional indicators is one cluster, so taking the `x` out of
		// `AxBC` re-pairs the flags -- which is this reachable from a single-line
		// field, where it drew half a flag either side of the caret
		expect(deleteRange('\u{1F1E6}x\u{1F1E7}\u{1F1E8}', 2, 3)).to.deep.equal({
			cursor: 4,
			value: '\u{1F1E6}\u{1F1E7}\u{1F1E8}',
		});
	});
});

describe('wordBefore()', () => {
	it('should land on the start of the word the caret is just past', () => {
		expect(wordBefore('one two', 7)).to.equal(4);
	});

	it('should step over the whitespace first', () => {
		expect(wordBefore('one   ', 6)).to.equal(0);
	});

	it('should cross a line break, because a break is whitespace', () => {
		expect(wordBefore('one\ntwo', 4)).to.equal(0);
	});

	it('should cross a CRLF, which is one cluster of two code units', () => {
		// the cluster `graphemes()` keeps together, and the input `^\s$` read as a
		// *word* character -- so word movement walked straight over a line break
		expect(wordBefore('one\r\ntwo', 5)).to.equal(0);
	});

	it('should answer zero at the start', () => {
		expect(wordBefore('one', 0)).to.equal(0);
		expect(wordBefore('', 0)).to.equal(0);
	});

	it('should land on a boundary when a word ends in a cluster', () => {
		expect(wordBefore('hi \u{1f600}\u{1f600}', 7)).to.equal(3);
	});

	it('should clamp an offset past the end', () => {
		expect(wordBefore('one two', 99)).to.equal(4);
	});
});

describe('wordAfter()', () => {
	it('should land on the end of the next word', () => {
		expect(wordAfter('one two', 0)).to.equal(3);
	});

	it('should step over the whitespace first', () => {
		expect(wordAfter('one two', 3)).to.equal(7);
	});

	it('should cross a line break', () => {
		expect(wordAfter('one\ntwo', 3)).to.equal(7);
	});

	it('should cross a CRLF', () => {
		expect(wordAfter('one\r\ntwo', 3)).to.equal(8);
	});

	it('should answer the length at the end', () => {
		expect(wordAfter('one', 3)).to.equal(3);
		expect(wordAfter('', 0)).to.equal(0);
	});

	it('should answer the length where there is nothing but whitespace left', () => {
		expect(wordAfter('one   ', 3)).to.equal(6);
	});

	it('should not stop inside the cluster an offset fell into', () => {
		expect(wordAfter('\u{1f600} x', 1)).to.equal(2);
	});
});

describe('isControlChar()', () => {
	it('should be true of C0 and C1 and nothing else', () => {
		expect(isControlChar('\u0001')).to.equal(true);
		expect(isControlChar('\u007f')).to.equal(true);
		expect(isControlChar('\u0085')).to.equal(true);
		expect(isControlChar('a')).to.equal(false);
		expect(isControlChar('\u{1f600}')).to.equal(false);
		expect(isControlChar('́')).to.equal(false);
	});

	it('should not carry a position between calls', () => {
		// a global pattern would search the second string from wherever it left the
		// first, which is a guard that works until it is asked twice
		expect(isControlChar('\u0001')).to.equal(true);
		expect(isControlChar('\u0001')).to.equal(true);
	});
});

describe('isSpaceCluster()', () => {
	it('should be true of a cluster that is nothing but whitespace', () => {
		expect(isSpaceCluster(' ')).to.equal(true);
		expect(isSpaceCluster('\t')).to.equal(true);
		expect(isSpaceCluster('\n')).to.equal(true);
		expect(isSpaceCluster(' ')).to.equal(true);
	});

	it('should be true of a CRLF, which is one cluster of two', () => {
		expect(isSpaceCluster('\r\n')).to.equal(true);
	});

	it('should be false of anything else', () => {
		expect(isSpaceCluster('a')).to.equal(false);
		expect(isSpaceCluster('')).to.equal(false);
	});
});

describe('typedText()', () => {
	it('should insert the sequence of a character key', () => {
		expect(typedText(key({ name: 'a' }))).to.equal('a');
		expect(typedText(key({ name: '\u{1f600}' }))).to.equal('\u{1f600}');
	});

	it('should insert a space for the one character that is named', () => {
		expect(typedText(key({ name: 'space', sequence: ' ' }))).to.equal(' ');
	});

	it('should insert nothing for a key the terminal named', () => {
		// a named key's name is one the terminal never sent, which is what tells the
		// two apart -- so Up does not type `up`
		expect(typedText(key({ name: 'up', sequence: '\u001b[A' }))).to.equal(undefined);
		expect(typedText(key({ name: 'tab', sequence: '\t' }))).to.equal(undefined);
		expect(typedText(key({ name: 'enter', sequence: '\r' }))).to.equal(undefined);
	});

	it('should insert nothing with a modifier held', () => {
		expect(typedText(key({ ctrl: true, name: 'a', sequence: '\u0001' }))).to.equal(undefined);
		expect(typedText(key({ meta: true, name: 'a', sequence: '\u001ba' }))).to.equal(undefined);
	});

	it('should insert nothing for a control character that named itself', () => {
		// which a C1 from a paste can be, and it draws as nothing or as a command
		expect(typedText(key({ name: '\u0085', sequence: '\u0085' }))).to.equal(undefined);
	});
});

describe('pastedLine()', () => {
	it('should flatten every run of whitespace to one space', () => {
		expect(pastedLine('one\ntwo   three\r\nfour')).to.equal('one two three four');
	});

	it('should drop a control character', () => {
		expect(pastedLine('a\u0085b')).to.equal('ab');
	});

	it('should keep a cluster whole', () => {
		expect(pastedLine('a\u{1f600}b')).to.equal('a\u{1f600}b');
	});
});

describe('pastedBlock()', () => {
	it('should keep the line breaks, which is the inverse of pastedLine()', () => {
		expect(pastedBlock('one\ntwo')).to.equal('one\ntwo');
	});

	it('should normalize CRLF and a lone CR', () => {
		expect(pastedBlock('a\r\nb\rc\nd')).to.equal('a\nb\nc\nd');
	});

	it('should keep a trailing newline', () => {
		expect(pastedBlock('a\n')).to.equal('a\n');
	});

	it('should keep a tab, because dropping it takes the indentation out', () => {
		expect(pastedBlock('if {\n\tx;\n}')).to.equal('if {\n\tx;\n}');
	});

	it('should keep a run of spaces rather than flattening it', () => {
		expect(pastedBlock('a   b')).to.equal('a   b');
	});

	it('should drop every other control character', () => {
		expect(pastedBlock('a\u0001b\u0085c\u007f')).to.equal('abc');
	});

	it('should leave a value it has already been through alone', () => {
		// which is what makes it safe to normalize an initial value with: the
		// field's value is a fixed point of it
		const once = pastedBlock('a\r\n\tb\u0001c');
		expect(pastedBlock(once)).to.equal(once);
	});
});

describe('the cursor invariant', () => {
	/** The offsets `graphemes()` agrees are boundaries, including the end. */
	function boundaries(value: string): Set<number> {
		const out = new Set([0]);
		let offset = 0;
		for (const cluster of new Intl.Segmenter().segment(value)) {
			offset += cluster.segment.length;
			out.add(offset);
		}
		return out;
	}

	/**
	 * The values worth walking, which is the point of the list rather than its
	 * length: an astral pair, a combining mark that can be split off, a lone
	 * combining mark with nothing to attach to, a tab and a newline (which break a
	 * cluster either side of them and are therefore what lets a splice merge two),
	 * a ZWJ family, a flag, and three regional indicators -- which re-pair when
	 * something between them goes and need no control character to do it.
	 */
	const VALUES = [
		'',
		'abc',
		'a\u{1f600}b',
		'e\u0301x',
		'\u0301ab',
		'e\t\u0301',
		'e\n\u0301',
		'a\u{1f468}\u200d\u{1f469}\u200d\u{1f467}b',
		'\u{1F1E6}\u{1F1E7}',
		'\u{1F1E6}x\u{1F1E7}\u{1F1E8}',
		'one two\nthree  four',
		'\u65e5\u672c\u8a9e',
	];

	/**
	 * Every function that answers with a cursor answers with a boundary of the
	 * value it answers with.
	 *
	 * The rule the single-line field settled and the one a multiline field is most
	 * likely to break, so it is asserted as a property over every path rather than
	 * at the offsets a report came in on.
	 *
	 * **Inductively**, which is the shape of the claim rather than a convenience:
	 * the cursor starts at a boundary, every path takes a boundary to a boundary,
	 * so it is always at one. Walked over the boundaries alone for that reason --
	 * these functions take a cursor that is on one, which is a precondition every
	 * caller in this package keeps because this is what says it may. Handed one
	 * that is not, a delete really does splice inside a surrogate pair: that is
	 * what `boundary()`'s own doc records and it is byte for byte what the
	 * single-line field did before any of this was extracted.
	 */
	it('should answer with a boundary from every path', () => {
		for (const value of VALUES) {
			for (const at of boundaries(value)) {
				const where = `${JSON.stringify(value)} at ${at}`;

				// the movements answer about the value they were handed
				const here = boundaries(value);
				expect(here, `boundary(-1) ${where}`).to.include(boundary(value, at, -1));
				expect(here, `boundary(+1) ${where}`).to.include(boundary(value, at, 1));
				expect(here, `snap ${where}`).to.include(snap(value, at));
				expect(here, `wordBefore ${where}`).to.include(wordBefore(value, at));
				expect(here, `wordAfter ${where}`).to.include(wordAfter(value, at));

				// and the edits about the value they produced
				for (const [name, edit] of [
					['insert a', insertAt(value, at, 'a')],
					['insert a combining mark', insertAt(value, at, '\u0301')],
					['insert an emoji', insertAt(value, at, '\u{1f600}')],
					['insert a newline', insertAt(value, at, '\n')],
					['backspace', deleteBefore(value, at)],
					['delete', deleteAfter(value, at)],
					['kill a word back', deleteRange(value, wordBefore(value, at), at)],
					['kill a word forward', deleteRange(value, at, wordAfter(value, at))],
					['kill to the start', deleteRange(value, 0, at)],
					['kill to the end', deleteRange(value, at, value.length)],
				] as const) {
					expect(boundaries(edit.value), `${name} ${where}`).to.include(edit.cursor);
				}
			}
		}
	});

	it('should never leave a lone surrogate in the value', () => {
		// the damage the invariant is written for, asserted on the values rather than
		// on the cursors: an unpaired surrogate is a string no terminal can draw, and
		// a cursor that is still a boundary of a corrupt string says nothing
		const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
		for (const value of VALUES) {
			for (const at of boundaries(value)) {
				for (const edit of [
					deleteBefore(value, at),
					deleteAfter(value, at),
					deleteRange(value, wordBefore(value, at), at),
					deleteRange(value, at, wordAfter(value, at)),
					insertAt(value, at, '\u{1f600}'),
				]) {
					expect(lone.test(edit.value), `${JSON.stringify(value)} at ${at}`).to.equal(false);
				}
			}
		}
	});
});
