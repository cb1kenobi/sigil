import { ansi } from '../../src/ansi/index.js';
import { stringWidth } from '../../src/width/index.js';
import { DEFAULT_WIDTH, MAX_WIDTH, terminalWidth, tokenize, wrap } from '../../src/wrap/index.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);
const ZWJ = String.fromCodePoint(0x200d);
const FLAG_US = String.fromCodePoint(0x1f1fa) + String.fromCodePoint(0x1f1f8);
const FAMILY = [0x1f468, 0x1f469, 0x1f467, 0x1f466].map((c) => String.fromCodePoint(c)).join(ZWJ);

const SENTENCE = 'the quick brown fox jumps over the lazy dog';

/** The wrapped text as lines, which is what every assertion here is about. */
function lines(text: string): string[] {
	return text.split('\n');
}

/** Asserts that no line is wider than the width it was wrapped to. */
function expectWithin(text: string, width: number) {
	for (const line of lines(text)) {
		expect(stringWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width);
	}
}

describe('terminalWidth()', () => {
	it('should read the stream', () => {
		expect(terminalWidth({ env: {}, stream: { columns: 60 } })).toBe(60);
	});

	it('should fall back when there is no terminal to ask', () => {
		expect(terminalWidth({ env: {}, stream: undefined })).toBe(DEFAULT_WIDTH);
		expect(terminalWidth({ env: {}, stream: {} })).toBe(DEFAULT_WIDTH);
		expect(terminalWidth({ env: {}, stream: undefined, fallback: 72 })).toBe(72);
	});

	// a terminal's width is a ceiling on how much room there is, not an
	// instruction to use all of it
	it('should cap a very wide terminal', () => {
		expect(terminalWidth({ env: {}, stream: { columns: 400 } })).toBe(MAX_WIDTH);
		expect(terminalWidth({ env: {}, stream: { columns: 400 }, max: 120 })).toBe(120);
		expect(terminalWidth({ env: {}, stream: { columns: 400 }, max: Infinity })).toBe(400);
	});

	// it is how a caller says what to use when the stream cannot be asked, and
	// how a test says it without a pseudo-terminal
	it('should prefer COLUMNS', () => {
		expect(terminalWidth({ env: { COLUMNS: '55' }, stream: { columns: 60 } })).toBe(55);
		expect(terminalWidth({ env: { COLUMNS: '55' }, stream: undefined })).toBe(55);
		// and cap it like any other width
		expect(terminalWidth({ env: { COLUMNS: '400' }, stream: undefined })).toBe(MAX_WIDTH);
	});

	it('should ignore a COLUMNS that is not a width', () => {
		// the whole string, not as much of it as parses: `12junk` is not somebody
		// saying twelve
		for (const COLUMNS of ['', 'wide', '0', '-10', 'NaN', '12junk', '1.5', '0x20']) {
			expect(terminalWidth({ env: { COLUMNS }, stream: { columns: 60 } }), COLUMNS).toBe(60);
		}
	});

	it('should ignore a stream width that is not a width', () => {
		expect(terminalWidth({ env: {}, stream: { columns: 0 } })).toBe(DEFAULT_WIDTH);
		expect(terminalWidth({ env: {}, stream: { columns: Number.NaN } })).toBe(DEFAULT_WIDTH);
		expect(terminalWidth({ env: {}, stream: { columns: Infinity } })).toBe(DEFAULT_WIDTH);
	});

	// a cap or a fallback that is not a width is no instruction at all, and
	// carrying it through would come back out as the answer
	it('should ignore a cap or a fallback that is not a width', () => {
		expect(terminalWidth({ env: {}, max: Number.NaN, stream: { columns: 20 } })).toBe(20);
		expect(terminalWidth({ env: {}, max: 0, stream: { columns: 400 } })).toBe(MAX_WIDTH);
		expect(terminalWidth({ env: {}, fallback: Number.NaN, stream: undefined })).toBe(DEFAULT_WIDTH);
		expect(terminalWidth({ env: {}, fallback: -5, stream: undefined })).toBe(DEFAULT_WIDTH);
	});
});

describe('wrap()', () => {
	it('should fill each line as far as it goes', () => {
		expect(lines(wrap(SENTENCE, 20))).toEqual([
			'the quick brown fox',
			'jumps over the lazy',
			'dog',
		]);
		expectWithin(wrap(SENTENCE, 20), 20);
	});

	it('should take a width on its own', () => {
		expect(wrap(SENTENCE, 20)).toBe(wrap(SENTENCE, { width: 20 }));
	});

	it('should put a word that exactly fills the line on that line', () => {
		expect(lines(wrap('aaa bbb', 7))).toEqual(['aaa bbb']);
		expect(lines(wrap('aaa bbb', 6))).toEqual(['aaa', 'bbb']);
	});

	it('should leave text that fits alone', () => {
		expect(wrap('short', 20)).toBe('short');
		expect(wrap('', 20)).toBe('');
	});

	it('should not leave the space it broke at on the end of the line', () => {
		for (const line of lines(wrap(SENTENCE, 20))) {
			expect(line).toBe(line.trimEnd());
		}
	});

	it('should keep the newlines already in the text', () => {
		expect(lines(wrap('one two\nthree four', 20))).toEqual(['one two', 'three four']);
		expect(lines(wrap('a\n\nb', 20))).toEqual(['a', '', 'b']);
		expect(lines(wrap('a\r\nb', 20))).toEqual(['a', 'b']);
	});

	it('should keep the leading whitespace of a line', () => {
		expect(lines(wrap('  indented already', 20))).toEqual(['  indented already']);
	});

	// a terminal draws nothing for it, it is what a break at a space leaves
	// behind anyway, and leaving it makes a measured line wider than anything
	// anybody can see
	it('should drop trailing whitespace even from a line it did not wrap', () => {
		expect(wrap('x   ', 10)).toBe('x');
		expect(wrap('   ', 5)).toBe('');
		expect(wrap('a   \nb  ', 20)).toBe('a\nb');
	});

	it('should keep a run of spaces inside a line', () => {
		expect(wrap('a   b', 20)).toBe('a   b');
	});

	// the spaces in front of the first word are the text's own indentation; the
	// same spaces after a break are what the break left behind
	it('should keep leading whitespace even when the first word does not fit', () => {
		expect(lines(wrap('  abcde', 5))).toEqual(['  abc', 'de']);
		expect(lines(wrap('  aaa bbb', 5))).toEqual(['  aaa', 'bbb']);
	});
});

describe('indenting', () => {
	it('should indent every line, and count it against the width', () => {
		const wrapped = wrap(SENTENCE, { width: 24, indent: 4 });
		expect(lines(wrapped)).toEqual([
			'    the quick brown fox',
			'    jumps over the lazy',
			'    dog',
		]);
		expectWithin(wrapped, 24);
	});

	// the first line carries the term and what wraps under it lines up with the
	// definition, which is what a two-column list is
	it('should hang the lines after the first', () => {
		const wrapped = wrap(SENTENCE, { hangingIndent: 6, width: 24 });
		expect(lines(wrapped)).toEqual([
			'the quick brown fox',
			'      jumps over the',
			'      lazy dog',
		]);
		expectWithin(wrapped, 24);
	});

	// the term a hanging indent hangs from is printed once, so everything under
	// it lines up, including what follows a newline already in the text
	it('should hang from the first line of the output, not of each paragraph', () => {
		expect(lines(wrap('A\nbbbbbbbb', { hangingIndent: 4, width: 8 }))).toEqual([
			'A',
			'    bbbb',
			'    bbbb',
		]);
	});

	it('should add a hanging indent on top of an indent', () => {
		expect(lines(wrap(SENTENCE, { hangingIndent: 2, indent: 4, width: 24 }))).toEqual([
			'    the quick brown fox',
			'      jumps over the',
			'      lazy dog',
		]);
	});

	it('should take an indent as the string to use', () => {
		expect(lines(wrap(SENTENCE, { indent: '> ', width: 22 }))).toEqual([
			'> the quick brown fox',
			'> jumps over the lazy',
			'> dog',
		]);
	});

	it('should not indent a blank line', () => {
		expect(lines(wrap('a\n\nb', { indent: 4, width: 20 }))).toEqual(['    a', '', '    b']);
	});

	// an indent as wide as the width leaves nowhere to put the text; one column
	// is the least that can hold anything, and it is better than looping
	it('should leave one column when the indent takes the whole width', () => {
		const wrapped = wrap('ab', { indent: 10, width: 10 });
		expect(lines(wrapped)).toEqual(['          a', '          b']);
	});
});

describe('a word too long for a line', () => {
	const url = 'https://example.com/a/very/long/path';

	it('should break between characters by default', () => {
		const wrapped = wrap(`see ${url} now`, 20);
		expectWithin(wrapped, 20);
		expect(lines(wrapped)[0]).toBe('see');
		expect(wrapped.replace(/\n/g, '')).toContain('https://example.com/');
	});

	it('should let it overflow when asked to', () => {
		const wrapped = wrap(`see ${url} now`, { hard: false, width: 20 });
		expect(lines(wrapped)).toEqual(['see', url, 'now']);
	});

	it('should break a word that is the whole text', () => {
		expect(lines(wrap('aaaaaaaaaa', 4))).toEqual(['aaaa', 'aaaa', 'aa']);
	});

	it('should not break inside a grapheme cluster', () => {
		// four flags, eight columns, wrapped to five: the break cannot fall inside
		// one of them
		const wrapped = wrap(FLAG_US.repeat(4), 5);
		expect(lines(wrapped)).toEqual([FLAG_US.repeat(2), FLAG_US.repeat(2)]);
		expectWithin(wrapped, 5);
	});

	it('should not split a family emoji into its members', () => {
		const wrapped = wrap(`${FAMILY} ${FAMILY}`, 3);
		expect(lines(wrapped)).toEqual([FAMILY, FAMILY]);
	});

	it('should keep a wide character whole when only one column is left', () => {
		// there is nowhere for a two-column character to go in one column, so it
		// takes the two it needs rather than being cut in half
		expect(lines(wrap('日本', 3))).toEqual(['日', '本']);
	});
});

describe('styled text', () => {
	const styled = (fn: () => void) => {
		ansi.level = 3;
		try {
			fn();
		} finally {
			ansi.level = undefined;
		}
	};

	it('should not count a sequence as a column', () => {
		styled(() => {
			const wrapped = wrap(`${ansi.red('the quick brown')} fox jumps`, 20);
			expect(lines(wrapped).map((line) => stringWidth(line))).toEqual([19, 5]);
		});
	});

	it('should never break inside a sequence', () => {
		styled(() => {
			// a truecolor sequence is nineteen characters and no columns; a wrapper
			// counting characters would cut it in half
			const wrapped = wrap(ansi.hex('#5f87af')('aaa bbb ccc ddd'), 7);
			for (const line of lines(wrapped)) {
				expect(line).not.toMatch(new RegExp(`${ESC}\\[[\\d;:]*$`));
				expect(line.split(ESC).length - 1).toBe(2);
			}
		});
	});

	// a style left open across a break bleeds into the next line's indent, which
	// for a background color is visible
	it('should close a style at a break and open it again after', () => {
		styled(() => {
			expect(lines(wrap(ansi.bgRed('aaa bbb'), 3))).toEqual([
				`${ESC}[41maaa${ESC}[49m`,
				`${ESC}[41mbbb${ESC}[49m`,
			]);
		});
	});

	it('should carry a style across a newline already in the text', () => {
		styled(() => {
			expect(lines(wrap(ansi.bgRed('aaa\nbbb'), 10))).toEqual([
				`${ESC}[41maaa${ESC}[49m`,
				`${ESC}[41mbbb${ESC}[49m`,
			]);
		});
	});

	it('should reopen every style that was open, as one sequence', () => {
		styled(() => {
			const wrapped = lines(wrap(ansi.bold.underline.red('aaa bbb'), 3));
			// the first line closes all three in one sequence, and the second opens
			// all three in one. The closes at the very end are the text's own.
			expect(wrapped[0]).toBe(`${ESC}[1m${ESC}[4m${ESC}[31maaa${ESC}[22;24;39m`);
			expect(wrapped[1]).toBe(`${ESC}[1;4;31mbbb${ESC}[39m${ESC}[24m${ESC}[22m`);
		});
	});

	it('should not reopen a style the text closed before the break', () => {
		styled(() => {
			const wrapped = lines(wrap(`${ansi.red('aaa')} bbb ccc`, 7));
			expect(wrapped[0]).toBe(`${ESC}[31maaa${ESC}[39m bbb`);
			expect(wrapped[1]).toBe('ccc');
		});
	});

	// dropping them would change the text, and a caller joining wrapped pieces
	// would lose the styling the next piece was meant to inherit
	it('should keep sequences that come after the last word', () => {
		styled(() => {
			expect(wrap(`${ESC}[31m`, 10)).toBe(`${ESC}[31m`);
			expect(wrap(`foo ${ESC}[31m`, 10)).toBe(`foo${ESC}[31m`);
		});
	});

	// the close is only for what the text's own trailing sequences do not turn
	// off, so a text that ends by closing does not get a second close
	it('should not write a close the text already wrote', () => {
		expect(wrap(`${ESC}[31mfoo ${ESC}[39m`, 10)).toBe(`${ESC}[31mfoo${ESC}[39m`);
		expect(wrap(`${ESC}[31mfoo ${ESC}[0m`, 10)).toBe(`${ESC}[31mfoo${ESC}[0m`);
		// but one that leaves a style open still gets closed
		expect(wrap(`${ESC}[31mfoo `, 10)).toBe(`${ESC}[31mfoo${ESC}[39m`);
	});

	it('should not open a style on a line with no content', () => {
		// nothing on the line, so nothing to close at the end of it either
		expect(lines(wrap(`${ESC}[41maaa\n\nbbb${ESC}[49m`, 10))).toEqual([
			`${ESC}[41maaa${ESC}[49m`,
			'',
			`${ESC}[41mbbb${ESC}[49m`,
		]);
	});

	// the sequence sits between the space and the word, so it moves down with the
	// word rather than being left behind on a line it no longer styles
	it('should take a word and its styling down together', () => {
		styled(() => {
			const wrapped = lines(wrap(`aaa ${ansi.red('bbb')}`, 3));
			expect(wrapped).toEqual(['aaa', `${ESC}[31mbbb${ESC}[39m`]);
		});
	});

	it('should keep a hyperlink whole', () => {
		const BEL = String.fromCharCode(0x07);
		const link = `${ESC}]8;;https://example.com${BEL}the link${ESC}]8;;${BEL}`;
		const wrapped = wrap(`see ${link} now`, 10);
		expect(wrapped).toContain(`${ESC}]8;;https://example.com${BEL}`);
		expectWithin(wrapped, 10);
	});
});

describe('tabs and wide text', () => {
	// how wide a tab is depends on the column it lands in, and wrapping is the
	// thing that moves it, so it is one space and is written as one
	it('should treat a tab as one space', () => {
		expect(wrap('a\tb', 20)).toBe('a b');
		expect(lines(wrap('aaa\tbbb', 3))).toEqual(['aaa', 'bbb']);
	});

	it('should wrap on columns rather than characters', () => {
		const wrapped = wrap('日本語のテキスト', 6);
		expectWithin(wrapped, 6);
		expect(lines(wrapped)).toEqual(['日本語', 'のテキ', 'スト']);
	});

	it('should mix widths within a line', () => {
		expectWithin(wrap('ok 日本 fine 語の', 8), 8);
	});
});

describe('tokenize()', () => {
	it('should keep a sequence whole and give it no width', () => {
		expect(tokenize(`${ESC}[31ma`)).toEqual([
			{ text: `${ESC}[31m`, type: 'sequence', width: 0 },
			{ text: 'a', type: 'cluster', width: 1 },
		]);
	});

	it('should split the rest into clusters with their widths', () => {
		expect(tokenize(`a日${FLAG_US}`)).toEqual([
			{ text: 'a', type: 'cluster', width: 1 },
			{ text: '日', type: 'cluster', width: 2 },
			{ text: FLAG_US, type: 'cluster', width: 2 },
		]);
	});

	it('should put back exactly what it was given', () => {
		for (const text of ['', 'plain', `${ESC}[1ma${ESC}[22m`, `a${ESC}[31m`, `${ESC}[31m`]) {
			expect(
				tokenize(text)
					.map((token) => token.text)
					.join('')
			).toBe(text);
		}
	});
});
