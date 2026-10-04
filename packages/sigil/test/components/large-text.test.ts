import {
	type FigFont,
	largeText,
	largeTextView,
	parseFlf,
	renderFiglet,
} from '../../src/components/index.js';
import { box, renderToString } from '../../src/element/index.js';
import { measureNode } from '../../src/layout/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Large text: the `.flf` format and the renderer over it.
 *
 * Almost everything here is a plain character grid, which is the whole of what
 * "the parser is separable" buys: a font is read and a banner is rendered with no
 * element tree, no cascade and no terminal anywhere near it, so a test can assert
 * the columns rather than a picture of them.
 *
 * The fonts are built rather than committed. A `.flf` names its characters
 * *positionally* -- ASCII 32 upwards, with nothing in the file saying which code a
 * glyph is for -- so a font with an `A` in it is a font with thirty-four glyphs
 * before the `A`. `fontOf()` fills that run in, which keeps every fixture below
 * down to the glyphs its own claim is about.
 */

/** The codes a font carries before any code tag, in the order it carries them. */
const REQUIRED = [
	...Array.from({ length: 95 }, (_, index) => 32 + index),
	0xc4,
	0xd6,
	0xdc,
	0xe4,
	0xf6,
	0xfc,
	0xdf,
];

/**
 * A font source, with the required run filled in so that codes land where the
 * format puts them.
 *
 * @param glyphs - The glyphs worth having, by the character they are for.
 * @param header - The header line. Three rows, kerning, no comment by default.
 * @param comment - The comment block. The header has to count these itself.
 * @returns The file.
 */
function fontOf(
	glyphs: Record<string, readonly string[]>,
	header = 'flf2a$ 3 3 10 0 0',
	comment: readonly string[] = []
): string {
	const height = Number(header.trim().split(/\s+/)[1]);
	const blank = Array.from({ length: height }, () => ' ');
	const lines = [header, ...comment];

	for (const code of REQUIRED) {
		const rows = glyphs[String.fromCodePoint(code)] ?? blank;
		for (const [index, row] of rows.entries()) {
			lines.push(row + (index === rows.length - 1 ? '@@' : '@'));
		}
	}

	return `${lines.join('\n')}\n`;
}

/** A three-row font with enough in it to read a word. */
const WORDS = parseFlf(
	fontOf(
		{
			' ': ['$$', '$$', '$$'],
			A: [' _ ', '/_\\', '/ \\'],
			B: ['__ ', '|_)', '|_)'],
			C: [' _ ', '/  ', '\\_ '],
		},
		// kerning, derived from the old layout field rather than declared in the
		// newer one, so that the end-to-end tests go through that conversion too
		'flf2a$ 3 3 10 0 0'
	)
);

/**
 * One row of two glyphs joined, for a claim about one pair of columns.
 *
 * The two glyphs are `-L` and `R-`, so the pair that meets is exactly `L` and
 * `R`: both are two columns wide, which is what keeps the one-column rule out of
 * the way, and the `-` on each end is what says whether anything was merged -- a
 * smush leaves three columns and a refusal leaves four.
 *
 * @param left - The column on the left of the join.
 * @param right - The column on the right.
 * @param bits - The full layout field.
 * @param hardblank - The font's hardblank.
 * @returns The row.
 */
function joined(left: string, right: string, bits: number, hardblank = '$'): string {
	const font = parseFlf(
		fontOf({ A: [`-${left}`], B: [`${right}-`] }, `flf2a${hardblank} 1 1 10 0 0 0 ${bits}`)
	);
	return renderFiglet('AB', font)[0] as string;
}

/** Smushing with every rule off, which is universal smushing. */
const UNIVERSAL = 128;
/** Smushing, plus one rule, so that the pair is judged rather than overridden. */
const EQUAL = 128 | 1;
const UNDERSCORE = 128 | 2;
const HIERARCHY = 128 | 4;
const PAIR = 128 | 8;
const BIG_X = 128 | 16;
const HARDBLANK = 128 | 32;

describe('parseFlf()', () => {
	it('should read the header', () => {
		const font = parseFlf(fontOf({}, 'flf2a# 4 3 20 15 2 0 24463 229', ['one', 'two']));

		expect(font.height).toBe(4);
		expect(font.baseline).toBe(3);
		expect(font.hardblank).toBe('#');
		expect(font.comment).toBe('one\ntwo');
		expect(font.direction).toBe('ltr');
	});

	it('should read a header that stops after the five numbers', () => {
		const font = parseFlf(fontOf({}, 'flf2a$ 3 3 10 0 0'));

		expect(font.direction).toBe('ltr');
		expect(font.comment).toBe('');
		expect(font.layout.mode).toBe('kern');
	});

	it('should read the glyphs, stripping the endmark run', () => {
		// the format's own rule: the last character of the line is the endmark and
		// the whole trailing run of it comes off, which is what makes the last row's
		// conventional `@@` the same as every other row
		expect(WORDS.characters.get(0x41)).toStrictEqual([' _ ', '/_\\', '/ \\']);
	});

	it('should hold every code the required run names', () => {
		// 95 of ASCII and the seven the format calls the Deutsch characters
		expect(WORDS.characters.size).toBe(102);
		expect(WORDS.characters.has(0x20)).toBe(true);
		expect(WORDS.characters.has(0x7e)).toBe(true);
		expect(WORDS.characters.has(0xdf)).toBe(true);
	});

	it('should read a column as one code point rather than one code unit', () => {
		// the padding is the cheap half of it: an astral character is one column, so a
		// row holding one is a column short of a two-column row beside it
		const font = parseFlf(fontOf({ A: ['\u{1F600}', 'xx'] }, 'flf2a$ 2 2 10 -1 0'));
		expect(font.characters.get(0x41)).toStrictEqual(['\u{1F600} ', 'xx']);
	});

	it('should pad a character whose rows disagree', () => {
		// a character is a rectangle. A font whose rows disagree would otherwise make
		// the same column index mean a different column per row
		const font = parseFlf(fontOf({ A: ['xx', 'x', 'xxx'] }));
		expect(font.characters.get(0x41)).toStrictEqual(['xx ', 'x  ', 'xxx']);
	});

	it('should read a row of nothing but endmarks as no columns at all', () => {
		// and the padding is then what makes the character a rectangle again
		const font = parseFlf(fontOf({ A: ['', 'xx', ''] }));
		expect(font.characters.get(0x41)).toStrictEqual(['  ', 'xx', '  ']);
	});
});

describe('parseFlf() on a file that is not one', () => {
	it('should refuse an empty file', () => {
		expect(() => parseFlf('')).toThrow(/Not a FIGlet font/);
	});

	it('should refuse another signature', () => {
		// `tlf2a` is TOIlet's format, which is the one somebody actually hands it
		expect(() => parseFlf('tlf2a$ 3 3 10 0 0\n')).toThrow(/Not a FIGlet font/);
	});

	it('should refuse a signature with nothing after it', () => {
		expect(() => parseFlf('flf2a')).toThrow(/needs a hardblank/);
	});

	it('should refuse a hardblank that is a space', () => {
		// which is how it arrives: the signature is five characters and the sixth is
		// the hardblank, so a font that left it out has a space there. A space
		// hardblank makes the one rule a hardblank exists for mean nothing
		expect(() => parseFlf('flf2a 3 3 10 0 0\n')).toThrow(/needs a hardblank/);
	});

	it('should refuse a hardblank that is a control character', () => {
		expect(() => parseFlf('flf2a\u0007 3 3 10 0 0\n')).toThrow(/needs a hardblank/);
	});

	it('should refuse a header with fewer than five numbers', () => {
		expect(() => parseFlf('flf2a$ 3 3 10 0\n')).toThrow(/five numbers/);
	});

	it.each(['3.5', 'six', '0x3', ''])('should refuse a height of "%s"', (height) => {
		expect(() => parseFlf(`flf2a$ ${height} 3 10 0 0\n`)).toThrow();
	});

	it('should refuse a field past what an integer can hold', () => {
		// what comes back is a different integer, which is the one failure a caller
		// cannot detect -- and a height like this reaches `Array.from()` as a length no
		// array can have
		expect(() => parseFlf('flf2a$ 99999999999999999999 3 10 0 0\n')).toThrow(/five numbers/);
	});

	it.each([0, -1])('should refuse a height of %i', (height) => {
		expect(() => parseFlf(`flf2a$ ${height} 3 10 0 0\n`)).toThrow(/height of/);
	});

	it('should refuse a negative comment count', () => {
		expect(() => parseFlf('flf2a$ 3 3 10 0 -1\n')).toThrow(/comment lines/);
	});

	it('should refuse a comment count that overruns the file', () => {
		expect(() => parseFlf('flf2a$ 3 3 10 0 40\nonly one comment\n')).toThrow(
			/40 comment lines and the file has 1/
		);
	});

	it('should refuse a print direction that is neither way', () => {
		expect(() => parseFlf('flf2a$ 3 3 10 0 0 2\n')).toThrow(/print direction of 2/);
	});

	it('should refuse a full layout that is not a number', () => {
		expect(() => parseFlf('flf2a$ 3 3 10 0 0 0 lots\n')).toThrow(/full layout of lots/);
	});
});

describe('parseFlf() on a file that has been through an editor', () => {
	it('should read past a byte order mark', () => {
		expect(parseFlf(`\uFEFF${fontOf({ A: ['x', 'x', 'x'] })}`).characters.get(0x41)).toStrictEqual([
			'x',
			'x',
			'x',
		]);
	});

	it('should read CRLF line endings', () => {
		// and the carriage return must not survive into a glyph: left on, it is the
		// last character of the line, so it becomes the endmark and the real one stays
		const font = parseFlf(fontOf({ A: ['x', 'x', 'x'] }).replaceAll('\n', '\r\n'));
		expect(font.characters.get(0x41)).toStrictEqual(['x', 'x', 'x']);
	});

	it('should read a file with only carriage returns', () => {
		const font = parseFlf(fontOf({ A: ['x', 'x', 'x'] }).replaceAll('\n', '\r'));
		expect(font.characters.get(0x41)).toStrictEqual(['x', 'x', 'x']);
	});
});

describe('parseFlf() on a file that stops early', () => {
	it('should read as far as it goes', () => {
		// a font that stops is read as far as it goes rather than refused: the
		// renderer has a defined answer for a character a font does not have, and the
		// required range is routinely cut short by fonts the reference implementation
		// loads
		const full = fontOf({ A: ['x', 'x', 'x'] });
		// with the file's own final newline, because a font that ends in one is the
		// ordinary case and an empty last line would otherwise be read as the last
		// row of a glyph
		const cut = `${full
			.split('\n')
			.slice(0, 1 + 34 * 3)
			.join('\n')}\n`;
		const font = parseFlf(cut);

		// 32 through 65 is thirty-four glyphs, so `A` is the last one in
		expect(font.characters.size).toBe(34);
		expect(font.characters.has(0x41)).toBe(true);
		expect(font.characters.has(0x42)).toBe(false);
	});

	it('should drop a character the file ran out in the middle of', () => {
		// a glyph shorter than `height` would break the one promise the component's
		// intrinsic size makes, so a partial one is not registered at all
		const full = fontOf({ A: ['x', 'x', 'x'] });
		const cut = `${full
			.split('\n')
			.slice(0, 1 + 34 * 3 - 1)
			.join('\n')}\n`;
		const font = parseFlf(cut);

		expect(font.characters.size).toBe(33);
		expect(font.characters.has(0x41)).toBe(false);
	});

	it('should read a font with no Deutsch characters', () => {
		const full = fontOf({ A: ['x', 'x', 'x'] });
		const cut = `${full
			.split('\n')
			.slice(0, 1 + 95 * 3)
			.join('\n')}\n`;

		expect(parseFlf(cut).characters.size).toBe(95);
	});
});

describe('parseFlf() and code tags', () => {
	/** A font with the required run and then whatever code tags are wanted. */
	const tagged = (tags: string): FigFont => parseFlf(`${fontOf({ A: ['x', 'x', 'x'] })}${tags}`);

	it.each([
		['945', 945],
		['0x3b1', 945],
		['0X3B1', 945],
		['01661', 945],
		['-2', -2],
		['+945', 945],
	])('should read the code "%s" as %i', (token, code) => {
		const font = tagged(`${token} GREEK SMALL LETTER ALPHA\na@\nb@\nc@@\n`);
		expect(font.characters.get(code)).toStrictEqual(['a', 'b', 'c']);
	});

	it('should refuse a code that is not a number', () => {
		expect(() => tagged('alpha\na@\nb@\nc@@\n')).toThrow(
			/is "alpha", which is not a character code/
		);
	});

	it('should skip a blank line between code tags', () => {
		// somebody's formatting. It cannot be glyph data, because glyph data carries
		// an endmark, so skipping it cannot put the read out of step
		const font = tagged('\n945\na@\nb@\nc@@\n\n946\nd@\ne@\nf@@\n');
		expect(font.characters.get(945)).toStrictEqual(['a', 'b', 'c']);
		expect(font.characters.get(946)).toStrictEqual(['d', 'e', 'f']);
	});

	it('should read every code tag there is, whatever the count field said', () => {
		// `Codetag_Count` is not read at all: the reference implementation ignores
		// it, and trusting it would stop reading early on a font whose count is
		// wrong -- which is a font missing characters it has, for a field nothing
		// needs
		const font = parseFlf(
			`${fontOf({ A: ['x'] }, 'flf2a$ 1 1 10 0 0 0 0 99')}945\na@@\n946\nb@@\n`
		);

		expect(font.characters.get(945)).toStrictEqual(['a']);
		expect(font.characters.get(946)).toStrictEqual(['b']);
	});

	it('should drop a code tag the file ran out of glyph rows for', () => {
		const font = parseFlf(`${fontOf({ A: ['x'] }, 'flf2a$ 1 1 10 -1 0')}945\n`);

		expect(font.characters.has(945)).toBe(false);
		expect(font.characters.size).toBe(102);
	});

	it('should let a code tag replace a required character', () => {
		const font = tagged('65\nQ@\nQ@\nQ@@\n');
		expect(font.characters.get(0x41)).toStrictEqual(['Q', 'Q', 'Q']);
	});
});

describe('the layout fields', () => {
	const layout = (header: string) => parseFlf(fontOf({}, header)).layout;

	it.each([
		[-1, 'full'],
		[0, 'kern'],
		[1, 'smush'],
		[15, 'smush'],
	])('should read an old layout of %i as %s', (old, mode) => {
		expect(layout(`flf2a$ 3 3 10 ${old} 0`).mode).toBe(mode);
	});

	it('should read an old layout as the rules its low five bits name', () => {
		expect(layout('flf2a$ 3 3 10 15 0').rules).toStrictEqual({
			bigX: false,
			equal: true,
			hardblank: false,
			hierarchy: true,
			pair: true,
			underscore: true,
		});
	});

	it('should read all six rules out of an old layout', () => {
		// the conversion is `(old & 63) | 128`, because the format documents bit 32 of
		// the old field as rule 6 exactly as it documents it in the new one. Masking
		// to five bits would turn an old layout of 32 -- smush, and only two
		// hardblanks -- into 128, which is universal smushing and merges everything
		expect(layout('flf2a$ 3 3 10 63 0').rules).toStrictEqual({
			bigX: true,
			equal: true,
			hardblank: true,
			hierarchy: true,
			pair: true,
			underscore: true,
		});
	});

	it.each([
		[0, 'full'],
		[64, 'kern'],
		[128, 'smush'],
		[64 | 128, 'smush'],
	])('should read a full layout of %i as %s', (bits, mode) => {
		expect(layout(`flf2a$ 3 3 10 0 0 0 ${bits}`).mode).toBe(mode);
	});

	// the precedence, which is the whole of what a font written across the format
	// change needs: the newer field wins and the older one is read only when the
	// header has none. Both directions, because intersecting them would agree with
	// the first and not the second
	it('should let a full layout beat an old layout that says less', () => {
		expect(layout('flf2a$ 3 3 10 -1 0 0 129').mode).toBe('smush');
		expect(layout('flf2a$ 3 3 10 -1 0 0 129').rules.equal).toBe(true);
	});

	it('should let a full layout beat an old layout that says more', () => {
		const read = layout('flf2a$ 3 3 10 15 0 0 64');
		expect(read.mode).toBe('kern');
		expect(read.rules.equal).toBe(false);
	});

	it('should read the vertical bits as nothing it has an answer for', () => {
		// 8192 is "fit vertically by default" and 16384 is "smush vertically", and
		// neither says anything about the horizontal mode. A font that sets only
		// those is a full-width font here
		expect(layout('flf2a$ 3 3 10 0 0 0 24576').mode).toBe('full');
	});
});

describe('the six horizontal smushing rules', () => {
	it('should smush two of the same character, under rule 1', () => {
		expect(joined('x', 'x', EQUAL)).toBe('-x-');
		expect(joined('x', 'y', EQUAL)).toBe('-xy-');
	});

	it('should give an underscore to a border character, under rule 2', () => {
		for (const border of ['|', '/', '\\', '[', ']', '{', '}', '(', ')', '<', '>']) {
			expect(joined('_', border, UNDERSCORE), `_ then ${border}`).toBe(`-${border}-`);
			expect(joined(border, '_', UNDERSCORE), `${border} then _`).toBe(`-${border}-`);
		}
		// and nothing else: an underscore beside a letter is two characters
		expect(joined('_', 'x', UNDERSCORE)).toBe('-_x-');
	});

	it('should let the later class win, under rule 3', () => {
		// the hierarchy is `|` then `/\` then `[]` then `{}` then `()` then `<>`
		expect(joined('|', '/', HIERARCHY)).toBe('-/-');
		expect(joined('/', '|', HIERARCHY)).toBe('-/-');
		expect(joined('[', '{', HIERARCHY)).toBe('-{-');
		expect(joined('(', '[', HIERARCHY)).toBe('-(-');
		expect(joined('<', '{', HIERARCHY)).toBe('-<-');
	});

	it('should leave one class alone, under rule 3', () => {
		// two of one class are two of the same thing, which is rule 1's business
		expect(joined('[', ']', HIERARCHY)).toBe('-[]-');
		expect(joined('/', '\\', HIERARCHY)).toBe('-/\\-');
	});

	it('should make a matched pair a bar, under rule 4', () => {
		expect(joined('[', ']', PAIR)).toBe('-|-');
		expect(joined(']', '[', PAIR)).toBe('-|-');
		expect(joined('{', '}', PAIR)).toBe('-|-');
		expect(joined('(', ')', PAIR)).toBe('-|-');
		// and an unmatched one is not a pair
		expect(joined('[', '}', PAIR)).toBe('-[}-');
	});

	it('should cross two slashes, under rule 5', () => {
		expect(joined('/', '\\', BIG_X)).toBe('-|-');
		expect(joined('\\', '/', BIG_X)).toBe('-Y-');
		expect(joined('>', '<', BIG_X)).toBe('-X-');
		// and deliberately not the other way round: `<` beside `>` is two brackets
		// facing away from each other, which is not a crossing
		expect(joined('<', '>', BIG_X)).toBe('-<>-');
	});

	it('should smush two hardblanks, under rule 6', () => {
		// and the result is a hardblank, which draws as a space
		expect(joined('$', '$', HARDBLANK)).toBe('- -');
	});

	it('should refuse a hardblank where rule 6 is off', () => {
		// the order of the rules is the whole of it: the hardblank rule comes first
		// because it is the one rule a hardblank takes part in, and everything after
		// it refuses one outright. Without that a hardblank would be smushed as an
		// ordinary character, which is the second of the two classic bugs
		expect(joined('$', '$', EQUAL)).toBe('-  -');
		expect(joined('$', 'x', EQUAL)).toBe('- x-');
		expect(joined('x', '$', EQUAL)).toBe('-x -');
	});

	it('should let the arriving character win, under universal smushing', () => {
		// smushing on and no rule selected, which is a thing a font says
		expect(joined('x', 'y', UNIVERSAL)).toBe('-y-');
		expect(joined('|', '/', UNIVERSAL)).toBe('-/-');
	});

	it('should let a hardblank give way to anything visible, under universal smushing', () => {
		expect(joined('$', 'x', UNIVERSAL)).toBe('-x-');
		expect(joined('x', '$', UNIVERSAL)).toBe('-x-');
	});
});

describe('a character one column wide', () => {
	/** `A` and `B` at the widths given, under rule 1, joined. */
	const narrow = (left: string, right: string): string => {
		const font = parseFlf(fontOf({ A: [left], B: [right] }, `flf2a$ 1 1 10 0 0 0 ${EQUAL}`));
		return renderFiglet('AB', font)[0] as string;
	};

	it('should kern rather than smush', () => {
		// the reference implementation's rule, and it is load bearing: a one-column
		// `|` merged into its neighbour is simply gone
		expect(narrow('-x', 'x')).toBe('-xx');
		expect(narrow('x', 'x-')).toBe('xx-');
	});

	it('should still smush where both are wider', () => {
		expect(narrow('-x', 'x-')).toBe('-x-');
	});
});

describe('the hardblank', () => {
	it('should draw as a space', () => {
		const font = parseFlf(fontOf({ A: ['$x$'] }, 'flf2a$ 1 1 10 -1 0'));
		expect(renderFiglet('A', font)).toStrictEqual([' x ']);
	});

	it('should be whatever the header says, so another character is itself', () => {
		// drawing a hardblank as a literal `$` is the classic first bug, and reading
		// a `$` as a hardblank in a font that nominated something else is the same
		// mistake pointing the other way
		const font = parseFlf(fontOf({ A: ['#x$'] }, 'flf2a# 1 1 10 -1 0'));
		expect(renderFiglet('A', font)).toStrictEqual([' x$']);
	});

	it('should keep a space character its width under smushing', () => {
		// which is what hardblanks are *for*. The space glyph is two hardblanks, so
		// the scan reads it as two visible columns and nothing slides into it
		const font = parseFlf(fontOf({ ' ': ['$$'], A: ['xx'] }, `flf2a$ 1 1 10 0 0 0 ${EQUAL}`));
		expect(renderFiglet('A A', font)).toStrictEqual(['xx  xx']);
	});

	it('should be the difference between that and a space glyph of spaces', () => {
		// the same font with a space drawn out of spaces, where the word gap
		// disappears entirely -- which is the behaviour hardblanks exist to avoid and
		// is what makes the rule above a claim rather than a coincidence
		const font = parseFlf(fontOf({ ' ': ['  '], A: ['xx'] }, `flf2a$ 1 1 10 0 0 0 ${EQUAL}`));
		expect(renderFiglet('A A', font)).toStrictEqual(['xxx']);
	});
});

describe('what an overlap can and cannot give up', () => {
	it('should not let a blank character slide past the start of the row', () => {
		// a three-column blank arriving on a one-column row can give up one column and
		// no more. Uncapped it would be merged at three, which is two columns before
		// the row begins -- and what reaches the screen is then the two columns it was
		// supposed to contribute, gone
		const font = parseFlf(fontOf({ A: ['x'], B: ['   '] }, 'flf2a$ 1 1 10 0 0'));
		expect(renderFiglet('AB', font)).toStrictEqual(['x  ']);
	});

	it('should never merge half of an astral character', () => {
		// and the expensive half: by code unit the join lands between the two halves of
		// the surrogate pair, the second is smushed away, and what reaches the screen
		// is a lone high surrogate -- which no terminal can draw and no decoder can
		// read. The overlap is two columns by code point and three by code unit, which
		// is the one place the two part company observably
		const font = parseFlf(
			fontOf({ A: ['y\u{1F600}'], B: ['  z'] }, `flf2a$ 1 1 10 0 0 0 ${UNIVERSAL}`)
		);
		expect(renderFiglet('AB', font)).toStrictEqual(['y\u{1F600}z']);
	});

	it('should let a blank give way to a hardblank rather than the other way round', () => {
		// which is the hardblank rule reached through the *order* the columns are
		// judged in: a blank gives way first, so the hardblank survives the merge --
		// and surviving is what keeps the next character from sliding into it. Read the
		// other way round the blank wins, the hardblank is gone, and the third
		// character lands a column early
		const font = parseFlf(
			fontOf({ A: ['x '], B: ['y$'], C: ['zz'] }, `flf2a$ 1 1 10 0 0 0 ${UNIVERSAL}`)
		);
		expect(renderFiglet('ABC', font)).toStrictEqual(['yzz']);
	});
});

describe('the three layout modes', () => {
	/** `-x ` then ` x-`, which comes out a different width in each mode. */
	const spaced = (bits: number): string => {
		const font = parseFlf(fontOf({ A: ['-x '], B: [' x-'] }, `flf2a$ 1 1 10 0 0 0 ${bits}`));
		return renderFiglet('AB', font)[0] as string;
	};

	it('should keep every column at full width', () => {
		expect(spaced(0)).toBe('-x  x-');
	});

	it('should overlap the blanks and no more when kerning', () => {
		expect(spaced(64)).toBe('-xx-');
	});

	it('should merge the columns that meet when smushing', () => {
		expect(spaced(EQUAL)).toBe('-x-');
	});

	it('should let the caller override what the font said', () => {
		const font = parseFlf(fontOf({ A: ['-x '], B: [' x-'] }, `flf2a$ 1 1 10 0 0 0 ${EQUAL}`));

		expect(renderFiglet('AB', font, { layout: 'full' })[0]).toBe('-x  x-');
		expect(renderFiglet('AB', font, { layout: 'kern' })[0]).toBe('-xx-');
		expect(renderFiglet('AB', font, { layout: 'smush' })[0]).toBe('-x-');
	});

	it('should smush universally where a full-width font is forced to', () => {
		// a font that declares full width names no rules, so there is nothing for a
		// forced smush to judge by and the arriving character wins
		const font = parseFlf(fontOf({ A: ['-x'], B: ['y-'] }, 'flf2a$ 1 1 10 -1 0'));
		expect(renderFiglet('AB', font, { layout: 'smush' })[0]).toBe('-y-');
	});
});

describe('renderFiglet()', () => {
	it('should answer with nothing for an empty string', () => {
		expect(renderFiglet('', WORDS)).toStrictEqual([]);
	});

	it('should answer with a rectangle', () => {
		const rows = renderFiglet('AB', WORDS);
		expect(rows).toHaveLength(3);
		expect(new Set(rows.map((row) => row.length)).size).toBe(1);
	});

	it('should lay a word out', () => {
		// a picture rather than three numbers, which is the rule the layout tests
		// already keep: the blanks between the glyphs are what kerning did
		expect(renderFiglet('ABC', WORDS)).toStrictEqual([' _ __  _ ', '/_\\|_)/  ', '/ \\|_)\\_ ']);
	});

	it('should break a line on a newline and stack the blocks', () => {
		const rows = renderFiglet('A\nA', WORDS);
		expect(rows).toHaveLength(6);
		expect(rows.slice(0, 3)).toStrictEqual(rows.slice(3));
	});

	it('should pad every line of a multi-line banner to the widest', () => {
		const rows = renderFiglet('A\nAB', WORDS);
		expect(new Set(rows.map((row) => row.length)).size).toBe(1);
	});

	it('should leave a character the font does not have out', () => {
		// the format's own answer, and the only one that does not invent a glyph the
		// font's author did not draw
		const font = parseFlf(fontOf({ A: ['x'] }, 'flf2a$ 1 1 10 -1 0'));
		expect(renderFiglet('A\u2603A', font)).toStrictEqual(['xx']);
	});

	it('should use the glyph at code 0 for a character the font does not have', () => {
		const font = parseFlf(`${fontOf({ A: ['x'] }, 'flf2a$ 1 1 10 -1 0')}0\n?@@\n`);
		expect(renderFiglet('A\u2603A', font)).toStrictEqual(['x?x']);
	});

	it('should look a character up by code point rather than by code unit', () => {
		// an astral character is one lookup, not two halves of one that neither
		// matches -- which is what decides whether it is missing or half-missing
		const font = parseFlf(`${fontOf({ A: ['x'] }, 'flf2a$ 1 1 10 -1 0')}0x1F600\n:@@\n`);
		expect(renderFiglet('\u{1F600}', font)).toStrictEqual([':']);
	});

	it('should refuse a font that declares a right-to-left print direction', () => {
		// parsed and reported rather than rendered the wrong way round, which is the
		// rule a property the engine ignores already follows one layer along
		const font = parseFlf(fontOf({ A: ['x'] }, 'flf2a$ 1 1 10 -1 0 1'));
		expect(font.direction).toBe('rtl');
		expect(() => renderFiglet('A', font)).toThrow(/right-to-left/);
	});

	it('should draw nothing for a font with no characters in it', () => {
		// a line that produced no columns is still a line, so it is still `height`
		// rows -- which is what keeps a multi-line banner's blocks lined up
		const font = parseFlf('flf2a$ 2 2 10 -1 0\n');

		expect(font.characters.size).toBe(0);
		expect(renderFiglet('A', font)).toStrictEqual(['', '']);
	});

	it('should not trust the max length the header claims', () => {
		// the field is read past and never kept: the width comes from the glyphs
		const font = parseFlf(fontOf({ A: ['xxxxx'] }, 'flf2a$ 1 1 1 -1 0'));
		expect(renderFiglet('A', font)).toStrictEqual(['xxxxx']);
	});
});

describe('largeTextView()', () => {
	it('should measure to the rows by the widest row', () => {
		// the intrinsic size, asked of the layout engine the way anything placing it
		// would ask: `font.height` rows by the widest row, with nothing above it
		// needing to know a banner is what it is holding
		const { element, width } = largeTextView('AB', { font: WORDS });
		const rows = renderFiglet('AB', WORDS);

		expect(width).toBe(rows[0]?.length);
		expect(measureNode(element, 80)).toMatchObject({ height: 3, width });
	});

	it('should measure a wide glyph by what it draws rather than by its columns', () => {
		// the column arithmetic above is per code point, which is what the format
		// assumes, and the box has to be the width that will be *drawn* -- so a font
		// whose glyphs are wide characters is measured the way the layout engine
		// measures everything else
		const font = parseFlf(fontOf({ A: ['\u6f22'] }, 'flf2a$ 1 1 10 -1 0'));

		expect(renderFiglet('A', font)).toStrictEqual(['\u6f22']);
		expect(largeTextView('A', { font }).width).toBe(2);
	});

	it('should measure a glyph holding a tab by what the tab draws', () => {
		// a tab measures nothing and draws a space, so a box sized by the raw row is a
		// column too narrow -- and `text-overflow` bites on a `nowrap` line that does
		// not fit, so what the caller would lose is the last column of the banner
		const font = parseFlf(fontOf({ A: ['x\tx'] }, 'flf2a$ 1 1 10 -1 0'));

		expect(largeTextView('A', { font }).width).toBe(3);
		expect(largeText('A', { colorLevel: 0, font })).toBe('x x');
	});

	it('should be one row for an empty banner, and at least one column wide', () => {
		// `renderToString()` lays out in at least one column, so a width of zero is
		// not a width anything can be asked for
		expect(largeTextView('', { font: WORDS }).width).toBe(1);
	});

	it('should keep its own width in a container narrower than the banner', () => {
		// a `nowrap` text's automatic minimum is its widest line, so there is nothing
		// to squeeze -- which is what makes a banner longer than the terminal run
		// past the edge rather than be cut, the rule help already keeps for a flag
		// name too wide for its column
		const { element } = largeTextView('ABC', { font: WORDS });
		const out = renderToString(box({ width: 4 }, element), { colorLevel: 0, width: 4 });

		expect(out.split('\n')).toStrictEqual(renderFiglet('ABC', WORDS).map((row) => row.trimEnd()));
	});
});

describe('largeText()', () => {
	it('should print the banner', () => {
		// trailing blanks go, which is what reading a grid back as lines does
		expect(largeText('AB', { colorLevel: 0, font: WORDS })).toBe(
			renderFiglet('AB', WORDS)
				.map((row) => row.trimEnd())
				.join('\n')
		);
	});

	it('should be nothing for an empty string', () => {
		expect(largeText('', { colorLevel: 0, font: WORDS })).toBe('');
	});

	it('should stack the lines of a multi-line banner', () => {
		// the newlines go into one `text`, which keeps the breaks the caller wrote --
		// so a two-line banner is two blocks and not a line that wrapped
		const out = largeText('A\nB', { colorLevel: 0, font: WORDS }).split('\n');

		expect(out).toHaveLength(6);
		expect(out.slice(0, 3)).toStrictEqual(
			largeText('A', { colorLevel: 0, font: WORDS }).split('\n')
		);
	});

	it('should inherit a colour rather than naming one', () => {
		// every cell is still one cell, so a banner takes its colour from whatever it
		// was put inside -- which is only true because nothing in the component names
		// one
		const { element } = largeTextView('A', { font: WORDS });
		const out = renderToString(box({ class: 'shout' }, element), {
			cascade: themedCascade({ sheets: ['.shout { color: red; font-weight: bold }'] }),
			colorLevel: 1,
			width: 8,
		});

		expect(out).toContain('[1;31m');
	});

	it('should let a theme reach the body', () => {
		expect(
			largeText('A', {
				colorLevel: 1,
				font: WORDS,
				theme: '.sigil-large-text-body { color: magenta }',
			})
		).toContain('[35m');
	});
});
