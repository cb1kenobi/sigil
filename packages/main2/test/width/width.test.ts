import { ansi } from '../../src/ansi/index.js';
import {
	charWidth,
	graphemes,
	graphemeWidth,
	stringWidth,
	unicodeVersion,
	wideRanges,
} from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// The invisible characters, named. A `\u` escape in a string literal is
// normalized by the formatter into the character itself, which would leave a
// test full of combining marks and joiners that cannot be read or edited.
const ACUTE = String.fromCodePoint(0x301); // combining acute accent
const CIRCUMFLEX = String.fromCodePoint(0x302); // combining circumflex
const TILDE = String.fromCodePoint(0x303); // combining tilde
const ZWJ = String.fromCodePoint(0x200d); // zero width joiner
const ZWSP = String.fromCodePoint(0x200b); // zero width space
const BOM = String.fromCodePoint(0xfeff); // byte order mark
const SHY = String.fromCodePoint(0xad); // soft hyphen
const VS15 = String.fromCodePoint(0xfe0e); // text presentation selector
const VS16 = String.fromCodePoint(0xfe0f); // emoji presentation selector
const KEYCAP = String.fromCodePoint(0x20e3); // combining enclosing keycap
const HEART = String.fromCodePoint(0x2764); // heavy black heart, text by default
const GRINNING = String.fromCodePoint(0x1f600);
const THUMBS_UP = String.fromCodePoint(0x1f44d);
const SKIN_TONE = String.fromCodePoint(0x1f3ff); // emoji modifier fitzpatrick 6

// a decomposed Hangul syllable: leading consonant, medial vowel, trailing
// consonant, which a terminal draws as one two-column syllable
const HANGUL_KAK =
	String.fromCodePoint(0x1100) + String.fromCodePoint(0x1161) + String.fromCodePoint(0x11a8);

const COPYRIGHT = String.fromCodePoint(0xa9); // an emoji character that is narrow as text
const ARABIC_NUMBER_SIGN = String.fromCodePoint(0x600); // invisible, and prefixes its base
const DOT_REPH = String.fromCodePoint(0xd4e); // visible, and also prefixes its base

// a base plus a spacing vowel sign, which advances the cursor rather than
// drawing on top of the base
const DEVANAGARI_KA = String.fromCodePoint(0x915) + String.fromCodePoint(0x93e);
const TAMIL_KA = String.fromCodePoint(0xb95) + String.fromCodePoint(0xbbe);
const THAI_KAM = String.fromCodePoint(0xe01) + String.fromCodePoint(0xe33);
// consonant, virama, consonant: the virama is a nonspacing mark, the second
// consonant is not
const DEVANAGARI_KSHA =
	String.fromCodePoint(0x915) + String.fromCodePoint(0x94d) + String.fromCodePoint(0x937);

const FAMILY = [0x1f468, 0x1f469, 0x1f467, 0x1f466].map((c) => String.fromCodePoint(c)).join(ZWJ);
const FLAG_US = String.fromCodePoint(0x1f1fa) + String.fromCodePoint(0x1f1f8);

describe('stringWidth()', () => {
	it('should count an ASCII string as its length', () => {
		expect(stringWidth('')).toBe(0);
		expect(stringWidth('hello')).toBe(5);
		expect(stringWidth('  --verbose  ')).toBe(13);
	});

	it('should count Latin text with combining marks once per character', () => {
		expect(stringWidth('café')).toBe(4);
		// the same word decomposed: e plus a combining acute
		expect(stringWidth(`cafe${ACUTE}`)).toBe(4);
		expect(stringWidth(`a${ACUTE}${CIRCUMFLEX}${TILDE}`)).toBe(1);
	});

	it('should count East Asian characters as two columns each', () => {
		expect(stringWidth('日本語')).toBe(6);
		expect(stringWidth('한국어')).toBe(6);
		expect(stringWidth('你好')).toBe(4);
		// the fullwidth forms of ASCII
		expect(stringWidth('ＡＢ')).toBe(4);
		// halfwidth katakana is one column, unlike the fullwidth kind
		expect(stringWidth('ｶﾅ')).toBe(2);
	});

	it('should mix widths in one string', () => {
		expect(stringWidth('a日b')).toBe(4);
		expect(stringWidth('Usage: ビルド')).toBe(13);
	});

	it('should count an emoji as two columns however many code units it is', () => {
		expect(stringWidth(GRINNING)).toBe(2);
		// a four person family: eleven code units joined by ZWJ, still one cluster
		expect(FAMILY).toHaveLength(11);
		expect(stringWidth(FAMILY)).toBe(2);
		// a flag: two regional indicators, four code units
		expect(FLAG_US).toHaveLength(4);
		expect(stringWidth(FLAG_US)).toBe(2);
		// a keycap: digit, presentation selector, enclosing keycap
		expect(stringWidth(`1${VS16}${KEYCAP}`)).toBe(2);
		// a skin tone modifier joins the cluster rather than adding to it
		expect(stringWidth(THUMBS_UP + SKIN_TONE)).toBe(2);
	});

	// the selector is what turns a text-presentation character into an emoji, so
	// it is the difference between one column and two
	it('should read the emoji presentation selector', () => {
		expect(stringWidth(HEART)).toBe(1);
		expect(stringWidth(HEART + VS16)).toBe(2);
		// and the text presentation selector leaves it narrow
		expect(stringWidth(HEART + VS15)).toBe(1);
	});

	// a cluster is its base plus what attaches to it, and a spacing mark attaches
	// by advancing the cursor rather than by drawing on top
	it('should count a spacing mark as the column it takes', () => {
		expect(graphemes(DEVANAGARI_KA)).toHaveLength(1);
		expect(stringWidth(DEVANAGARI_KA)).toBe(2);
		expect(stringWidth(TAMIL_KA)).toBe(2);
		expect(stringWidth(THAI_KAM)).toBe(2);
		expect(stringWidth(DEVANAGARI_KSHA)).toBe(2);
	});

	// the base of a cluster is not always the first thing in it
	it('should measure a cluster whose base is not first', () => {
		expect(graphemes(ARABIC_NUMBER_SIGN + '1')).toHaveLength(1);
		expect(stringWidth(ARABIC_NUMBER_SIGN + '1')).toBe(1);
		expect(stringWidth(DOT_REPH + String.fromCodePoint(0xd15))).toBe(2);
	});

	// the selector is a nonspacing mark, so a cluster may carry one for reasons
	// that have nothing to do with emoji
	it('should only let the selector widen something that can be an emoji', () => {
		expect(stringWidth(VS16)).toBe(0);
		expect(stringWidth(`a${VS16}`)).toBe(1);
		expect(stringWidth(`${ACUTE}${VS16}`)).toBe(0);
		// a digit can be, which is what makes a keycap two columns
		expect(stringWidth(`1${VS16}`)).toBe(2);
		expect(stringWidth(`#${VS16}`)).toBe(2);
	});

	// the selector selects the presentation of the character in front of it, so
	// one that is not in front of the base is selecting nothing
	it('should ignore a selector that is not next to the base', () => {
		expect(stringWidth(COPYRIGHT + VS16)).toBe(2);
		expect(graphemes(COPYRIGHT + ACUTE + VS16)).toHaveLength(1);
		expect(stringWidth(COPYRIGHT + ACUTE + VS16)).toBe(1);
	});

	// UTS #51 spells a keycap as digit, selector, enclosing keycap, and the
	// selector is what asks for the emoji. Without it this is a digit with a mark
	// on it, and one column is the answer that follows from reading the selector
	// at all.
	it('should count a keycap without the selector as one column', () => {
		expect(stringWidth(`1${KEYCAP}`)).toBe(1);
	});

	it('should count zero-width characters as nothing', () => {
		expect(stringWidth(`a${ZWSP}b`)).toBe(2);
		expect(stringWidth(`a${ZWJ}b`)).toBe(2);
		expect(stringWidth(`${BOM}ab`)).toBe(2);
		expect(stringWidth(`a${SHY}b`)).toBe(2);
		expect(stringWidth(`a${ACUTE}`)).toBe(1);
	});

	it('should strip escape sequences before measuring', () => {
		ansi.level = 3;
		try {
			expect(stringWidth(ansi.red('hello'))).toBe(5);
			expect(stringWidth(ansi.bold.underline.bgBlue('hi'))).toBe(2);
			expect(stringWidth(ansi.hex('#5f87af')('日本'))).toBe(4);
			expect(stringWidth(`${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`)).toBe(4);
		} finally {
			ansi.level = undefined;
		}
	});

	it('should count a tab and a newline as nothing', () => {
		// they have an effect rather than a width; the caller expands and splits
		expect(stringWidth('a\tb')).toBe(2);
		expect(stringWidth('a\nb')).toBe(2);
	});

	it('should count a lone surrogate as one column rather than throwing', () => {
		expect(stringWidth(String.fromCharCode(0xd800))).toBe(1);
		expect(stringWidth(`a${String.fromCharCode(0xdc00)}b`)).toBe(3);
	});
});

describe('graphemes()', () => {
	it('should split on what a terminal draws as one character', () => {
		expect(graphemes('abc')).toEqual(['a', 'b', 'c']);
		expect(graphemes(`cafe${ACUTE}`)).toEqual(['c', 'a', 'f', `e${ACUTE}`]);
		expect(graphemes(`${FLAG_US}!`)).toEqual([FLAG_US, '!']);
		expect(graphemes(FAMILY)).toEqual([FAMILY]);
	});

	it('should measure a decomposed Hangul syllable as one syllable', () => {
		// the leading consonant is wide and carries the syllable's two columns; the
		// medial vowel and final consonant draw inside it
		expect(stringWidth(HANGUL_KAK)).toBe(2);
		expect(stringWidth('각')).toBe(2);
		expect(charWidth(0x1161)).toBe(0);
		expect(charWidth(0x11a8)).toBe(0);
		expect(charWidth(0xd7b0)).toBe(0);
	});

	it('should keep a decomposed Hangul syllable in one cluster', () => {
		expect(HANGUL_KAK).toHaveLength(3);
		expect(graphemes(HANGUL_KAK)).toEqual([HANGUL_KAK]);
	});

	it('should leave escape sequences where they are', () => {
		// a wrapper needs them in place, and a caller that wants them gone strips
		expect(graphemes(`${ESC}[31ma`)).toContain('a');
		expect(graphemes(`${ESC}[31ma`).join('')).toBe(`${ESC}[31ma`);
	});

	it('should return nothing for an empty string', () => {
		expect(graphemes('')).toEqual([]);
	});
});

describe('graphemeWidth()', () => {
	it('should measure a cluster by what it starts with', () => {
		expect(graphemeWidth('a')).toBe(1);
		expect(graphemeWidth(`e${ACUTE}`)).toBe(1);
		expect(graphemeWidth('日')).toBe(2);
		expect(graphemeWidth(GRINNING)).toBe(2);
		expect(graphemeWidth('')).toBe(0);
		expect(graphemeWidth(ACUTE)).toBe(0);
		expect(graphemeWidth(VS16)).toBe(0);
	});

	// the leading jamo of a decomposed syllable is wide and the rest of the
	// cluster draws inside it, which the first-character rule gets right on its
	// own
	it('should measure a decomposed Hangul syllable as two columns', () => {
		expect(graphemeWidth(HANGUL_KAK)).toBe(2);
		expect(stringWidth(HANGUL_KAK)).toBe(2);
	});
});

describe('charWidth()', () => {
	it('should measure ASCII as one', () => {
		expect(charWidth(0x20)).toBe(1);
		expect(charWidth(0x41)).toBe(1);
		expect(charWidth(0x7e)).toBe(1);
	});

	it('should measure the controls as zero', () => {
		expect(charWidth(0x00)).toBe(0);
		expect(charWidth(0x09)).toBe(0);
		expect(charWidth(0x1b)).toBe(0);
		expect(charWidth(0x7f)).toBe(0);
		expect(charWidth(0x9b)).toBe(0);
	});

	it('should measure the wide and fullwidth ranges as two', () => {
		expect(charWidth(0x1100)).toBe(2); // hangul choseong kiyeok
		expect(charWidth(0x3000)).toBe(2); // ideographic space
		expect(charWidth(0x4e00)).toBe(2); // CJK unified ideograph
		expect(charWidth(0xff01)).toBe(2); // fullwidth exclamation
		expect(charWidth(0x20000)).toBe(2); // plane 2
	});

	// the data file says unassigned code points in these blocks are wide, and a
	// CJK ideograph Unicode has reserved but not yet assigned is still two
	// columns
	it('should measure the default-wide blocks as two', () => {
		expect(charWidth(0x3400)).toBe(2);
		expect(charWidth(0x4dbf)).toBe(2);
		expect(charWidth(0xfaff)).toBe(2);
		expect(charWidth(0x2fffd)).toBe(2);
		expect(charWidth(0x3fffd)).toBe(2);
	});

	it('should measure everything else as one', () => {
		expect(charWidth(0x00e9)).toBe(1); // e acute
		expect(charWidth(0x0410)).toBe(1); // cyrillic A
		expect(charWidth(0x05d0)).toBe(1); // hebrew alef
		expect(charWidth(0xff61)).toBe(1); // halfwidth ideographic full stop
		expect(charWidth(0x2500)).toBe(1); // box drawing light horizontal
	});

	// Ambiguous is two columns only in a legacy East Asian context and one
	// everywhere else, and one is the better default for a CLI
	it('should measure an ambiguous width character as one', () => {
		expect(charWidth(0x00a1)).toBe(1); // inverted exclamation
		expect(charWidth(0x2010)).toBe(1); // hyphen
		expect(charWidth(0x25a0)).toBe(1); // black square
	});
});

describe('the generated table', () => {
	it('should be sorted, disjoint, and whole pairs', () => {
		expect(wideRanges.length % 2).toBe(0);
		expect(wideRanges.length).toBeGreaterThan(0);

		for (let i = 0; i < wideRanges.length; i += 2) {
			const start = wideRanges[i]!;
			const end = wideRanges[i + 1]!;
			expect(start).toBeLessThanOrEqual(end);
			if (i > 0) {
				// coalesced, so there is always a gap of at least one code point
				expect(start).toBeGreaterThan(wideRanges[i - 1]! + 1);
			}
		}
	});

	it('should record the Unicode version it came from', () => {
		expect(unicodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
	});

	// a truncated data file parses into a handful of ranges rather than failing,
	// so the count and a few anchors are what says the table is whole. The
	// generator checks the same things before it writes.
	it('should cover the characters a whole table has to cover', () => {
		expect(wideRanges.length / 2).toBeGreaterThanOrEqual(100);
		for (const codePoint of [0x1100, 0x3000, 0x4e00, 0xac00, 0xf900, 0xff01, 0x1f600, 0x20000]) {
			expect(charWidth(codePoint), codePoint.toString(16)).toBe(2);
		}
		for (const codePoint of [0x41, 0x20, 0x00e9]) {
			expect(charWidth(codePoint), codePoint.toString(16)).toBe(1);
		}
	});
});
