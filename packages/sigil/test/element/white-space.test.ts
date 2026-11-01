import {
  box,
  type Element,
  type ElementProps,
  renderToString,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import type { WhiteSpace } from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/**
 * `white-space`, which is read in exactly one place: `Text.#wrap()`.
 *
 * Asserted through `renderToString()` because what the property decides is what
 * a line comes to beside the next thing on it, and a measurement alone does not
 * show the column a space was supposed to hold.
 */

/** A text beside an `x`, so a trailing space that was measured away shows. */
function beside(value: string, whiteSpace: WhiteSpace): string {
  return renderToString(
    box({ 'flex-direction': 'row' }, text(value, { 'white-space': whiteSpace }), text('x')),
    { colorLevel: 0, width: 20 }
  );
}

/** A text with its props resolved, so its measure reads the style it was given. */
function resolved(value: string, props: ElementProps = {}): Element {
  const el = text(value, props);
  resolveStyles(el);
  return el;
}

/** A text in a box narrower than it, so a wrap shows. */
function inside(value: string, whiteSpace: WhiteSpace, width: number): string {
  return renderToString(box({ width }, text(value, { 'white-space': whiteSpace })), {
    colorLevel: 0,
    width,
  });
}

describe('white-space', () => {
  // SIG-207: `#wrap()` asked `whiteSpace === 'nowrap'` and sent everything else
  // through `wrap()`, so `pre` was `normal` under another name -- it wrapped at
  // the box and dropped the spaces at a line end, which is prose's rule
  it('should keep every space of a pre text, and read it as normal no longer', () => {
    expect(beside('│   ', 'pre')).toBe('│   x');
    expect(beside('a  ', 'pre')).toBe('a  x');
    expect(beside('   ', 'pre')).toBe('   x');
    expect(beside('  a', 'pre')).toBe('  ax');
  });

  it('should break a pre text only at a newline, whatever the box', () => {
    // the box is eight columns and the line is thirteen: it is not wrapped, and
    // its minimum is the whole line, so it overflows the box -- which a string
    // prints whole, as it does a flag name wider than the terminal
    expect(inside('aaa bbb   ccc', 'pre', 8)).toBe('aaa bbb   ccc');
    expect(inside('aaa bbb   ccc', 'pre', 20)).toBe('aaa bbb   ccc');
    expect(inside(' a \n  b  ', 'pre', 20)).toBe(' a\n  b');
    expect(resolved('aaa bbb   ccc', { 'white-space': 'pre' }).measure?.(8)).toEqual({
      height: 1,
      minHeight: 1,
      minWidth: 13,
      width: 13,
    });
  });

  it('should measure pre exactly as nowrap', () => {
    for (const value of ['│   ', 'a  ', '   ', 'aaa bbb   ccc', ' a \n  b  ', '']) {
      const pre = resolved(value, { 'white-space': 'pre' });
      const nowrap = resolved(value, { 'white-space': 'nowrap' });
      for (const width of [0, 1, 3, 8, 40]) {
        expect(pre.wrapped(width)).toEqual(nowrap.wrapped(width));
      }
    }
  });

  it('should leave normal wrapping, and a run of nothing but spaces measuring zero', () => {
    // the rule the choice list's pointer column and the toggle's names are
    // written around: `normal` drops the spaces at a line end, so a text of
    // nothing but spaces is nothing at all
    expect(beside('│   ', 'normal')).toBe('│x');
    expect(beside('a  ', 'normal')).toBe('ax');
    expect(beside('   ', 'normal')).toBe('x');
    expect(inside('aaa bbb   ccc', 'normal', 8)).toBe('aaa bbb\nccc');
    // and, unlike CSS, an interior run and leading indentation are kept
    expect(inside('aaa bbb   ccc', 'normal', 20)).toBe('aaa bbb   ccc');
    expect(beside('  a', 'normal')).toBe('  ax');
    expect(resolved('   ').measure?.(20)).toMatchObject({ width: 0 });
  });

  it('should leave nowrap keeping its spaces, which is where it departs from CSS', () => {
    expect(beside('│   ', 'nowrap')).toBe('│   x');
    expect(beside('a  ', 'nowrap')).toBe('a  x');
    expect(inside('aaa bbb   ccc', 'nowrap', 20)).toBe('aaa bbb   ccc');
    expect(inside(' a \n  b  ', 'nowrap', 20)).toBe(' a\n  b');
  });

  it('should cache a pre text under one key, as a nowrap one is', () => {
    // the answer does not depend on the width, so layout and paint asking about
    // different widths must find the same entry rather than one each
    const one = (whiteSpace: WhiteSpace): Element =>
      resolved('aaa bbb   ccc', { 'white-space': whiteSpace });

    for (const whiteSpace of ['pre', 'nowrap'] as const) {
      const el = one(whiteSpace);
      expect(el.wrapped(8)).toBe(el.wrapped(40));
      expect(el.wrapped(1)).toBe(el.wrapped(13));
    }

    // and a wrapping text is one entry per width, since its answer is not
    const normal = one('normal');
    expect(normal.wrapped(8)).not.toBe(normal.wrapped(40));
  });
});
