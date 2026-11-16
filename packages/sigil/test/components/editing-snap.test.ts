import { insertAt, snap } from '../../src/components/editing.js';
import { graphemes } from '../../src/width/index.js';
import { rng } from '../layout/random.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * `snap()` over a window rather than a whole value (SIG-444).
 *
 * A text area that took a long paste segmented the whole value to place the
 * caret, which is the one thing `snap()` is asked and needs only the line the
 * caret is on. What proves the window is the same answer is the old walk kept
 * verbatim as an oracle; what proves it is a window is a count of the code units
 * handed to `graphemes()`, because a clock on a loaded machine decides nothing --
 * the million-line test that was timing out on Windows is this ticket.
 */

/** Every code unit handed to `graphemes()`, which is what the window test counts. */
const measured = vi.hoisted(() => ({ units: 0 }));

vi.mock('../../src/width/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/width/index.js')>();
  return {
    ...actual,
    graphemes(str: string): string[] {
      measured.units += str.length;
      return actual.graphemes(str);
    },
  };
});

/** THE OLD IMPLEMENTATION, kept only as an oracle: `snap()` over the whole value. */
function oldSnap(value: string, at: number): number {
  let offset = 0;
  for (const cluster of graphemes(value)) {
    if (offset >= at) {
      return offset;
    }
    offset += cluster.length;
  }
  return value.length;
}

/**
 * What the random values are made of: the pieces whose segmentation depends on
 * what is beside them, each of them put next to a line break and a carriage
 * return, which is where a window cut in the wrong place would be wrong.
 */
const PIECES = [
  'a',
  '\n',
  '\n',
  '\r',
  '\r\n',
  '\t',
  '漢',
  '😀',
  '👨‍👩‍👧', // a ZWJ family
  '‍', // a joiner on its own
  '🇯🇵',
  '🇦', // a lone regional indicator, which pairs with whatever follows
  '1️⃣', // a keycap
  '́', // a combining mark, joining whatever is before it
  'का', // a spacing mark
  '\ud83d', // a lone surrogate
];

describe('snap() over a window', () => {
  it('should agree with the whole-value walk at every offset of random values', () => {
    const next = rng(444);
    for (let run = 0; run < 3000; run++) {
      let value = '';
      const length = Math.floor(next() * 24);
      for (let i = 0; i < length; i++) {
        value += PIECES[Math.floor(next() * PIECES.length)];
      }
      // every offset, a boundary or not, and two past the end
      for (let at = 0; at <= value.length + 2; at++) {
        const now = snap(value, at);
        const was = oldSnap(value, at);
        if (now !== was) {
          // the first disagreement, named well enough to paste into a test
          expect(now, `run ${run}: ${JSON.stringify(value)} at ${at}`).toBe(was);
        }
      }
    }
  });

  it('should keep a CR LF together from either side of the pair', () => {
    expect(snap('a\r\nb', 2)).toBe(3);
    expect(snap('a\r\nb', 3)).toBe(3);
  });

  it('should agree with the whole-value walk for a regional indicator run that a line break ends', () => {
    // three indicators pair as two clusters and a third, and the count restarts
    // after the line break rather than carrying across it
    const value = '🇦🇧🇨\n🇩🇪🇫';
    for (let at = 0; at <= value.length + 1; at++) {
      expect(snap(value, at), String(at)).toBe(oldSnap(value, at));
    }
  });

  it('should hand the segmenter the line the caret is on and nothing else', () => {
    const lines = (count: number): string =>
      Array.from({ length: count }, (_, i) => `line ${String(i).padStart(6, '0')}`).join('\n');
    const handed = (count: number): number => {
      const value = lines(count);
      measured.units = 0;
      const at = value.length >> 1;
      snap(value, at);
      return measured.units;
    };
    const small = handed(100);
    const large = handed(100_000);
    // one line and its break, wherever in the value that line is
    expect(small).toBeLessThanOrEqual(16);
    expect(large).toBe(small);
  });

  it('should hand the segmenter one line when a paste of many is inserted', () => {
    const body = Array.from({ length: 50_000 }, (_, i) => `${i}`).join('\n');
    measured.units = 0;
    const result = insertAt('before\nafter', 6, `\n${body}`);
    // the whole 290,000 code units were handed over before the window
    expect(measured.units).toBeLessThanOrEqual(16);
    expect(result.cursor).toBe(6 + 1 + body.length);
  });
});
