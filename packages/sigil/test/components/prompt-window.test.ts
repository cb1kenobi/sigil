import { boundary } from '../../src/components/editing.js';
import { promptWindow } from '../../src/components/prompt.js';
import { stringWidth } from '../../src/width/index.js';
import { rng } from '../layout/random.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * The single-line field's window: which part of a value is on screen around the
 * caret, worked out on every key.
 *
 * SIG-368: it dropped one cluster at a time and measured what was left again
 * each time, which is quadratic in the value's length on every keystroke. The
 * rewrite walks outward from the caret instead, and has to give exactly the old
 * answer -- so the old loop is kept here as the oracle, and the differential
 * runs both over random strings on the runtime under test. That is the point of
 * comparing against it rather than against literals: segmentation of the newest
 * emoji differs between ICU versions, and the claim is that the two agree on
 * whichever one this is.
 */

/**
 * Every code unit handed to the width module, which is what the growth test
 * counts. A count rather than a clock, so a busy machine cannot decide it.
 */
const measured = vi.hoisted(() => ({ units: 0 }));

vi.mock('../../src/width/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/width/index.js')>();
  return {
    ...actual,
    graphemes(str: string): string[] {
      measured.units += str.length;
      return actual.graphemes(str);
    },
    graphemeWidth(cluster: string): number {
      measured.units += cluster.length;
      return actual.graphemeWidth(cluster);
    },
    stringWidth(str: string): number {
      measured.units += str.length;
      return actual.stringWidth(str);
    },
  };
});

/**
 * THE OLD IMPLEMENTATION, kept only as an oracle. This is `windowOf()` as it was
 * before SIG-368, verbatim -- quadratic, and not to be called from `src/`.
 */
function oldWindowOf(value: string, cursor: number, width: number) {
  const room = Math.max(1, width);
  const end = boundary(value, cursor, 1);
  const under = value.slice(cursor, end);
  const caret = Math.max(1, stringWidth(under));

  let before = value.slice(0, cursor);
  let after = value.slice(end);

  while (before !== '' && stringWidth(before) + caret > room) {
    before = before.slice(boundary(before, 0, 1));
  }
  while (after !== '' && stringWidth(before) + caret + stringWidth(after) > room) {
    after = after.slice(0, boundary(after, after.length, -1));
  }

  return { after, before, under };
}

/**
 * What the random values are made of: one-column and two-column clusters,
 * clusters of several code points, and the ones that are no columns at all --
 * plus the pieces that join or split clusters depending on what is beside them,
 * which is what a window cut in the wrong place would get wrong.
 */
const PIECES = [
  'a',
  'Z',
  ' ',
  '~',
  '漢',
  '字',
  'Ａ', // fullwidth
  'ｱ', // halfwidth katakana
  '한',
  '가', // a syllable spelled in jamo
  '😀',
  '👍🏽', // a skin tone
  '👨‍👩‍👧', // a ZWJ family
  '🧑‍💻',
  '🇯🇵',
  '🇦', // a lone regional indicator, which pairs with whatever follows
  '1️⃣', // a keycap
  '©️',
  '́', // a combining acute, joining whatever is before it
  '̈',
  '​', // zero width space
  '‍', // a joiner on its own
  '️',
  'का', // a spacing mark
  'é',
  '\ud83d', // a lone surrogate
];

/** The control characters the old loop's `strip()` reads, which take its path. */
const CONTROLS = ['\u001b[31m', '\u001b', '\t', '\u009b', '\u001b]8;;x\u0007'];

function randomValue(next: () => number, length: number, controls: boolean): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const pool = controls && next() < 0.15 ? CONTROLS : PIECES;
    out += pool[Math.floor(next() * pool.length)];
  }
  return out;
}

describe('promptWindow()', () => {
  it('should agree with the old loop over thousands of random values', () => {
    const next = rng(368);
    // 150,000 runs at up to 90 pieces agreed when this was written; the suite
    // keeps a count that stays far inside the timeout on a loaded machine
    for (let run = 0; run < 4000; run++) {
      const value = randomValue(next, Math.floor(next() * 32), run % 5 === 0);
      // any offset, a cluster boundary or not, and one past the end
      const cursor = Math.floor(next() * (value.length + 2));
      const room = run % 7 === 0 ? Math.floor(next() * 3) : Math.floor(next() * 30) - 2;
      const now = promptWindow(value, cursor, room);
      const was = oldWindowOf(value, cursor, room);
      if (now.before !== was.before || now.under !== was.under || now.after !== was.after) {
        // the first disagreement, named well enough to paste into a test
        expect(now, `run ${run}: ${JSON.stringify(value)} at ${cursor} in ${room}`).toEqual(was);
      }
    }
  });

  it('should agree with the old loop at every cursor and room of a fixed value', () => {
    // each case beside every other: a wide cluster at both edges, a zero-width
    // run, a flag and a joined family, so each straddles the edge at some room
    const value = 'ab漢​​ć👨‍👩‍👧d🇯🇵🇦e字';
    for (let cursor = 0; cursor <= value.length + 1; cursor++) {
      for (let room = -1; room <= 14; room++) {
        expect(promptWindow(value, cursor, room), `${cursor} in ${room}`).toEqual(
          oldWindowOf(value, cursor, room)
        );
      }
    }
  });

  it('should leave a wide cluster that straddles either edge off the screen', () => {
    // the caret past the end is one column, so six columns hold two of these
    // and the third would need one more than is left: it goes whole, and the
    // column is left empty rather than holding half of it
    expect(promptWindow('漢字漢字', 4, 6)).toEqual({ after: '', before: '漢字', under: '' });
    expect(promptWindow('漢字漢字', 4, 7)).toEqual({ after: '', before: '字漢字', under: '' });
    // and the same at the right edge, with the caret on a two-column cluster
    expect(promptWindow('漢字漢字', 0, 5)).toEqual({ after: '字', before: '', under: '漢' });
    expect(promptWindow('漢字漢字', 0, 6)).toEqual({ after: '字漢', before: '', under: '漢' });
    expect(promptWindow('ab', 2, 0)).toEqual({ after: '', before: '', under: '' });
    expect(promptWindow('漢a', 0, 1)).toEqual({ after: '', before: '', under: '漢' });
  });

  it('should not measure the value again for every cluster it drops', () => {
    // a count of what was handed to the width module, at two sizes: the old
    // loop is quadratic and doubling the value quadruples it, while one walk
    // out from the caret doubles at most
    const work = (fn: typeof oldWindowOf, size: number): number => {
      const value = '漢字仮名'.repeat(size / 4);
      measured.units = 0;
      fn(value, value.length, 40);
      return measured.units;
    };

    const [small, large] = [work(promptWindow, 2000), work(promptWindow, 4000)];
    expect(large / small).toBeLessThan(2.5);
    expect(large).toBeLessThan(4000 * 8);

    // and the measure can tell: the oracle does grow with the square
    const [oldSmall, oldLarge] = [work(oldWindowOf, 200), work(oldWindowOf, 400)];
    expect(oldLarge / oldSmall).toBeGreaterThan(3.5);
  });
});
