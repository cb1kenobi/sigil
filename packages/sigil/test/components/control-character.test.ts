import { holdsControl, refuseControl } from '../../src/components/control-character.js';
import { createMultiProgress } from '../../src/components/multi-progress.js';
import { outline } from '../../src/components/outline.js';
import { pageIndicator, paginatorState, paginatorView } from '../../src/components/paginator.js';
import {
  createProgress,
  progressState,
  progressView,
  renderBar,
} from '../../src/components/progress.js';
import {
  createSpinner,
  spinnerFrames,
  spinnerView,
  spinnerState,
} from '../../src/components/spinner.js';
import { describe, expect, it } from 'vitest';

/**
 * A configured glyph holding a control character is refused where it is
 * configured (SIG-685).
 *
 * Each of these was measured with `stringWidth()` and drawn as a text, and the two
 * disagree about a tab -- a column drawn and nothing counted -- so the cell a glyph
 * owns came out short. The rule is one function, `holdsControl()`, which the
 * toggle's state names and the text area's gutter also ask.
 */

const TAB = '\t';
const BELL = String.fromCharCode(7);
const ESC = String.fromCharCode(0x1b);

describe('holdsControl() and refuseControl()', () => {
  it('should hold C0, DEL and C1, which is what the toggle and the gutter always refused', () => {
    expect(holdsControl(TAB)).toBe(true);
    expect(holdsControl('\n')).toBe(true);
    expect(holdsControl(ESC)).toBe(true);
    expect(holdsControl(String.fromCharCode(0x7f))).toBe(true);
    expect(holdsControl(String.fromCharCode(0x9b))).toBe(true);
  });

  it('should leave a format character, a wide glyph and a space alone', () => {
    const joined = ['a', String.fromCharCode(0x200d), 'b'].join('');
    const nbsp = String.fromCharCode(0xa0);
    for (const glyph of ['', ' ', '●', '\u2588', '\u{1F600}', joined, nbsp]) {
      expect(holdsControl(glyph), JSON.stringify(glyph)).toBe(false);
    }
  });

  it('should quote the offending value with its control characters escaped', () => {
    let message = '';
    try {
      refuseControl('a thing', `x${ESC}[2J${TAB}`);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe('Expected a thing to hold no control character, got "x\\x1B[2J\\x09"');
    expect(message).not.toContain(ESC);
  });
});

describe('a spinner frame', () => {
  it.each([
    ['a tab', `a${TAB}`],
    ['a bell', BELL],
    ['an escape', `${ESC}[31m|${ESC}[0m`],
  ])('should refuse %s where the frames are configured', (_name, frame) => {
    expect(() => createSpinner({ frames: ['-', frame] })).toThrow(
      /spinner frames\[1\] to hold no control character/
    );
    expect(() => createSpinner({ frames: { frames: [frame], interval: 50 } })).toThrow(TypeError);
    expect(() => spinnerFrames({ frames: [frame] })).toThrow(TypeError);
  });

  it('should refuse one in a set that never went through spinnerFrames()', () => {
    expect(() => spinnerView(spinnerState(), ['-', `\\${TAB}`])).toThrow(/spinner frames\[1\]/);
  });

  it('should still take the frames it was always given', () => {
    expect(spinnerFrames({ frames: ['-', '\\', '|', '/'] }).frames).toHaveLength(4);
    expect(() => spinnerView(spinnerState(), ['.', '..'])).not.toThrow();
  });
});

describe('a progress bar character', () => {
  it.each([
    ['filled', { filled: `#${TAB}` }, /filled character to hold no control character/],
    ['empty', { empty: TAB }, /empty character to hold no control character/],
  ] as const)('should refuse a tab in %s when the bar is created', (_name, opts, pattern) => {
    expect(() => createProgress(opts)).toThrow(pattern);
    expect(() => createMultiProgress(opts)).toThrow(pattern);
  });

  it('should refuse one handed straight to renderBar() or progressView()', () => {
    expect(() => renderBar(0.5, 10, '#', TAB)).toThrow(/empty character/);
    expect(() => renderBar(0.5, 10, TAB, '-')).toThrow(/filled character/);
    expect(() =>
      progressView(progressState('', 100), {
        barWidth: () => 10,
        empty: '-',
        filled: BELL,
        live: false,
        step: 10,
      })
    ).toThrow(/filled character/);
  });

  it('should still draw a bar of wide and of empty glyphs', () => {
    expect(renderBar(0.5, 4, '#', '-')).toBe('##--');
    expect(renderBar(0.5, 4, '#', '')).toBe('##');
  });
});

describe('a page indicator dot', () => {
  const opts = { colorLevel: 0 as const, env: {}, platform: 'linux' };

  it.each([
    ['active', { active: `*${TAB}` }, /active dot/],
    ['inactive', { inactive: TAB }, /inactive dot/],
  ] as const)('should refuse a tab in the %s one', (_name, dots, pattern) => {
    expect(() => pageIndicator(1, 3, { ...opts, ...dots })).toThrow(pattern);
    expect(() =>
      paginatorView(paginatorState({ perPage: 5, total: 15 }), { ...opts, ...dots })
    ).toThrow(pattern);
  });

  it('should still draw the dots it was given', () => {
    expect(pageIndicator(1, 3, { ...opts, active: '@', inactive: '_' })).toBe('_ @ _');
  });
});

describe('an outline marker', () => {
  const opts = { colorLevel: 0 as const, env: {}, platform: 'linux', width: 40 };

  it('should refuse a tab a function returns, naming the item and the depth', () => {
    expect(() =>
      outline(['a', 'b'], { ...opts, enumerator: ({ index }) => `${index}${TAB}` })
    ).toThrow(/an outline marker for item 1 at depth 0 to hold no control character, got "0\\x09"/);
    expect(() =>
      outline([{ items: ['b'], text: 'a' }], {
        ...opts,
        enumerator: ['bullet', () => BELL],
      })
    ).toThrow(/item 1 at depth 1/);
  });

  it('should still read a line break as a space and drop an escape sequence', () => {
    expect(outline(['a'], { ...opts, enumerator: () => 'x\ny' })).toBe('x y a');
    expect(outline(['a'], { ...opts, enumerator: () => `${ESC}[31m#${ESC}[0m` })).toBe('# a');
  });
});
