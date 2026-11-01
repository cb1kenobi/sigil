import * as tail from '../../src/components/spinner-frames.js';
import * as builtIn from '../../src/components/spinner.js';
import {
  ARC,
  BOUNCING_BAR,
  createSpinner,
  DOTS,
  LINE,
  OUTCOME_SYMBOLS,
  type SpinnerFrames,
  spinnerFrames,
} from '../../src/components/spinner.js';
import { stringWidth } from '../../src/width/index.js';
import { screenSetup } from './helpers.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * The frame sets, measured.
 *
 * The rule is the ticket's: a set is one cell wide everywhere. Read as three
 * checks, because "everywhere" is the part a single width cannot say:
 *
 * - every frame of a set is the same width, so the label after it never moves;
 * - a set that is not plain ASCII is exactly one cell, by `stringWidth()` -- the
 *   repository's one measurement, which counts an emoji as two and is what keeps
 *   the moon out;
 * - a set does not mix East Asian **Ambiguous** characters with narrow ones.
 *   `stringWidth()` counts Ambiguous as one, which is right for a CLI, but a
 *   terminal in a CJK locale draws it as two -- and a set that alternates between
 *   the two kinds jitters there, where a set that is all one kind is merely wider.
 *   `◐◓◑◒` is the set that fails it: the first and third are Ambiguous.
 */

/**
 * Every East Asian Width `A` range in the blocks a set draws from, out of
 * `EastAsianWidth.txt` for Unicode 17.0.0 -- the version `src/width/` is
 * generated from. Test data rather than runtime data: the runtime counts these
 * as one column and has no use for the list.
 */
const AMBIGUOUS: readonly (readonly [number, number])[] = [
  [0x2190, 0x2199],
  [0x21b8, 0x21b9],
  [0x21d2, 0x21d2],
  [0x21d4, 0x21d4],
  [0x21e7, 0x21e7],
  [0x2200, 0x2200],
  [0x2202, 0x2203],
  [0x2207, 0x2208],
  [0x220b, 0x220b],
  [0x220f, 0x220f],
  [0x2211, 0x2211],
  [0x2215, 0x2215],
  [0x221a, 0x221a],
  [0x221d, 0x2220],
  [0x2223, 0x2223],
  [0x2225, 0x2225],
  [0x2227, 0x222c],
  [0x222e, 0x222e],
  [0x2234, 0x2237],
  [0x223c, 0x223d],
  [0x2248, 0x2248],
  [0x224c, 0x224c],
  [0x2252, 0x2252],
  [0x2260, 0x2261],
  [0x2264, 0x2267],
  [0x226a, 0x226b],
  [0x226e, 0x226f],
  [0x2282, 0x2283],
  [0x2286, 0x2287],
  [0x2295, 0x2295],
  [0x2299, 0x2299],
  [0x22a5, 0x22a5],
  [0x22bf, 0x22bf],
  [0x2500, 0x254b],
  [0x2550, 0x2573],
  [0x2580, 0x258f],
  [0x2592, 0x2595],
  [0x25a0, 0x25a1],
  [0x25a3, 0x25a9],
  [0x25b2, 0x25b3],
  [0x25b6, 0x25b7],
  [0x25bc, 0x25bd],
  [0x25c0, 0x25c1],
  [0x25c6, 0x25c8],
  [0x25cb, 0x25cb],
  [0x25ce, 0x25d1],
  [0x25e2, 0x25e5],
  [0x25ef, 0x25ef],
  [0x273d, 0x273d],
  [0x2776, 0x277f],
];

/**
 * The blocks `AMBIGUOUS` was transcribed for: Arrows, Mathematical Operators,
 * Box Drawing, Block Elements, Geometric Shapes, Dingbats and Braille. A
 * character outside them is one the table cannot speak for, so it fails rather
 * than being read as narrow by default.
 */
const COVERED: readonly (readonly [number, number])[] = [
  [0x2190, 0x22ff],
  [0x2500, 0x25ff],
  [0x2700, 0x27bf],
  [0x2800, 0x28ff],
];

const within = (ranges: typeof AMBIGUOUS, cp: number): boolean =>
  ranges.some(([start, end]) => cp >= start && cp <= end);

/**
 * What is wrong with a set, by the rule above.
 *
 * @param set - The set.
 * @returns One line per problem, or nothing.
 */
function violations(set: SpinnerFrames): string[] {
  const problems: string[] = [];
  const { frames, interval } = set;

  if (frames.length === 0) {
    problems.push('no frames');
  }
  if (!Number.isInteger(interval) || interval <= 0) {
    problems.push(`interval ${interval}`);
  }

  const widths = new Set(frames.map((frame) => stringWidth(frame)));
  if (widths.size > 1) {
    problems.push(`widths ${[...widths].join(', ')}`);
  }

  const ascii = frames.every((frame) => /^[\x20-\x7e]+$/.test(frame));
  if (!ascii) {
    for (const frame of frames) {
      if (stringWidth(frame) !== 1) {
        problems.push(`${frame} is ${stringWidth(frame)} cells`);
      }
    }

    const kinds = new Set<boolean>();
    for (const char of frames.join('')) {
      const cp = char.codePointAt(0) as number;
      if (cp < 0x80) {
        continue;
      }
      if (!within(COVERED, cp)) {
        problems.push(`U+${cp.toString(16).toUpperCase()} is outside the blocks the table covers`);
      }
      kinds.add(within(AMBIGUOUS, cp));
    }
    if (kinds.size > 1) {
      problems.push('mixes ambiguous and narrow characters');
    }
  }

  return problems;
}

/** Every export of a module that is a frame set, by name. */
function sets(module: Record<string, unknown>): [string, SpinnerFrames][] {
  return Object.entries(module).filter(
    (entry): entry is [string, SpinnerFrames] =>
      typeof entry[1] === 'object' && entry[1] !== null && 'frames' in entry[1]
  );
}

describe('the spinner frame sets', () => {
  const shipped = [...sets(builtIn), ...sets(tail)];

  it('should find the sets it measures', () => {
    // the enumeration is what makes a new set measured without anybody adding
    // it here, so it is asked to find the ones it must
    expect(sets(builtIn).map(([name]) => name)).toEqual(
      expect.arrayContaining(['DOTS', 'LINE', 'ARC', 'CIRCLE', 'GROW', 'ARROW', 'BOUNCING_BAR'])
    );
    expect(sets(tail).length).toBeGreaterThanOrEqual(10);
  });

  it.each(shipped)('should keep %s one width everywhere', (_name, set) => {
    expect(violations(set)).toEqual([]);
  });

  it('should keep every name once across the two files', () => {
    // an app copies the long tail in beside an import of the built-ins, so a
    // name in both is a collision in somebody's module
    const names = shipped.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should refuse the moon, which is why it does not ship', () => {
    // emoji presentation: two cells by this measurement, and one or two on a
    // real terminal depending on its width table and its font
    const moon = { frames: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'], interval: 80 };
    expect(violations(moon)).toContain('🌑 is 2 cells');
  });

  it('should refuse circle halves, which jitter in a CJK terminal', () => {
    expect(violations({ frames: ['◐', '◓', '◑', '◒'], interval: 50 })).toEqual([
      'mixes ambiguous and narrow characters',
    ]);
  });

  it('should keep the fallback plain ASCII', () => {
    // the whole point of it: the one set certain to render
    for (const frame of LINE.frames) {
      expect(frame).toMatch(/^[\x20-\x7e]$/);
    }
  });
});

describe('spinnerFrames()', () => {
  it('should draw braille where the terminal can', () => {
    expect(spinnerFrames({ env: { TERM: 'xterm-256color' }, platform: 'linux' })).toBe(DOTS);
    expect(spinnerFrames({ env: { WT_SESSION: '1' }, platform: 'win32' })).toBe(DOTS);
  });

  it('should fall back to ASCII where unicodeSupported() says no', () => {
    expect(spinnerFrames({ env: { TERM: 'linux' }, platform: 'linux' })).toBe(LINE);
    expect(spinnerFrames({ env: { TERM: 'dumb' }, platform: 'darwin' })).toBe(LINE);
    expect(spinnerFrames({ env: {}, platform: 'win32' })).toBe(LINE);
  });

  it('should let ascii overrule the detection either way', () => {
    expect(spinnerFrames({ ascii: true, env: {}, platform: 'darwin' })).toBe(LINE);
    expect(spinnerFrames({ ascii: false, env: { TERM: 'dumb' }, platform: 'darwin' })).toBe(DOTS);
  });

  it('should give explicit frames precedence over ascii', () => {
    expect(spinnerFrames({ ascii: true, frames: ARC })).toBe(ARC);
  });

  it('should take an array at the old default interval', () => {
    expect(spinnerFrames({ frames: ['a', 'b'] })).toEqual({ frames: ['a', 'b'], interval: 80 });
  });

  it('should treat no frames as the default', () => {
    expect(spinnerFrames({ ascii: false, frames: [] })).toBe(DOTS);
    expect(spinnerFrames({ ascii: true, frames: { frames: [], interval: 10 } })).toBe(LINE);
  });
});

describe('createSpinner() with a set', () => {
  it("should run at the set's own interval", () => {
    vi.useFakeTimers();
    try {
      const ui = screenSetup();
      createSpinner({
        ansi: ui.ansi,
        frameMs: 0,
        frames: ARC,
        terminal: ui.terminal,
        text: 'x',
      }).start();

      vi.advanceTimersByTime(ARC.interval - 1);
      vi.advanceTimersToNextTimer();
      expect(ui.frame).toBe(`${ARC.frames[0]} x`);

      vi.advanceTimersByTime(1);
      vi.advanceTimersToNextTimer();
      expect(ui.frame).toBe(`${ARC.frames[1]} x`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should let interval beat the set's", () => {
    vi.useFakeTimers();
    try {
      const ui = screenSetup();
      createSpinner({
        ansi: ui.ansi,
        frameMs: 0,
        frames: ARC,
        interval: 10,
        terminal: ui.terminal,
        text: 'x',
      }).start();

      vi.advanceTimersByTime(10);
      vi.advanceTimersToNextTimer();
      expect(ui.frame).toBe(`${ARC.frames[1]} x`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not spin hot on a set whose interval is not positive', () => {
    vi.useFakeTimers();
    try {
      const ui = screenSetup();
      createSpinner({
        ansi: ui.ansi,
        frameMs: 0,
        frames: { frames: ['a', 'b'], interval: 0 },
        terminal: ui.terminal,
        text: 'x',
      }).start();

      vi.advanceTimersByTime(79);
      vi.advanceTimersToNextTimer();
      expect(ui.frame).toBe('a x');
    } finally {
      vi.useRealTimers();
    }
  });

  it('should keep the spaces at the end of a frame', () => {
    // a text drops the whitespace at the end of its last line, so `'.  '` drew
    // one column wide and `'   '` none, and the label jumped every tick
    vi.useFakeTimers();
    try {
      const ui = screenSetup();
      createSpinner({
        ansi: ui.ansi,
        frameMs: 0,
        frames: tail.SIMPLE_DOTS,
        terminal: ui.terminal,
        text: 'Working',
      }).start();

      const seen: string[] = [];
      for (const _ of tail.SIMPLE_DOTS.frames) {
        seen.push(ui.frame);
        vi.advanceTimersByTime(tail.SIMPLE_DOTS.interval);
        vi.advanceTimersToNextTimer();
      }

      expect(seen).toEqual(['.   Working', '..  Working', '... Working', '    Working']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should keep the spaces inside a frame', () => {
    const ui = screenSetup();
    createSpinner({
      ansi: ui.ansi,
      frames: BOUNCING_BAR,
      terminal: ui.terminal,
      text: 'Working',
    }).start();

    expect(ui.frame).toBe('[    ] Working');
  });

  it('should not pad the mark it settles with to the frame', () => {
    const ui = screenSetup();
    createSpinner({ ansi: ui.ansi, frames: BOUNCING_BAR, terminal: ui.terminal, text: 'x' })
      .start()
      .succeed('Done');

    expect(ui.log).toContain(`${OUTCOME_SYMBOLS.success} Done`);
  });
});
