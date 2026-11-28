import { completionScript } from '../src/completion/index.js';
import { SAFE_PUNCTUATION } from '../src/completion/quote.js';
import {
  quoteWord,
  splitWords,
  wordAt,
  type Word,
  type WordQuote,
} from '../src/completion/words.js';
import * as root from '../src/index.js';
import { parse } from '../src/parser/parse.js';
import { whichSync } from '../src/which.js';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/** The values of a line's words, which is the argv a shell would have built. */
function argv(line: string): string[] {
  return splitWords(line).words.map((w) => w.value);
}

/** A repeatable stream of numbers, so a failure names a seed rather than a mood. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Characters a shell, a terminal or a reader treats specially, so that a random
 * string is mostly made of what goes wrong. Every control and format character
 * is an escape, per the rules in the root `AGENTS.md`.
 */
const ALPHABET = [
  'a',
  'Z',
  '0',
  '-',
  '_',
  '.',
  '/',
  '=',
  ':',
  '@',
  '%',
  '+',
  ',',
  ' ',
  ' ',
  '\t',
  '\n',
  '\r',
  "'",
  "'",
  '"',
  '"',
  '\\',
  '\\',
  '$',
  '`',
  '!',
  '~',
  '*',
  '?',
  '#',
  '|',
  ';',
  '&',
  '<',
  '>',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '\u0000',
  '\u0007',
  '\u001B',
  '\u007F',
  '\u0085',
  '\u009B',
  '\u00AD',
  '\u200B',
  '\u200D',
  '\u202E',
  '\u2028',
  '\u2029',
  '\uFE0F',
  '\uFEFF',
  '\u2800',
  '\u034F',
  '\u3164',
  '\u{E0041}',
  '\u00A0',
  '\u00E9',
  'e\u0301',
  '\u65E5',
  '\u{1F600}',
  '\u{1F468}\u200D\u{1F469}',
  '\uD800',
  '\uDC00',
];

function randomString(next: () => number): string {
  const length = Math.floor(next() * 9);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(next() * ALPHABET.length)];
  }
  return out;
}

/** Whether a string holds anything a terminal would act on or a reader could not see. */
function hasRawUnsafe(text: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/u.test(text);
}

describe('splitWords', () => {
  describe('the grammar', () => {
    it('should split on blanks and drop the blanks', () => {
      expect(argv('deploy  --tag\tv1\nnow\r')).toEqual(['deploy', '--tag', 'v1', 'now']);
    });

    it('should read nothing from an empty or blank line', () => {
      expect(splitWords('')).toEqual({ words: [], open: undefined });
      expect(splitWords(' \t\n ')).toEqual({ words: [], open: undefined });
    });

    it('should read single quotes as literal up to the next single quote', () => {
      expect(argv(`'a b' 'c\\d' '$HOME "x"'`)).toEqual(['a b', 'c\\d', '$HOME "x"']);
    });

    it('should read double quotes with a backslash taking only four characters', () => {
      expect(argv('"a b" "q\\"q" "b\\\\b" "d\\$d" "t\\`t"')).toEqual([
        'a b',
        'q"q',
        'b\\b',
        'd$d',
        't`t',
      ]);
    });

    it('should keep a backslash that double quotes do not take', () => {
      expect(argv('"a\\nb" "a\\\'b" "a\\ b"')).toEqual(['a\\nb', "a\\'b", 'a\\ b']);
    });

    it('should read a backslash outside quotes as taking the next character', () => {
      expect(argv('a\\ b c\\"d \\\\ \\$HOME \\\'x \\n')).toEqual([
        'a b',
        'c"d',
        '\\',
        '$HOME',
        "'x",
        'n',
      ]);
    });

    it('should join adjacent quoted and bare parts into one word', () => {
      expect(argv(`a"b c"'d e'\\ f`)).toEqual(['ab cd e f']);
      expect(argv(`it'\\''s`)).toEqual(['it\\s']);
      expect(argv(`'it'\\''s'`)).toEqual(["it's"]);
    });

    it('should read an empty pair of quotes as an empty word', () => {
      expect(argv(`'' "" a''b`)).toEqual(['', '', 'ab']);
    });

    it('should carry a quoted newline and tab as the word holds them', () => {
      expect(argv('\'a\nb\' "c\td"')).toEqual(['a\nb', 'c\td']);
    });

    it('should treat a backslash before a newline as a continuation', () => {
      expect(argv('ab\\\ncd')).toEqual(['abcd']);
      expect(argv('"ab\\\ncd"')).toEqual(['abcd']);
      expect(argv('\\\n a')).toEqual(['a']);
      expect(splitWords('x \\\n').words).toHaveLength(1);
    });

    it("should read the escapes of $'...' and the bytes of a run as UTF-8", () => {
      expect(
        argv("$'a\\tb' $'\\x1b[0m' $'\\u00e9\\U0001F600' $'\\xc3\\xa9' $'\\101\\x42'")
      ).toEqual(['a\tb', '\u001B[0m', '\u00E9\u{1F600}', '\u00E9', 'AB']);
      expect(argv("$'it\\'s \\\\ \\\"' $'x'y")).toEqual(['it\'s \\ "', 'xy']);
    });

    it("should keep an escape of $'...' it does not know as typed", () => {
      expect(argv("$'\\q \\x \\xZ \\uZZ'")).toEqual(['\\q \\x \\xZ \\uZZ']);
    });

    it("should join the bytes of adjacent $'...' parts into one character", () => {
      expect(argv("$'\\xC3'$'\\xA9' $'\\xC3'x")).toEqual(['\u00E9', '\uFFFDx']);
    });

    it('should end a word at a carriage return, which sh does not, and keep a NUL it is told of', () => {
      expect(argv('a\rb')).toEqual(['a', 'b']);
      expect(argv("$'a\\x00b'")).toEqual(['a\u0000b']);
    });

    it('should read at most two hex digits of \\x and four of \\u', () => {
      expect(argv("$'\\x411' $'\\u00411'")).toEqual(['A1', 'A1']);
    });
  });

  describe('nothing is expanded', () => {
    it('should leave a variable, a tilde, a glob and a substitution literal', () => {
      const line = '$HOME ${HOME} ~ ~/x *.js ? [a-z] $(date) `date` $((1+2)) !! a=b';
      expect(argv(line)).toEqual([
        '$HOME',
        '${HOME}',
        '~',
        '~/x',
        '*.js',
        '?',
        '[a-z]',
        '$(date)',
        '`date`',
        '$((1+2))',
        '!!',
        'a=b',
      ]);
    });

    it('should leave a variable literal inside double quotes too', () => {
      expect(argv('"$HOME $(date) `date`"')).toEqual(['$HOME $(date) `date`']);
    });

    it('should read an operator, a comment and a redirection as part of a word', () => {
      expect(argv('a|b c;d e&&f >g #h')).toEqual(['a|b', 'c;d', 'e&&f', '>g', '#h']);
    });

    it('should read $ before a double quote as a $ and a quote', () => {
      expect(argv('$"a b"')).toEqual(['$a b']);
    });
  });

  describe('the ranges', () => {
    it('should give each word the range it was read from', () => {
      const line = `  ab  "c d"e  'f'  `;
      const words = splitWords(line).words;
      expect(words.map((w) => [w.value, w.start, w.end])).toEqual([
        ['ab', 2, 4],
        ['c de', 6, 12],
        ['f', 14, 17],
      ]);
      for (const w of words) {
        expect(argv(line.slice(w.start, w.end))).toEqual([w.value]);
      }
    });

    it('should say how a word began', () => {
      const quotes = (line: string) => splitWords(line).words.map((w) => w.quote);
      expect(quotes(`a 'b' "c" $'d' e'f' 'g'h ""`)).toEqual([
        undefined,
        "'",
        '"',
        "$'",
        undefined,
        "'",
        '"',
      ]);
    });

    it('should count a line continuation before a quote as nothing', () => {
      expect(splitWords("\\\n'a'").words[0]).toEqual<Word>({
        value: 'a',
        start: 0,
        end: 5,
        quote: "'",
      });
    });

    it('should count a character outside the BMP as two columns, the way slice() does', () => {
      const [first, second] = splitWords("\u{1F600} 'x'").words;
      expect([first!.start, first!.end, second!.start, second!.end]).toEqual([0, 2, 3, 6]);
    });
  });

  describe('an unterminated quote', () => {
    it('should report the quote the line ends inside and keep what was typed', () => {
      expect(splitWords("a 'b c")).toEqual({
        words: [
          { value: 'a', start: 0, end: 1, quote: undefined },
          { value: 'b c', start: 2, end: 6, quote: "'" },
        ],
        open: "'",
      });
      expect(splitWords('a "b \\" c').open).toBe('"');
      expect(splitWords("a $'b\\'c").open).toBe("$'");
      expect(splitWords("a $'b\\'c").words[1]!.value).toBe("b'c");
    });

    it('should report a word whose second quote is the one left open', () => {
      expect(splitWords(`a'b'"c d`)).toEqual({
        words: [{ value: 'abc d', start: 0, end: 8, quote: undefined }],
        open: '"',
      });
    });

    it('should report a quote that was just opened as an empty open word', () => {
      expect(splitWords('a "')).toEqual({
        words: [
          { value: 'a', start: 0, end: 1, quote: undefined },
          { value: '', start: 2, end: 3, quote: '"' },
        ],
        open: '"',
      });
    });

    it('should report a backslash with nothing after it', () => {
      expect(splitWords('a b\\')).toEqual({
        words: [
          { value: 'a', start: 0, end: 1, quote: undefined },
          { value: 'b', start: 2, end: 4, quote: undefined },
        ],
        open: '\\',
      });
      expect(splitWords('\\').words).toEqual([{ value: '', start: 0, end: 1, quote: undefined }]);
    });

    it('should report nothing open once the quote is closed or the line moves on', () => {
      expect(splitWords(`'a' "b" $'c' d`).open).toBeUndefined();
      expect(splitWords(`'a b' c`).open).toBeUndefined();
    });
  });
});

describe('wordAt', () => {
  it('should return an empty word at the cursor between words and at the ends', () => {
    const empty = (at: number) => ({
      value: '',
      before: '',
      start: at,
      end: at,
      from: at,
      quote: undefined,
    });
    expect(wordAt('', 0)).toEqual(empty(0));
    expect(wordAt('ab  cd', 3)).toEqual(empty(3));
    expect(wordAt('ab ', 3)).toEqual(empty(3));
    expect(wordAt(' ab', 0)).toEqual(empty(0));
  });

  it('should treat a cursor touching a word as inside it', () => {
    const line = 'deploy --tag';
    expect(wordAt(line, 6)).toMatchObject({ value: 'deploy', before: 'deploy', start: 0, end: 6 });
    expect(wordAt(line, 7)).toMatchObject({ value: '--tag', before: '', start: 7, end: 12 });
    expect(wordAt(line, 9)).toMatchObject({ value: '--tag', before: '--', start: 7, end: 12 });
    expect(wordAt(line, 12)).toMatchObject({ value: '--tag', before: '--tag', from: 7 });
  });

  it('should give the text before the cursor as the shell reads it', () => {
    expect(wordAt('open my\\ fi', 11)).toMatchObject({
      value: 'my fi',
      before: 'my fi',
      start: 5,
      from: 5,
      quote: undefined,
    });
    expect(wordAt('open a\\ b\\ c', 8)).toMatchObject({ value: 'a b c', before: 'a ' });
  });

  it('should start a replacement after the quote the cursor is inside', () => {
    expect(wordAt('open "my fi', 11)).toEqual({
      value: 'my fi',
      before: 'my fi',
      start: 5,
      end: 11,
      from: 6,
      quote: '"',
    });
    expect(wordAt("open 'my fi", 11)).toMatchObject({ from: 6, quote: "'" });
    expect(wordAt("open $'my fi", 12)).toMatchObject({ from: 7, quote: "$'", before: 'my fi' });
    expect(wordAt('open "', 6)).toMatchObject({ value: '', before: '', from: 6, quote: '"' });
  });

  it('should keep the quote when the cursor is inside it with more after', () => {
    expect(wordAt('open "my file" x', 10)).toEqual({
      value: 'my file',
      before: 'my f',
      start: 5,
      end: 14,
      from: 6,
      quote: '"',
    });
  });

  it('should replace the whole word when the cursor is past the quote it opened with', () => {
    expect(wordAt('open "my"fi', 11)).toMatchObject({ before: 'myfi', from: 5, quote: undefined });
    expect(wordAt('open a"b', 8)).toMatchObject({ before: 'ab', from: 5, quote: undefined });
    expect(wordAt('open "my" x', 9)).toMatchObject({ before: 'my', from: 5, quote: undefined });
  });

  it('should start a replacement at the word when a backslash is dangling', () => {
    expect(wordAt('open a\\', 7)).toMatchObject({ before: 'a', from: 5, quote: undefined });
  });

  it('should not split the $ from its quote when the cursor is between them', () => {
    expect(wordAt("open $'a'", 6)).toMatchObject({ before: '$', from: 5, quote: undefined });
    expect(wordAt("open $'a'", 7)).toMatchObject({ before: '', from: 7, quote: "$'" });
  });

  it('should start a replacement after a quote that a line continuation precedes', () => {
    // the continuation is part of the word and the quote is after it, so the
    // replacement starts at the quote's own index and not at the word's start
    const line = 'x \\\n"ab';
    expect(wordAt(line, line.length)).toMatchObject({ start: 2, from: 5, quote: '"' });
    const at = wordAt(line, line.length);
    expect(argv(`${line.slice(0, at.from)}${quoteWord('ab c', at.quote)}"`)).toEqual(['x', 'ab c']);
  });

  it('should refuse a cursor that is not an index into the line', () => {
    expect(() => wordAt('ab', -1)).toThrow(RangeError);
    expect(() => wordAt('ab', 3)).toThrow(/from 0 to 2, got 3/);
    expect(() => wordAt('ab', 1.5)).toThrow(RangeError);
    expect(() => wordAt('ab', Number.NaN)).toThrow(RangeError);
  });

  describe('at every cursor of a line', () => {
    const lines = [
      '',
      'deploy',
      "  deploy --tag \"release 1\"  'it'\\''s' ",
      'a\\ b "c d" $\'e\\x1b f\'',
      'x "unterminated and',
      'y \'a"b',
      'z \\',
      'w "q"r\'s\'',
      '\u{1F600} \u65E5\u672C "\u00E9',
    ];

    for (const line of lines) {
      it(`should answer consistently over ${JSON.stringify(line)}`, () => {
        for (let cursor = 0; cursor <= line.length; cursor++) {
          const at = wordAt(line, cursor);
          const where = `cursor ${cursor}`;
          expect(at.from, where).toBeGreaterThanOrEqual(at.start);
          expect(at.from, where).toBeLessThanOrEqual(cursor);
          expect(cursor, where).toBeLessThanOrEqual(Math.max(at.end, cursor));
          expect(at.end, where).toBeGreaterThanOrEqual(at.start);

          // `before` is what the line says up to the cursor, as a word
          const prefix = splitWords(line.slice(0, cursor)).words.find(
            (w) => w.start === at.start && w.end === cursor
          );
          if (at.start === cursor && at.end === cursor) {
            expect(at.before, where).toBe('');
          } else if (prefix !== undefined) {
            expect(at.before, where).toBe(prefix.value);
          }

          // replacing the typed part with its own quoting changes nothing the cursor can see
          const head = line.slice(0, at.from) + quoteWord(at.before, at.quote);
          const reread = splitWords(head).words.at(-1);
          expect(reread?.value ?? '', where).toBe(at.before);
        }
      });
    }

    it('should cover every cursor of a word that holds a quote the cursor can be inside', () => {
      const line = 'a "b c" d';
      const seen = [...line].map((_, i) => wordAt(line, i).quote);
      expect(seen).toEqual([
        undefined,
        undefined,
        undefined,
        '"',
        '"',
        '"',
        '"',
        undefined,
        undefined,
      ]);
    });
  });
});

describe('quoteWord', () => {
  describe('a whole word', () => {
    it('should leave a safe word bare', () => {
      for (const word of [
        'deploy',
        '--tag=v1.2',
        'a/b/c.txt',
        'x@y%z+1:2,3',
        'caf\u00E9',
        '\u65E5\u672C',
      ]) {
        expect(quoteWord(word), word).toBe(word);
      }
    });

    it('should single-quote what is not safe, as bashQuote() does', () => {
      expect(quoteWord('my file')).toBe("'my file'");
      expect(quoteWord("it's")).toBe("'it'\\''s'");
      expect(quoteWord('')).toBe("''");
      expect(quoteWord('~/x')).toBe("'~/x'");
      expect(quoteWord('$HOME `x` "y" \\ a|b #c !d *')).toBe(`'$HOME \`x\` "y" \\ a|b #c !d *'`);
    });

    it('should quote the empty string and a lone quote', () => {
      expect(quoteWord("'")).toBe("''\\'''");
      expect(argv(quoteWord("'"))).toEqual(["'"]);
    });

    it("should write a control or format character as UTF-8 bytes in $'...'", () => {
      expect(quoteWord('a\u001Bb')).toBe("'a'$'\\x1B''b'");
      expect(quoteWord('\n')).toBe("$'\\x0A'");
      expect(quoteWord('x\u202Ey')).toBe("'x'$'\\xE2\\x80\\xAE''y'");
      expect(quoteWord('\u0085')).toBe("$'\\xC2\\x85'");
      expect(quoteWord('\u{E0041}')).toBe("$'\\xF3\\xA0\\x81\\x81'");
    });

    it('should quote a character that draws as nothing even where it is a letter or a mark', () => {
      // U+3164 is `\p{L}`, U+034F `\p{M}`, U+FE0F a variation selector: all three
      // would pass a class of letters, marks and digits and are not to be bare
      for (const c of ['\u3164', '\u034F', '\uFE0F', '\u2800']) {
        expect(hasRawUnsafe(quoteWord(`a${c}b`)), c).toBe(false);
      }
    });

    it('should leave a joined emoji with its joiner escaped and the pictographs raw', () => {
      expect(quoteWord('\u{1F468}\u200D\u{1F469}')).toBe(
        "'\u{1F468}'$'\\xE2\\x80\\x8D''\u{1F469}'"
      );
    });

    it('should quote a leading = and not an = inside, because zsh expands the first', () => {
      expect(quoteWord('=ls')).toBe("'=ls'");
      expect(quoteWord('--a=b')).toBe('--a=b');
    });

    it('should write the whole safe class bare and nothing beside it', () => {
      for (const c of SAFE_PUNCTUATION) {
        expect(quoteWord(`a${c}b`), c).toBe(`a${c}b`);
      }
      expect(SAFE_PUNCTUATION).toBe('_@%+=:,./-');
    });
  });

  describe('inside a quote', () => {
    it('should say only what single quotes cannot hold', () => {
      expect(quoteWord('it\'s a $b `c` "d" \\', "'")).toBe("it'\\''s a $b `c` \"d\" \\");
    });

    it('should say only what double quotes cannot hold', () => {
      expect(quoteWord('a "b" $c `d` \\e \'f\' !g', '"')).toBe(
        'a \\"b\\" \\$c \\`d\\` \\\\e \'f\' !g'
      );
    });

    it("should say only what $' cannot hold", () => {
      expect(quoteWord('a \'b\' \\c "d" $e', "$'")).toBe('a \\\'b\\\' \\\\c "d" $e');
    });

    it('should step out of the quote for a character a terminal would act on', () => {
      expect(quoteWord('a\u001Bb', "'")).toBe("a'$'\\x1B''b");
      expect(quoteWord('a\u001Bb', '"')).toBe('a"$\'\\x1B\'"b');
      expect(quoteWord('a\u001Bb', "$'")).toBe('a\\x1Bb');
    });

    it('should leave the quote open at the end, so appending the quote closes it', () => {
      expect(splitWords(`'${quoteWord("x'", "'")}`).open).toBe("'");
      expect(splitWords(`"${quoteWord('x"', '"')}`).open).toBe('"');
      expect(splitWords(`$'${quoteWord("x'", "$'")}`).open).toBe("$'");
      expect(splitWords(`'${quoteWord('\u001B', "'")}`).open).toBe("'");
      expect(splitWords(`"${quoteWord('\u001B', '"')}`).open).toBe('"');
    });

    it('should refuse a context that is not a quote', () => {
      expect(() => quoteWord('a', '`' as unknown as WordQuote)).toThrow(TypeError);
      expect(() => quoteWord('a', '' as unknown as WordQuote)).toThrow(/Expected quote to be/);
    });
  });

  describe('round trips', () => {
    const contexts: (WordQuote | undefined)[] = [undefined, "'", '"', "$'"];
    const open = (c: WordQuote | undefined) => c ?? '';
    const close = (c: WordQuote | undefined) => (c === undefined ? '' : c === "$'" ? "'" : c);

    it('should give back any string through any context, over a thousand random ones', () => {
      const next = prng(711);
      for (let n = 0; n < 1000; n++) {
        const value = randomString(next);
        for (const context of contexts) {
          const line = `${open(context)}${quoteWord(value, context)}${close(context)}`;
          const { words, open: left } = splitWords(line);
          expect(left, JSON.stringify([value, context])).toBeUndefined();
          expect(
            words.map((w) => w.value),
            JSON.stringify([value, context, line])
          ).toEqual([value]);
        }
      }
    });

    it('should give back every word of a line made of random ones', () => {
      const next = prng(1234);
      for (let n = 0; n < 300; n++) {
        const values = Array.from({ length: 1 + Math.floor(next() * 5) }, () => randomString(next));
        const line = values.map((v) => quoteWord(v)).join(' ');
        expect(argv(line), JSON.stringify(values)).toEqual(values);
      }
    });

    it('should give back a word glued to what the user had typed before it', () => {
      const next = prng(99);
      for (let n = 0; n < 300; n++) {
        const typed = randomString(next);
        const value = randomString(next);
        for (const context of contexts) {
          const line = `${open(context)}${quoteWord(typed, context)}${quoteWord(value, context)}${close(context)}`;
          expect(argv(line), JSON.stringify([typed, value, context])).toEqual([typed + value]);
        }
      }
    });

    it('should never write a raw control, format or invisible character', () => {
      const next = prng(7);
      for (let n = 0; n < 1000; n++) {
        const value = randomString(next);
        for (const context of contexts) {
          expect(hasRawUnsafe(quoteWord(value, context)), JSON.stringify([value, context])).toBe(
            false
          );
        }
      }
    });

    it('should round trip every code point below U+3000 and a sample above', () => {
      const bad: string[] = [];
      const check = (cp: number) => {
        const value = String.fromCodePoint(cp);
        if (cp >= 0xd800 && cp <= 0xdfff) {
          return;
        }
        const line = quoteWord(`a${value}b`);
        if (argv(line).join('|') !== `a${value}b` || hasRawUnsafe(line)) {
          bad.push(cp.toString(16));
        }
      };
      for (let cp = 0; cp < 0x3000; cp++) {
        check(cp);
      }
      for (const cp of [0xfe00, 0xfeff, 0xe0001, 0xe0100, 0x1f600, 0x10ffff]) {
        check(cp);
      }
      expect(bad).toEqual([]);
    });
  });
});

describe('quoteWord against a real shell', () => {
  // bash 3.2 and zsh both read `$'\xNN'` as one byte, which is why that is the
  // spelling; a Windows PATH may name WSL's launcher as `bash`, which is no test
  // subject, so those are left to the platforms that have one
  for (const shell of ['bash', 'zsh']) {
    const found = process.platform === 'win32' ? undefined : whichSync(shell);

    it.skipIf(found === undefined)(`should be read by ${shell} as the value it was given`, () => {
      const next = prng(31);
      const values = Array.from({ length: 400 }, () => randomString(next)).filter(
        (v) => v.isWellFormed() && !v.includes('\u0000')
      );
      const script = values.map((v) => `printf '%s\\0' ${quoteWord(v)}\n`).join('');
      const out = execFileSync(found!, ['-c', script], { encoding: 'buffer' }).toString('utf8');

      expect(out.split('\0').slice(0, -1)).toEqual(values);
    });
  }
});

describe('what is shared with bashQuote()', () => {
  it('should be the safe class the bash script tests a candidate against', async () => {
    const script = await completionScript(
      await parse({ argv: [], env: {}, schema: { name: 'mycli' } }),
      'bash'
    );
    expect(script).toContain(`*[![:alnum:]${SAFE_PUNCTUATION}]*)`);
    expect(script).toContain('*[![:alnum:]_@%+=:,./-]*)');
  });
});

describe('the root entry', () => {
  it('should export the splitter, the cursor and the quoting beside the rest of the parser', () => {
    expect(root.splitWords).toBe(splitWords);
    expect(root.wordAt).toBe(wordAt);
    expect(root.quoteWord).toBe(quoteWord);
  });
});
