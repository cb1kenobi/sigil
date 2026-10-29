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
