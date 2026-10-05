import { stringWidth } from '../../src/width/index.js';
import { cutAt, ELLIPSIS, truncate, type TruncateMode } from '../../src/wrap/index.js';
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

/**
 * The arithmetic behind all of the above, on its own.
 *
 * A function of its own because two things honour `text-overflow` and neither
 * one's walk is the other's: `truncate()` walks grapheme clusters, and the decrypt
 * component walks *cells*, where `ASCII.wide` hides one two-column character with
 * two narrow glyphs. What they must not disagree about is which columns survive
 * and what goes between them, and that is this.
 */
describe('cutAt()', () => {
	const MODES: TruncateMode[] = ['clip', 'ellipsis', 'ellipsis-start', 'ellipsis-middle'];

	it('should keep every column for clip, which marks nothing', () => {
		expect(cutAt(4, 'clip')).to.deep.equal({ head: 4, marker: '', tail: 0 });
	});

	it('should keep one column back for a mark', () => {
		expect(cutAt(4, 'ellipsis')).to.deep.equal({ head: 3, marker: ELLIPSIS, tail: 0 });
		expect(cutAt(4, 'ellipsis-start')).to.deep.equal({ head: 0, marker: ELLIPSIS, tail: 3 });
	});

	// the beginning of a path or an identifier is what says which one it is, so the
	// head is where an odd column goes -- the one asymmetry in the whole function,
	// and the one a second implementation would be most likely to get backwards
	it('should give the head an odd column in the middle', () => {
		expect(cutAt(6, 'ellipsis-middle')).to.deep.equal({ head: 3, marker: ELLIPSIS, tail: 2 });
		expect(cutAt(7, 'ellipsis-middle')).to.deep.equal({ head: 3, marker: ELLIPSIS, tail: 3 });
	});

	it('should be the mark alone at one column', () => {
		for (const mode of MODES.filter((m) => m !== 'clip')) {
			expect(cutAt(1, mode), mode).to.deep.equal({ head: 0, marker: ELLIPSIS, tail: 0 });
		}
		expect(cutAt(1, 'clip')).to.deep.equal({ head: 1, marker: '', tail: 0 });
	});

	// `NaN` fails every comparison, so a guard that let it through handed back a
	// head of `NaN` columns -- which is the rule `truncate()` already records
	it('should keep nothing where there is no width to keep it in', () => {
		for (const mode of MODES) {
			for (const width of [0, -1, Number.NaN]) {
				expect(cutAt(width, mode), `${mode} at ${width}`).to.deep.equal({
					head: 0,
					marker: '',
					tail: 0,
				});
			}
		}
	});

	// the invariant every reader divides a budget by: the three pieces are the
	// budget, so a reader that lays them end to end cannot overrun its box
	it('should divide exactly the budget it was given', () => {
		for (const mode of MODES) {
			for (let width = 1; width <= 12; width++) {
				const { head, marker, tail } = cutAt(width, mode);
				expect(head + stringWidth(marker) + tail, `${mode} at ${width}`).to.equal(width);
			}
		}
	});

	// and the differential that says the extraction changed nothing: `truncate()` is
	// this function plus a cluster walk, so composing the two by hand has to be what
	// it answers -- for every mode, every width and a wide cluster to straddle a
	// boundary with
	it('should be what the truncator composes', () => {
		const take = (text: string, width: number): string => {
			let out = '';
			for (const cluster of text) {
				if (stringWidth(out + cluster) > width) {
					break;
				}
				out += cluster;
			}
			return out;
		};
		const takeEnd = (text: string, width: number): string => {
			let out = '';
			for (const cluster of [...text].reverse()) {
				if (stringWidth(cluster + out) > width) {
					break;
				}
				out = cluster + out;
			}
			return out;
		};

		for (const text of ['abcdefghij', '日本語のテキスト', 'a日b語c']) {
			for (const mode of MODES) {
				for (let width = 1; width <= 12; width++) {
					const { head, marker, tail } = cutAt(width, mode);
					const want =
						stringWidth(text) <= width
							? text
							: take(text, head) + marker + (tail > 0 ? takeEnd(text, tail) : '');
					expect(truncate(text, width, mode), `${text} ${mode} at ${width}`).to.equal(want);
				}
			}
		}
	});
});
