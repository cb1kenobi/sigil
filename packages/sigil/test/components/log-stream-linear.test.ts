import { createStreamWrapper } from '../../src/components/log-stream.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * How much text the stream wrapper hands to the wrapper and the tokenizer, which
 * is the whole of what a chunk costs it. Counted rather than timed: no deadline
 * separates a linear walk from a quadratic one on every machine and under every
 * load (SIG-429, SIG-437), while the number of characters read is the same on all
 * of them. A line that is re-wrapped from its start by every chunk reads its
 * length again each time, so the count at eight times the text is sixty-four
 * times the count at the text; a line whose rows are cut off as they are handed
 * out reads each character a few times in all, and eight.
 */
const work = vi.hoisted(() => ({ read: 0 }));

vi.mock('../../src/wrap/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/wrap/index.js')>();

  return {
    ...actual,
    tokenize(text: string) {
      work.read += text.length;
      return actual.tokenize(text);
    },
    wrapRows(text: string, opts?: Parameters<typeof actual.wrapRows>[1]) {
      work.read += text.length;
      return actual.wrapRows(text, opts);
    },
  };
});

const ESC = String.fromCharCode(0x1b);

/** How many characters were read to stream `text` in chunks of five. */
function cost(text: string, width = 80): number {
  const wrapper = createStreamWrapper(width);
  work.read = 0;

  for (let at = 0; at < text.length; at += 5) {
    wrapper.push(text.slice(at, at + 5));
  }
  wrapper.end();

  return work.read;
}

const repeated = (unit: string) => (size: number) =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

describe('a line streamed in time linear in its length', () => {
  const SIZE = 4000;
  const FACTOR = 8;

  // the ticket's own shape, and then the ones a model or a subprocess makes: a
  // minified document that is one word, text with colour in it, and a column of
  // wide characters
  const SHAPES: [string, (size: number) => string][] = [
    ['words', repeated('word ')],
    ['one word, no blank in it', repeated('x')],
    ['minified json', repeated('{"a":[1,2,3],"b":"x y z"},')],
    ['coloured words', repeated(`${ESC}[31mred ${ESC}[1mbold${ESC}[0m plain `)],
    ['wide characters', repeated('日本語 ')],
    ['long words', repeated(`${'abcdefghij'.repeat(12)} `)],
  ];

  it.each(SHAPES)('should read %s a constant number of times each', (_name, make) => {
    const ratio = cost(make(SIZE * FACTOR)) / cost(make(SIZE));

    // linear is eight and quadratic sixty-four; a constant that does not scale
    // has room either side of three times eight
    expect(ratio).toBeLessThan(3 * FACTOR);
    expect(ratio).toBeGreaterThan(FACTOR / 2);
  });

  it('should read each character of a line a small number of times, not a line per chunk', () => {
    const size = SIZE * FACTOR;

    // 32,000 characters in 6,400 chunks: re-wrapping the line per chunk reads
    // about a hundred million, and cutting rows off reads a few hundred thousand
    expect(cost(repeated('word ')(size))).toBeLessThan(size * 40);
  });

  it('should give the same rows as the one-shot wrap of a very long line', async () => {
    const { wrap } =
      await vi.importActual<typeof import('../../src/wrap/index.js')>('../../src/wrap/index.js');
    const text = repeated(`${ESC}[32mgreen words `)(30000);
    const wrapper = createStreamWrapper(80);
    const rows: string[] = [];

    for (let at = 0; at < text.length; at += 5) {
      rows.push(...wrapper.push(text.slice(at, at + 5)));
    }
    rows.push(...wrapper.end());

    expect(rows.join('\n')).toBe(wrap(text, 80));
  });
});
