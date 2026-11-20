import { ansi } from '../../src/ansi/index.js';
import { stringWidth } from '../../src/width/index.js';
import { words } from '../../src/wrap/breaks.js';
import {
  createSgrState,
  DEFAULT_WIDTH,
  isBreakSpace,
  MAX_WIDTH,
  terminalWidth,
  tokenize,
  truncate,
  wrap,
  wrapRows,
} from '../../src/wrap/index.js';
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

  it('should read the stream before COLUMNS when asked to, and COLUMNS when it has none', () => {
    const env = { COLUMNS: '55' };
    expect(terminalWidth({ env, stream: { columns: 60 }, streamFirst: true })).toBe(60);
    expect(terminalWidth({ env, stream: {}, streamFirst: true })).toBe(55);
    expect(terminalWidth({ env, stream: { columns: 0 }, streamFirst: true })).toBe(55);
    expect(terminalWidth({ env: {}, stream: {}, streamFirst: true })).toBe(DEFAULT_WIDTH);
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

  // written out, it was a line of nothing but spaces: wider than the width, and
  // ended at once by the break the word needed
  it('should drop indentation wider than the width rather than write a line of spaces', () => {
    expect(wrap('          word', 5)).toBe('word');
    expect(lines(wrap('          word and more', 5))).toEqual(['word', 'and', 'more']);
  });

  // indentation is kept while it leaves room for the first character of the
  // word, which is then broken beside it as before; one column further and there
  // is no room, so the line starts with the word instead
  it('should keep indentation that leaves room for one character, and only that', () => {
    expect(lines(wrap('    word', 5))).toEqual(['    w', 'ord']);
    expect(lines(wrap('     word', 5))).toEqual(['word']);
  });

  it('should measure the room against the width of the first character', () => {
    expect(lines(wrap('   日本', 5))).toEqual(['   日', '本']);
    expect(lines(wrap('    日本', 5))).toEqual(['日本']);
  });

  it('should drop indentation written with tabs the same way', () => {
    expect(lines(wrap('\t\t\t\tword', 5))).toEqual(['    w', 'ord']);
    expect(wrap('\t\t\t\t\tword', 5)).toBe('word');
    expect(wrap(' \t \t \tword', 5)).toBe('word');
  });

  // a word that may not be broken cannot have its first character beside the
  // indentation and the rest below, so the whole word is what has to fit
  it('should drop indentation the unbroken word does not fit beside', () => {
    expect(wrap('          word', { hard: false, width: 5 })).toBe('word');
    expect(wrap('    words', { hard: false, width: 5 })).toBe('words');
    expect(wrap('   long-word', { hard: false, width: 5 })).toBe('long-word');
  });

  it('should drop indentation that does not fit beside an indent or a hanging indent', () => {
    expect(wrap('      word', { indent: 2, width: 6 })).toBe('  word');
    expect(lines(wrap('A\n     word', { hangingIndent: 2, width: 6 }))).toEqual(['A', '  word']);
    expect(lines(wrap('A\n   word', { hangingIndent: 2, width: 6 }))).toEqual([
      'A',
      '     w',
      '  ord',
    ]);
  });

  // what the ticket measured: `NaN` fails every comparison, so the room came out
  // as `NaN` and every word took a line of its own
  it('should answer a width that is not a width the way truncate() does', () => {
    for (const width of [Number.NaN, 0, -3, Number.NEGATIVE_INFINITY]) {
      expect(wrap('hello world', width), String(width)).toBe(truncate('hello world', width));
      expect(wrap('hello world', width), String(width)).toBe('');
      expect(wrap('a\nb', { indent: 2, width }), String(width)).toBe('');
    }
  });

  it('should wrap nothing at an infinite width, as truncate() cuts nothing', () => {
    expect(wrap('hello world', Number.POSITIVE_INFINITY)).toBe('hello world');
    expect(wrap('          word', Number.POSITIVE_INFINITY)).toBe('          word');
    expect(truncate('hello world', Number.POSITIVE_INFINITY)).toBe('hello world');
  });

  // the property the indentation rule exists for, over every split of the room
  // between indentation and word: no line wider than the width, no line of
  // nothing but spaces, and every character that is not a space still there
  it('should write no line wider than the width, whatever the indentation', () => {
    const words = ['a', 'word', 'abcdefghij', 'two words', 'a bb ccc dddd', '日本', '日本語 の'];
    for (const word of words) {
      // a two-column character cannot fit one column, and is allowed over it
      const narrowest = stringWidth(word) === word.length ? 1 : 2;
      for (let width = narrowest; width <= 12; width++) {
        for (let depth = 0; depth <= 14; depth++) {
          for (const space of [' ', '\t']) {
            const text = space.repeat(depth) + word;
            const wrapped = wrap(text, width);
            const label = `${JSON.stringify(text)} at ${width}`;

            for (const line of lines(wrapped)) {
              expect(stringWidth(line), label).toBeLessThanOrEqual(width);
              expect(line.trim() === '' && line !== '', label).toBe(false);
            }
            expect(wrapped.replace(/\s/g, ''), label).toBe(word.replace(/\s/g, ''));
          }
        }
      }
    }
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

  // a sequence in the gap between two words is dropped at a break, because
  // opening the next line from the state is what puts styling back -- and
  // nothing puts a hyperlink back. Dropped, the open took the link away and the
  // close left every later line, and anything joined onto the result, inside it
  it('should move a hyperlink pending at a break down with its word', () => {
    const BEL = String.fromCharCode(0x07);
    const open = `${ESC}]8;;https://example.com${BEL}`;
    const close = `${ESC}]8;;${BEL}`;

    expect(lines(wrap(`aaa ${open}bbb${close}`, 3))).toEqual(['aaa', `${open}bbb${close}`]);
    expect(lines(wrap(`${open}aaa ${close}bbb`, 3))).toEqual([`${open}aaa`, `${close}bbb`]);
  });

  // the SGR travels in the state and the hyperlink travels with the word, so
  // the next line opens the one and writes the other
  it('should carry a hyperlink and reopen an attribute from the same gap', () => {
    const BEL = String.fromCharCode(0x07);
    const open = `${ESC}]8;;https://example.com${BEL}`;

    expect(lines(wrap(`aaa ${ESC}[31m${open}bbb`, 3))).toEqual([
      'aaa',
      `${ESC}[31m${open}bbb${ESC}[39m`,
    ]);
  });

  // the spaces go and what was among them stays: the attributes reopen from
  // the state, and the hyperlink, which nothing reopens, is written in front of
  // the word it applies to
  it('should keep the styling among indentation it drops', () => {
    const BEL = String.fromCharCode(0x07);
    const open = `${ESC}]8;;https://example.com${BEL}`;
    const close = `${ESC}]8;;${BEL}`;

    expect(wrap(`${ESC}[31m   ${ESC}[1m   word${ESC}[0m`, 5)).toBe(`${ESC}[31;1mword${ESC}[0m`);
    expect(wrap(`   ${open}   word${close}`, 5)).toBe(`${open}word${close}`);
    expect(lines(wrap(`${ESC}[31m      word word`, 5))).toEqual([
      `${ESC}[31mword${ESC}[39m`,
      `${ESC}[31mword${ESC}[39m`,
    ]);
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

describe('isBreakSpace()', () => {
  // the one list of where `wrap()` breaks, which a caller wrapping cells of its
  // own asks rather than writing again: it is U+0020 and a tab and nothing else
  it('should say yes to a space and a tab only', () => {
    expect(isBreakSpace(' ')).toBe(true);
    expect(isBreakSpace('\t')).toBe(true);
    for (const text of ['', 'a', '  ', '\n', '\u00a0', '\u2007', '\u202f', '\u3000', '\u2003']) {
      expect(isBreakSpace(text), JSON.stringify(text)).toBe(false);
    }
  });

  it('should name the blanks wrap() breaks at and keeps a line at', () => {
    expect(wrap('10\u00a0kg', 3)).toBe('10\u00a0\nkg');
    expect(wrap('10 kg', 3)).toBe('10\nkg');
  });
});

/**
 * What is left of a wrap after row `row`, wrapped as a text of its own: the rows
 * after it, from the styling every sequence before its end left in effect.
 */
function rest(
  text: string,
  row: number,
  width: number,
  extra: { continued?: boolean; hangingIndent?: number; indent?: number } = {}
): string[] {
  const { ends } = wrapRows(text, { width, ...extra });
  const state = createSgrState();
  for (const token of tokenize(text.slice(0, ends[row]))) {
    if (token.type === 'sequence') {
      state.apply(token.text);
    }
  }
  // an end past a newline starts a paragraph, which is not the rest of a row
  const paragraph = text[(ends[row] as number) - 1] === '\n';
  return wrapRows(state.open() + text.slice(ends[row]), {
    continued: !paragraph,
    width,
    ...extra,
  }).rows;
}

describe('wrapRows()', () => {
  it('should give the rows wrap() joins, for a plain and for a styled text', () => {
    for (const text of [
      SENTENCE,
      `${ESC}[31mred${ESC}[39m and ${ESC}[1mbold words that wrap${ESC}[22m ok`,
      'one\ntwo three four\r\nfive',
      '',
      '   ',
    ]) {
      for (const width of [1, 4, 9, 80]) {
        expect(wrapRows(text, width).rows.join('\n')).toBe(wrap(text, width));
      }
    }
  });

  it('should end each row where the next one starts, and the last at the end of the text', () => {
    const text = 'aaa bbb ccc ddd';
    const { ends, rows } = wrapRows(text, 7);

    expect(rows).toEqual(['aaa bbb', 'ccc ddd']);
    // the blank the break dropped is the first row's, and the second starts at `ccc`
    expect(ends).toEqual([8, text.length]);
    expect(text.slice(ends[0])).toBe('ccc ddd');
  });

  it('should end a row inside a word broken between clusters', () => {
    const { ends, rows } = wrapRows('abcdefghij', 4);

    expect(rows).toEqual(['abcd', 'efgh', 'ij']);
    expect(ends).toEqual([4, 8, 10]);
  });

  it('should count in code units, a wide cluster or a surrogate pair included', () => {
    const { ends, rows } = wrapRows(`日本 ${FLAG_US}${FLAG_US} ${FAMILY}x`, 4);

    expect(rows).toEqual(['日本', `${FLAG_US}${FLAG_US}`, `${FAMILY}x`]);
    expect(ends).toEqual([
      3,
      3 + FLAG_US.length * 2 + 1,
      3 + FLAG_US.length * 2 + 1 + FAMILY.length + 1,
    ]);
  });

  it('should end a row past the newline that ended it, and a CRLF with it', () => {
    const { ends, rows } = wrapRows('ab\ncd\r\nef', 9);

    expect(rows).toEqual(['ab', 'cd', 'ef']);
    expect(ends).toEqual([3, 7, 9]);
  });

  it('should count the sequences in the text, and end a row after the ones in its break', () => {
    const text = `aaa ${ESC}[31m bbb${ESC}[39m ccc`;
    const { ends, rows } = wrapRows(text, 3);

    expect(rows).toEqual(['aaa', `${ESC}[31mbbb${ESC}[39m`, 'ccc']);
    // the sequence in the gap is before the end of the first row: it took effect
    // on the way, and the second row is opened from it
    expect(text.slice(ends[0])).toBe(`bbb${ESC}[39m ccc`);
    expect(text.slice(0, ends[0])).toContain(`${ESC}[31m`);
  });

  it('should answer a width that holds nothing with the one empty row wrap() does', () => {
    expect(wrapRows('abc', 0)).toEqual({ ends: [3], rows: [''] });
    expect(wrapRows('abc', Number.NaN)).toEqual({ ends: [3], rows: [''] });
  });

  it('should give a row and its indentation the same width wrap() does', () => {
    const { rows } = wrapRows('aaa bbb ccc', { hangingIndent: 2, indent: 1, width: 8 });

    expect(rows.join('\n')).toBe(wrap('aaa bbb ccc', { hangingIndent: 2, indent: 1, width: 8 }));
  });

  // the point of an end: what is after it wraps as the rest of this wrap does
  describe('wrapping what is after an end', () => {
    const texts: Record<string, string> = {
      plain: SENTENCE.repeat(3),
      'a long word': `ab ${'x'.repeat(30)} cd ${'y'.repeat(12)}`,
      'styled across rows': `${ESC}[31;4mred and underlined words that go on and on${ESC}[0m then plain`,
      'a colour closed in the gap': `aaaa ${ESC}[1mbbbb ${ESC}[22m cccc ${ESC}[32m dddd${ESC}[39m eeee`,
      'wide clusters': `日本語 ${FLAG_US} 日本語日本語 ${FAMILY} ${FAMILY}${FAMILY} 日`,
      'runs of blanks': 'aaaa     bbbb  \t  cccc        dddd   eeee    ',
      'a mark with nothing to sit on': 'aaaa \u0301    bbbbbbbb   cc',
      'paragraphs, indented': 'aaa bbb\n   ccccccccccc ddd\n\teee fff\n      ggg',
      'a colour carried over paragraphs': `${ESC}[31maaa bbb\n   ccc ddd${ESC}[39m eee\r\n  fff ggg hhh`,
      'a word that moved down whole': `aaaa ${ESC}[7mbbbbbbb${ESC}[27m ccccccc ddd`,
    };

    for (const [name, text] of Object.entries(texts)) {
      it(`should wrap what is left as the rest of the wrap, for ${name}`, () => {
        for (const width of [3, 4, 5, 7, 10, 16]) {
          const { ends, rows } = wrapRows(text, width);

          for (let row = 0; row < rows.length - 1; row++) {
            // a row that breaks in front of a sequence is the one that cannot be
            // started again, and is checked below
            if (text[ends[row] as number] === ESC) {
              continue;
            }
            expect(rest(text, row, width), `${name} at ${width}, after row ${row}`).toEqual(
              rows.slice(row + 1)
            );
          }
        }
      });
    }

    it('should start a paragraph without `continued`, which would drop its indentation', () => {
      const text = 'aaa\n   bbbbbbbbbbbb';
      const { ends, rows } = wrapRows(text, 10);

      expect(rows).toEqual(['aaa', '   bbbbbbb', 'bbbbb']);
      expect(text[(ends[0] as number) - 1]).toBe('\n');
      expect(wrapRows(text.slice(ends[0]), { width: 10 }).rows).toEqual(rows.slice(1));
      expect(wrapRows(text.slice(ends[0]), { continued: true, width: 10 }).rows).toEqual([
        'bbbbbbbbbb',
        'bb',
      ]);
    });

    it('should start a paragraph with neither spelling when there is a hanging indent', () => {
      // the paragraph's first row has the room and indent of a row after the first,
      // which `continued` gives it, and its blanks are indentation, which it does not
      const options = { hangingIndent: 2, width: 10 };
      const text = 'aaa\n   bbbbbbbbbbbb';
      const { ends, rows } = wrapRows(text, options);
      const after = text.slice(ends[0]);

      expect(rows).toEqual(['aaa', '     bbbbb', '  bbbbbbb']);
      expect(wrapRows(after, { continued: true, ...options }).rows).not.toEqual(rows.slice(1));
      expect(wrapRows(after, options).rows).not.toEqual(rows.slice(1));
    });

    it('should write the style of a blank line a paragraph restarts, where wrap() writes nothing', () => {
      const text = `${ESC}[4mab\n   `;
      const { ends, rows } = wrapRows(text, 8);

      expect(rows).toEqual([`${ESC}[4mab${ESC}[24m`, '']);
      expect(wrapRows(`${ESC}[4m${text.slice(ends[0])}`, 8).rows).toEqual([`${ESC}[4m`]);
    });

    it('should not start again in front of a sequence the word it breaks was holding', () => {
      // at one column a wide cluster is wider than the room, so the sequences
      // after it open the next row where they are, in the word, and written. Started
      // there they are in front of a blank, which `wrap()` opens the row from
      // rather than writes: the same row, in other bytes
      const text = `日${ESC}[22m${ESC}[38;5;39m ab`;
      const { ends, rows } = wrapRows(text, 1);

      expect(rows).toEqual([
        '日',
        `${ESC}[22m${ESC}[38;5;39ma${ESC}[39m`,
        `${ESC}[38;5;39mb${ESC}[39m`,
      ]);
      expect(text[ends[0] as number]).toBe(ESC);
      expect(rest(text, 0, 1)).toEqual([
        `${ESC}[38;5;39ma${ESC}[39m`,
        `${ESC}[38;5;39mb${ESC}[39m`,
      ]);
    });

    it('should keep a blank run in front of a text that is not continued as its indentation', () => {
      // the same text, taken as a text of its own and not as the rest of one: a
      // mark takes no column, so the blanks after it are the row's indentation
      expect(wrapRows('\u0301    mmmmmmmm', { width: 8 }).rows).toEqual(['\u0301    mmmm', 'mmmm']);
      expect(wrapRows('\u0301    mmmmmmmm', { continued: true, width: 8 }).rows).toEqual([
        '\u0301mmmmmmmm',
      ]);
    });

    it('should give a continued first line the room and the indent of a row after the first', () => {
      const options = { hangingIndent: 3, indent: 1, width: 10 };

      expect(wrapRows('aaa', { continued: true, ...options }).rows).toEqual(['    aaa']);
      expect(wrapRows('aaa', options).rows).toEqual([' aaa']);
    });
  });
});

describe('words()', () => {
  // the same characters as `isBreakSpace()`, written once: a no-break space is
  // inside a word, a run of spaces and tabs is one gap, and a line break is a gap
  it('should split at a line break and a run of break spaces only', () => {
    expect(words('10\u00a0kg is  heavy')).toEqual(['10\u00a0kg', 'is', 'heavy']);
    expect(words(' a\t\tb \r\nc\nd ')).toEqual(['a', 'b', 'c', 'd']);
    expect(words('ab\u3000cd')).toEqual(['ab\u3000cd']);
    expect(words('')).toEqual([]);
    expect(words(' \t\n ')).toEqual([]);
  });

  // a break space that carries a combining mark or a joiner is one cluster with it,
  // and `wrap()` reads that cluster as part of the word: it is not a gap
  it('should not cut a cluster that begins with a break space', () => {
    expect(words('a \u0301b c')).toEqual(['a \u0301b', 'c']);
    expect(words('a  \u0301b')).toEqual(['a', ' \u0301b']);
    expect(words('a\t\u200db c')).toEqual(['a', '\u200db', 'c']);
    expect(words('a \u200cb')).toEqual(['a \u200cb']);
  });

  it('should agree with isBreakSpace() over every blank', () => {
    for (const blank of [' ', '\t', '\u00a0', '\u2007', '\u202f', '\u3000', '\u2003', '\u000b']) {
      expect(words(`a${blank}b`).length === 2, JSON.stringify(blank)).toBe(isBreakSpace(blank));
    }
  });
});
