import { stringWidth } from '../../src/width/index.js';
import { ELLIPSIS, truncate } from '../../src/wrap/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Cutting a line down to a width.
 *
 * One implementation, read by `text-overflow` and by anything else that has to
 * fit text into a column. What it promises is that the result is never *wider*
 * than asked for and never leaves half a character behind, and both of those are
 * about grapheme clusters rather than about code units.
 */

describe('truncate()', () => {
	it('should leave text that fits', () => {
		expect(truncate('abc', 5)).to.equal('abc');
		expect(truncate('abc', 3)).to.equal('abc');
	});

	it('should cut with an ellipsis', () => {
		expect(truncate('abcdef', 4)).to.equal('abc…');
	});

	it('should cut without one where it was asked to clip', () => {
		expect(truncate('abcdef', 4, 'clip')).to.equal('abcd');
	});

	it('should mark the start or the middle where it was asked to', () => {
		expect(truncate('abcdefgh', 4, 'ellipsis-start')).to.equal('…fgh');
		expect(truncate('abcdefgh', 4, 'ellipsis-middle')).to.equal('ab…h');
	});

	// the head keeps the odd column, because the beginning of a path is what says
	// which one it is
	it('should give the head the odd column in the middle', () => {
		expect(truncate('abcdefgh', 6, 'ellipsis-middle')).to.equal('abc…gh');
	});

	it('should never exceed the width it was given', () => {
		for (const width of [1, 2, 3, 6]) {
			for (const mode of ['clip', 'ellipsis', 'ellipsis-start', 'ellipsis-middle'] as const) {
				expect(stringWidth(truncate('abcdefghij', width, mode))).to.be.lessThanOrEqual(width);
				expect(stringWidth(truncate('日本語のテキスト', width, mode))).to.be.lessThanOrEqual(width);
				expect(stringWidth(truncate('🙂🙂🙂🙂', width, mode))).to.be.lessThanOrEqual(width);
			}
		}
	});

	// slicing mid-pair leaves half a code point, and slicing before a combining
	// mark leaves it to attach to whatever follows
	it('should cut on grapheme clusters', () => {
		const cut = truncate('🙂🙂🙂🙂', 5);
		expect(cut).to.equal(`🙂🙂${ELLIPSIS}`);
		expect(stringWidth(cut)).to.equal(5);
	});

	// a cluster that would straddle the edge is dropped rather than half drawn,
	// which is what makes the result one column narrower than asked for
	it('should drop a wide cluster rather than half of it', () => {
		expect(truncate('日本語', 3, 'clip')).to.equal('日');
	});

	it('should be the ellipsis alone at one column', () => {
		expect(truncate('abc', 1)).to.equal(ELLIPSIS);
		expect(truncate('abc', 1, 'ellipsis-start')).to.equal(ELLIPSIS);
	});

	it('should return nothing for no width', () => {
		expect(truncate('abc', 0)).to.equal('');
		expect(truncate('abc', -1)).to.equal('');
	});
});
