import { createStreamWrapper } from '../../src/components/log-stream.js';
import { createLog, LOG_SYMBOLS } from '../../src/components/log.js';
import { createSpinner } from '../../src/components/spinner.js';
import { setQuiet } from '../../src/style/output.js';
import { createTerminal, type OutputStream } from '../../src/terminal/index.js';
import { wrap } from '../../src/wrap/index.js';
import { createStream, screenSetup } from './helpers.js';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
  setQuiet(undefined);
});

const ESC = String.fromCharCode(0x1b);

/** Cuts a string into pieces of `size` code units, whatever is there. */
function chop(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) {
    pieces.push(text.slice(at, at + size));
  }
  return pieces;
}

/** Runs a wrapper over chunks and returns every line it gave. */
function run(width: number, chunks: string[]): string[] {
  const wrapper = createStreamWrapper(width);
  const lines: string[] = [];
  for (const chunk of chunks) {
    lines.push(...wrapper.push(chunk));
  }
  lines.push(...wrapper.end());
  return lines;
}

/** An async iterable over chunks, with a turn of the event loop between them. */
async function* arriving(chunks: Iterable<string | Uint8Array>) {
  for (const chunk of chunks) {
    await new Promise((resolve) => setImmediate(resolve));
    yield chunk;
  }
}

function split(opts: { columns?: number; err?: boolean } = {}) {
  const stdout = createStream({ columns: opts.columns ?? 40, isTTY: true });
  const stderr = createStream({ columns: opts.columns ?? 40, isTTY: opts.err ?? true });
  const writes: string[] = [];
  const record = stderr.write.bind(stderr);
  stderr.write = (chunk: string): boolean => {
    writes.push(chunk.replace(/\r/g, ''));
    return record(chunk.replace(/\r/g, ''));
  };
  const terminal = createTerminal({
    env: {},
    isTTY: true,
    proc: { listenerCount: () => 0, on() {}, removeListener() {} },
    stderr: stderr as unknown as OutputStream,
    stdin: undefined,
    stdout: stdout as unknown as OutputStream,
  });
  return { stderr, terminal, writes };
}

const PROSE =
  'The quick brown fox jumps over the lazy dog, and keeps running far away from here.\n\n' +
  'A second paragraph, shorter.\nA third line with a verylongwordthatcannotpossiblyfitononeline in it';

describe('wrapping text that is still arriving', () => {
  it.each([1, 2, 3, 5, 7, 13, 200])(
    'should wrap exactly as wrap() does however the text is cut (%i)',
    (size) => {
      expect(run(24, chop(PROSE, size)).join('\n')).toBe(wrap(PROSE, 24));
    }
  );

  it('should wrap a styled stream as wrap() does however the text is cut', () => {
    const styled =
      `${ESC}[31mred text that is long enough to wrap${ESC}[39m and ${ESC}[1;4mbold under` +
      ` that goes on and on${ESC}[0m then plain again until it ends`;

    for (const size of [1, 2, 3, 4, 6, 11]) {
      expect(run(20, chop(styled, size)).join('\n')).toBe(wrap(styled, 20));
    }
  });

  it('should not break a line inside an SGR sequence cut between chunks', () => {
    // `ESC[3` and `1m` are one sequence; measured apart they would be columns
    const lines = run(10, ['aaaa bbbb ', `${ESC}[3`, '1mcc dd', `${ESC}[3`, '9m eeee']);

    expect(lines.join('\n')).toBe(wrap(`aaaa bbbb ${ESC}[31mcc dd${ESC}[39m eeee`, 10));
    expect(lines.every((line) => !line.includes('[3\n'))).toBe(true);
  });

  it('should keep a colour open across the lines it wraps over', () => {
    const lines = run(8, [`${ESC}[32mgreen words that wrap${ESC}[39m`]);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith(`${ESC}[32m`)).toBe(true);
      expect(line.endsWith(`${ESC}[39m`)).toBe(true);
    }
  });

  it('should carry a colour across a newline in the text', () => {
    const lines = run(40, [`${ESC}[33mone\ntwo${ESC}[39m\nthree`]);

    expect(lines[1]).toContain(`${ESC}[33mtwo`);
    expect(lines[2]).toBe('three');
  });

  it('should hold the word that is still growing', () => {
    const wrapper = createStreamWrapper(10);

    expect(wrapper.push('aaaa bbbb ccc')).toEqual([]);
    // `ccc` was not finished, so it could not be placed: `cccccc` fits nowhere
    // with `bbbb` and breaks to the next line
    expect(wrapper.push('ccc dd')).toEqual(['aaaa bbbb']);
    expect(wrapper.end()).toEqual(['cccccc dd']);
  });

  it('should give a line as soon as the next word proves it is full', () => {
    const wrapper = createStreamWrapper(10);

    expect(wrapper.push('aaaa bbbb ')).toEqual([]);
    expect(wrapper.push('c')).toEqual([]);
    expect(wrapper.push('c ')).toEqual(['aaaa bbbb']);
  });

  it('should give the line a newline ends without waiting for anything else', () => {
    const wrapper = createStreamWrapper(40);

    expect(wrapper.push('first')).toEqual([]);
    expect(wrapper.push(' line\nsec')).toEqual(['first line']);
    expect(wrapper.end()).toEqual(['sec']);
  });

  it('should treat CRLF as a line end and not a column', () => {
    expect(run(40, ['one\r\ntwo\r\n'])).toEqual(['one', 'two']);
  });

  it('should keep a blank line in the middle and drop the one a final newline implies', () => {
    expect(run(40, ['a\n\nb\n'])).toEqual(['a', '', 'b']);
  });

  it('should give nothing for a stream with nothing in it', () => {
    expect(run(40, [])).toEqual([]);
    expect(run(40, [''])).toEqual([]);
    expect(run(40, ['  \n'])).toEqual(['']);
    expect(run(40, [`  ${ESC}[0m`])).toEqual([]);
  });

  it('should drop a bare carriage return rather than let it reach the terminal', () => {
    expect(run(40, ['a\rb\n'])).toEqual(['ab']);
    expect(run(40, ['10%\r50%\r100%\n'])).toEqual(['10%50%100%']);
  });

  it('should drop every sequence that is not a colour, and keep the colours', () => {
    const red = `${ESC}[31m`;
    const reset = `${ESC}[0m`;

    expect(run(40, [`x${ESC}[2Jy\n`])).toEqual(['xy']);
    expect(run(40, [`x${ESC}[Ay${ESC}[1;1Hz\n`])).toEqual(['xyz']);
    expect(run(40, [`a${ESC}]52;c;aGk=\u0007b${ESC}]8;;https://x${ESC}\\c\n`])).toEqual(['abc']);
    expect(run(40, [`${red}x${ESC}[2Jy${reset}\n`])).toEqual([`${red}xy${reset}`]);
  });

  it('should drop other control characters, leave a tab to the wrapper, and drop a stray escape', () => {
    expect(run(40, ['a\u0007b\u0008c\u007fd\te\n'])).toEqual([wrap('abcd\te', { width: 40 })]);
    expect(run(40, [`a${ESC}`])).toEqual(['a']);
  });

  it('should not count a dropped sequence toward the width', () => {
    expect(run(5, [`ab${ESC}[2Jcd${ESC}[Aef gh\n`])).toEqual(['abcde', 'f gh']);
  });

  it('should not break a line at a space inside a sequence', () => {
    const title = `${ESC}]0;build step one\u0007`;
    const text = `ok ${title}done now`;
    const wrapper = createStreamWrapper(10);
    const lines = [...wrapper.push(`ok ${title}done`), ...wrapper.push(' now'), ...wrapper.end()];

    expect(lines).toEqual(['ok done', 'now']);
    expect(lines).toEqual(wrap('ok done now', { width: 10 }).split('\n'));
    expect(run(10, chop(text, 1))).toEqual(['ok done', 'now']);
  });

  it('should not break a line at the space in a sequence with an intermediate byte', () => {
    // `ESC[2 q` sets the cursor style, and its space is a parameter byte. Cut
    // after it the sequence has no final byte, so what is left is `[2` as text
    const style = `${ESC}[2 q`;
    const wrapper = createStreamWrapper(5);
    const lines = [...wrapper.push(`abc ${style}d`), ...wrapper.end()];

    expect(lines).toEqual(['abc d']);
    expect(run(5, chop(`abc ${style}d`, 1))).toEqual(['abc d']);
  });

  it('should clean a sequence that arrived in pieces', () => {
    expect(run(40, chop(`x${ESC}[2Jy\rz\n`, 1))).toEqual(['xyz']);
  });

  it('should wrap by columns and not by length', () => {
    const lines = run(6, [...chop('日本語 日本語 日本語', 2)]);

    expect(lines).toEqual(['日本語', '日本語', '日本語']);
  });

  it('should break a word wider than the line', () => {
    expect(run(5, ['abcdefghijkl'])).toEqual(['abcde', 'fghij', 'kl']);
  });

  it('should not wrap at all with no width, and end a line where the text does', () => {
    const wrapper = createStreamWrapper(Infinity);

    expect(wrapper.push('a long line that would wrap '.repeat(5))).toEqual([]);
    expect(wrapper.push('\nnext')).toEqual(['a long line that would wrap '.repeat(5).trimEnd()]);
  });
});

describe('a line that is cut off as its rows are handed out', () => {
  // the rows of a line are cut off the front as they are given, and what is left
  // is wrapped as a text of its own. These are the cases that cut has to get
  // right, each one the shape a row can end on, over every chunk size.
  const SIZES = [1, 2, 3, 4, 5, 7, 11, 64, 1000];
  const ZWJ = String.fromCodePoint(0x200d);
  const FAMILY = [0x1f468, 0x1f469, 0x1f467].map((c) => String.fromCodePoint(c)).join(ZWJ);
  const FLAG = String.fromCodePoint(0x1f1fa, 0x1f1f8);

  // [what is streamed, the widths, and what `wrap()` is handed when that is not it]
  const CASES: Record<string, [string, number[], string?]> = {
    'a long run of words': ['word '.repeat(60), [1, 7, 20, 80]],
    'words with several blanks and tabs between': [
      'aaa   bbb\t\tccc  ddd \teee    fff ggg hhh   iii',
      [4, 6, 9],
    ],
    'a word wider than the line, broken': [`x ${'y'.repeat(50)} z ${'w'.repeat(23)}`, [5, 8, 20]],
    'a word that ends exactly at the edge': ['abcde fghij klmno pqrst', [5, 10]],
    'a colour open across several rows': [
      `${ESC}[31m${'red words that go on '.repeat(5)}${ESC}[39m plain again`,
      [7, 12, 30],
    ],
    'attributes opened and closed in the blanks between words': [
      `aaa ${ESC}[1m bbb ${ESC}[22m ccc ${ESC}[4m ddd${ESC}[24m eee ${ESC}[0m fff`,
      [3, 4, 8],
    ],
    'a colour of five parameters, cut anywhere': [
      `${ESC}[38;2;255;0;0mred ${ESC}[48;5;39mwords ${ESC}[0mthat wrap and wrap`,
      [4, 9],
    ],
    'wide characters at the edge of a row': [
      '日本語 日本語日本語 日本語 ' + '日'.repeat(9),
      [5, 6, 7],
    ],
    'a flag and a family, which are one cluster each': [
      `${FLAG}${FLAG} ${FAMILY}${FAMILY} ${FAMILY} ${FLAG} x${FLAG}${FLAG}`,
      [2, 3, 5],
    ],
    'a combining mark cut from what it sits on': [
      `e\u0301 \u0301a  ${'e\u0301'.repeat(12)} z`,
      [3, 5],
    ],
    'a hyperlink, dropped like every sequence that is not a colour': [
      `go ${ESC}]8;;https://example.com${ESC}\\to the ${ESC}]8;;${ESC}\\ link in the text`,
      [6, 10],
    ],
    'newlines, and a colour carried across them': [
      `${ESC}[32mone two three four\nfive six seven eight\nnine ten${ESC}[39m eleven`,
      [6, 9],
    ],
    'a width of one, over wide characters': [`日 a${ESC}[31m 日 ${ESC}[39mb c`, [1]],
    'a run of blanks far wider than the line, between words': [
      `aaa${' '.repeat(200)}bbb ccc${'\t'.repeat(50)}ddd${' \t'.repeat(40)}`,
      [1, 4, 8, 80],
    ],
    // a run that opens a line is indentation, which `wrap()` keeps while the word
    // after it fits and drops once it does not -- so it is dropped exactly when a
    // run between words is, and the clamp may count it. Runs either side of the
    // width, opening a line, after a colour, and after a mark that takes no column
    'a run of blanks opening a line, either side of the width': [
      [7, 8, 9, 10, 79, 80, 81, 82]
        .flatMap((n) => [
          `${' '.repeat(n)}mm`,
          `${ESC}[31m${'\t'.repeat(n)}x${ESC}[39m`,
          `́${' '.repeat(n)}x z`,
        ])
        .join('\n'),
      [8, 80],
    ],
    'a run of blanks, and a mark after the last of it': [
      `aaaa${' '.repeat(30)}\t\ufe0fbb cc${' '.repeat(9)}\u0301d`,
      [3, 5, 8],
    ],
    'cursor sequences between the blanks of a run': [
      `a ${`${ESC}[2K `.repeat(40)}b${` ${ESC}[3 x`.repeat(30)} c`,
      [2, 5, 80],
      `a ${' '.repeat(40)}b${' '.repeat(30)} c`,
    ],
    'an OSC 52 that is ended after many chunks': [
      `copy ${ESC}]52;c;${'QUJD'.repeat(60)}\u0007 done ${ESC}]52;c;${'QUJD'.repeat(9)}${ESC}\\ ok`,
      [4, 12],
      'copy  done  ok',
    ],
    'a long CSI, ended by a final byte after many chunks': [
      `x ${ESC}[${'1;'.repeat(40)}H y ${ESC}[${'2;'.repeat(30)} q z`,
      [6, 11],
      'x  y  z',
    ],
  };

  for (const [name, [text, widths, plain]] of Object.entries(CASES)) {
    it(`should wrap exactly as wrap() does for ${name}`, () => {
      // what the stream drops, `wrap()` is handed already dropped
      const link = `${ESC}]8;;https://example.com${ESC}\\`;
      const unlink = `${ESC}]8;;${ESC}\\`;
      const expected = (width: number) =>
        wrap(plain ?? text.replaceAll(link, '').replaceAll(unlink, ''), width);

      for (const width of widths) {
        for (const size of SIZES) {
          expect(run(width, chop(text, size)).join('\n'), `width ${width}, chunks of ${size}`).toBe(
            expected(width)
          );
        }
      }
    });
  }

  it('should give the same rows however the text is cut, and one at a time as they are final', () => {
    const text = `${ESC}[31m${'one two three four five six '.repeat(8)}${ESC}[39m`;
    const wrapper = createStreamWrapper(16);
    const given: string[] = [];

    for (const chunk of chop(text, 3)) {
      given.push(...wrapper.push(chunk));
    }
    const beforeEnd = given.length;
    given.push(...wrapper.end());

    expect(given.join('\n')).toBe(wrap(text, 16));
    // all but the last row were handed out while the stream was still going
    expect(beforeEnd).toBe(given.length - 1);
  });

  it('should wrap what is left of a line as the rest of it after a row is given', () => {
    // the first row is gone by the second push, and the third word then goes
    // where it would have gone with the whole line in front of it
    const wrapper = createStreamWrapper(10);

    expect(wrapper.push('aaaa bbbb ')).toEqual([]);
    expect(wrapper.push('cc dddd ')).toEqual(['aaaa bbbb']);
    expect(wrapper.push('eeee ffff')).toEqual(['cc dddd']);
    expect(wrapper.end()).toEqual(['eeee ffff']);
  });

  it('should not turn the blanks after a cut into indentation', () => {
    // a zero-width space takes no column, so a row that starts with one and is
    // followed by a blank run looks like a row with indentation -- unless it is the
    // rest of a row, where the blanks are what a break leaves behind and are dropped
    const text = 'aaaaaaaa \u200b    mmmmmmmm ';

    for (const size of [1, 3, 100]) {
      expect(run(8, chop(text, size)).join('\n'), `chunks of ${size}`).toBe(wrap(text, 8));
    }
  });

  it('should carry a sequence that a row left open through a width of one', () => {
    // each row but the first is broken in front of the sequences after a wide
    // character, which is where a cut cannot be made
    const text = `日${ESC}[22m${ESC}[38;5;39m ab 日${ESC}[39m c`;

    for (const size of [1, 2, 3, 100]) {
      expect(run(1, chop(text, size)).join('\n'), `chunks of ${size}`).toBe(wrap(text, 1));
    }
  });

  // `ESC[3 ` is a whole sequence when the text ends at its blank and `ESC[` and
  // text when a character no CSI can hold comes after it, and the blank is a place
  // to break in both. What is wrapped at that blank has always been the text up to
  // it, read on its own, so the sequence is whole and `3 ` is not in it; the line
  // it is in, read at its end, has them. Neither is a chunking artifact, and the
  // rows it gives early are the ones the stream has always given.
  it.each([`${ESC}[`, '\u009b'])(
    'should read the text up to a blank as it reads on its own, inside a CSI that fails after it (%j)',
    (introducer) => {
      const wrapper = createStreamWrapper(5);

      expect(wrapper.push(`xxxx yyyy ${introducer}3 `)).toEqual(['xxxx']);
      // no CSI holds a no-break space, so the sequence was never one -- and the
      // blank in it is the last place the text can be wrapped up to, where `3 ` is
      // still part of the sequence and `yyyy` has nothing after it to be full for
      expect(wrapper.push('\u00a0')).toEqual([]);
      expect(wrapper.push('zz tt')).toEqual(['yyyy']);
      expect(wrapper.end()).toEqual(['3 \u00a0zz', 'tt']);
    }
  );

  it('should drop an unfinished CSI that the carriage return before a newline kept open', () => {
    // `ESC[3` is a sequence only at the end of the line, and a CRLF is not part of it
    const wrapper = createStreamWrapper(40);

    expect(wrapper.push(`abc ${ESC}[3`)).toEqual([]);
    expect(wrapper.push('\r')).toEqual([]);
    expect(wrapper.push('\nc')).toEqual(['abc']);
    expect(wrapper.end()).toEqual(['c']);
    expect(run(40, [`abc ${ESC}[3\r\nc`])).toEqual(['abc', 'c']);
  });

  it('should drop a sequence that never ends, and keep what came before it', () => {
    const wrapper = createStreamWrapper(20);
    const given: string[] = [];

    for (const piece of chop(`copy this ${ESC}]52;c;${'QUJD'.repeat(100)}`, 5)) {
      given.push(...wrapper.push(piece));
    }

    expect(given).toEqual([]);
    expect(wrapper.end()).toEqual(['copy this']);
  });

  it('should wrap what is after a sequence once a chunk ends it', () => {
    const wrapper = createStreamWrapper(10);

    expect(wrapper.push(`aaaa ${ESC}]52;c;QUJDQUJD`)).toEqual([]);
    expect(wrapper.push('QUJD')).toEqual([]);
    expect(wrapper.push(`\u0007bbbb cccc ${ESC}[1;`)).toEqual(['aaaa bbbb']);
    expect(wrapper.push('2')).toEqual([]);
    expect(wrapper.push('Hdddd')).toEqual([]);
    expect(wrapper.end()).toEqual(['cccc dddd']);
  });

  // a text of the same length as the last one wrapped is not the same text: the
  // blank run keeps its length while its last blank changes, and the text up to a
  // blank loses the end of a CSI that is not finished. Found at a width of 7.9 by
  // comparing every push, as a row that was given one chunk late
  it('should wrap again when the text is as long as the last one wrapped and is not it', () => {
    const wrapper = createStreamWrapper(7.9);
    const parts = [
      '[2K\b \b \u0007\t\u0007\u001b[2K\b   \t',
      '\b \t \u0007\t     ',
      '\b \b  \u00ad\u001b[0101100 \u001b[48;2;;0;0;0',
    ];

    expect(parts.map((part) => wrapper.push(part))).toEqual([[], [], ['[2K']]);
    expect(wrapper.end()).toEqual(['\u00ad0101100']);
  });

  /** A text of words, blanks, colours and wide characters, from a seed. */
  function made(seed: number): string {
    let a = seed;
    const next = (n: number): number => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const pick = <T>(list: T[]): T => list[next(list.length)] as T;
    const sgr = [`${ESC}[31m`, `${ESC}[39m`, `${ESC}[1m`, `${ESC}[22m`, `${ESC}[0m`, `${ESC}[4m`];
    const letters = 'abcdefghij';
    const word = (length: number) =>
      Array.from({ length }, () => letters[next(letters.length)]).join('');
    let out = 'x';

    for (let i = 0, n = 5 + next(40); i < n; i++) {
      out += pick([
        () => word(1 + next(8)),
        () => word(10 + next(30)),
        () => ' ',
        () => ' '.repeat(2 + next(5)),
        () => '\t',
        () => pick(sgr),
        () => pick(['日本語', '日', '👍🏽', FLAG, FAMILY, 'e\u0301', '\u200b']),
        () => `\n${word(1 + next(5))}`,
      ])();
    }

    return `${out} y`;
  }

  it('should wrap as wrap() does for a few thousand texts cut at random', () => {
    for (let seed = 1; seed <= 2500; seed++) {
      const text = made(seed);
      const width = [1, 2, 3, 5, 8, 13, 40][seed % 7] as number;
      const size = 1 + (seed % 9);

      expect(run(width, chop(text, size)).join('\n'), `seed ${seed}, width ${width}`).toBe(
        wrap(text, width)
      );
    }
  });
});

describe('a streamed status line', () => {
  it('should write each line as it becomes final, with the glyph on the first', async () => {
    const { terminal, writes } = split({ columns: 24 });
    const log = createLog({ colorLevel: 0, terminal });
    const seen: number[] = [];

    const chunks = arriving(['The quick ', 'brown fox ', 'jumps over ', 'the lazy ', 'dog']);
    const done = log.stream.info(
      (async function* () {
        for await (const chunk of chunks) {
          yield chunk;
          seen.push(writes.length);
        }
      })()
    );
    await done;

    expect(writes.join('')).toBe(
      `${LOG_SYMBOLS.info} The quick brown fox\n  jumps over the lazy\n  dog\n`
    );
    // a line went out before the stream finished, rather than one write at the
    // end of it
    expect(seen.at(-2)).toBeGreaterThan(0);
    expect(seen.at(-2)).toBeLessThan(writes.length);
  });

  it('should wrap the lines under the first one text, not back at the margin', async () => {
    const { stderr, terminal } = split({ columns: 20 });
    await createLog({ colorLevel: 0, terminal }).stream.warn(
      arriving(chop('one two three four five six', 3))
    );

    expect(stderr.text).toBe(`${LOG_SYMBOLS.warn} one two three four\n  five six\n`);
  });

  it('should take a plain iterable and a bare string', async () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 0, terminal });

    await log.stream.success(['all ', 'done']);
    await log.stream.step('next');

    expect(stderr.text).toBe(`${LOG_SYMBOLS.success} all done\n${LOG_SYMBOLS.step} next\n`);
  });

  it('should write a message with no glyph at the margin, and with one of its own', async () => {
    const { stderr, terminal } = split({ columns: 12 });
    const log = createLog({ colorLevel: 0, terminal });

    await log.stream.message(['aaa bbb ccc ddd']);
    await log.stream.message(['aaa bbb ccc ddd'], { symbol: '*' });

    expect(stderr.text).toBe('aaa bbb ccc\nddd\n* aaa bbb\n  ccc ddd\n');
  });

  it('should not wrap a line written to a file, and end it where the text does', async () => {
    const { stderr, terminal } = split({ columns: 10, err: false });
    await createLog({ colorLevel: 0, terminal }).stream.info(
      arriving(['a line much longer ', 'than ten columns\nand ', 'another'])
    );

    expect(stderr.output).toBe(
      `${LOG_SYMBOLS.info} a line much longer than ten columns\n` + `${' '.repeat(1)} and another\n`
    );
  });

  it('should write nothing to the terminal but text and colour', async () => {
    const { stderr, terminal } = split();
    await createLog({ colorLevel: 0, terminal }).stream.warn(
      arriving([
        'progress 10%\rprogress 50%\n',
        `clear${ESC}[2J${ESC}[Aup ${ESC}]52;c;aGk=\u0007done\n`,
      ])
    );

    expect(stderr.text).toBe(
      `${LOG_SYMBOLS.warn} progress 10%progress 50%\n${' '.repeat(2)}clearup done\n`
    );
    expect(stderr.text).not.toContain('\r');
    expect(stderr.text).not.toContain(ESC);
  });

  it('should put back a character that a chunk boundary cut in two', async () => {
    const { stderr, terminal } = split();
    const bytes = new TextEncoder().encode('naïve 日本語');
    const log = createLog({ colorLevel: 0, terminal });

    // one byte at a time: every multi-byte character is cut
    await log.stream.info(Array.from(bytes, (byte) => new Uint8Array([byte])));

    expect(stderr.text).toBe(`${LOG_SYMBOLS.info} naïve 日本語\n`);
  });

  it('should colour the glyph by its role and wrap the message styled as it arrived', async () => {
    const { stderr, terminal } = split({ columns: 14 });
    await createLog({ colorLevel: 3, terminal }).stream.info([
      `${ESC}[3`,
      '1mred words that ',
      `wrap${ESC}[39m`,
    ]);

    // the colour of the message is the message's own, closed and reopened per line
    expect(stderr.output).toContain(`${ESC}[31mred words${ESC}[39m\n`);
    expect(stderr.output).toContain(`${ESC}[31mthat wrap${ESC}[39m\n`);
    // and the glyph is drawn in its own role, not in the message's
    expect(stderr.output.startsWith(`${ESC}[34m${LOG_SYMBOLS.info}`)).toBe(true);
  });

  it('should drain a quiet stream and write nothing', async () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 0, terminal });
    let drained = false;

    setQuiet(true);
    await log.stream.info(
      (async function* () {
        yield 'progress';
        drained = true;
      })()
    );
    await log.stream.warn(['but a warning survives']);

    expect(drained).toBe(true);
    expect(stderr.text).toBe(`${LOG_SYMBOLS.warn} but a warning survives\n`);
  });

  it('should write what arrived before a source failed, then reject with its error', async () => {
    const { stderr, terminal } = split();
    const log = createLog({ colorLevel: 0, terminal });

    await expect(
      log.stream.error(
        (async function* () {
          yield 'half an ans';
          throw new Error('connection reset');
        })()
      )
    ).rejects.toThrow('connection reset');

    expect(stderr.text).toBe(`${LOG_SYMBOLS.error} half an ans\n`);
  });

  it('should write each line above a running spinner and leave one spinner row', async () => {
    const h = screenSetup({ columns: 30 });
    const spinner = createSpinner({ terminal: h.terminal, text: 'working' });
    const log = createLog({ colorLevel: 0, terminal: h.terminal });

    spinner.start();
    await log.stream.info(arriving(chop('the answer is long enough to wrap twice or so', 5)));

    expect(h.log.slice(0, -1)).toEqual([
      `${LOG_SYMBOLS.info} the answer is long enough to`,
      '  wrap twice or so',
    ]);
    expect(h.log.at(-1)).toMatch(/working$/);
    spinner.succeed('done');
  });
});
