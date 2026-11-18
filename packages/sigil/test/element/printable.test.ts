import { printable, renderToString, text, toDisplayText } from '../../src/element/index.js';
import { stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

/**
 * `printable()`: a control character drawn as `�` rather than dropped, which is
 * what a file name needs from a `text` and what both file examples wrote a copy
 * of before it was published here.
 */

/**
 * Renders a string in a text and reads the line back.
 *
 * @param value - The string.
 * @returns What the text drew.
 */
function drawn(value: string): string {
  return renderToString(text(value), { width: 40 });
}

describe('printable()', () => {
  it('should draw an escape in a file name as a replacement rather than dropping it', () => {
    const name = 'bad\u001b[31mname';
    // the defect: a text drops the ESC, and what is left is a different name
    expect(drawn(name)).toBe('bad[31mname');
    expect(drawn(printable(name))).toBe('bad�[31mname');
  });

  it('should replace one code unit with one, so an offset into the result is an offset into the original', () => {
    const name = 'a\u0000b\u001bc\u007fd\u0085e\u009ff\tg\nh';
    const shown = printable(name);
    expect(shown).toBe('a�b�c�d�e�f�g�h');
    expect(shown).toHaveLength(name.length);
    expect(shown.indexOf('h')).toBe(name.indexOf('h'));
    // and each replacement takes a column, where the character it replaced took none
    expect(stringWidth(shown)).toBe(name.length);
  });

  it('should mark DEL and the C1 controls as well as C0', () => {
    for (const code of [0x00, 0x1b, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f]) {
      expect(printable(String.fromCharCode(code)), code.toString(16)).toBe('�');
    }
    // the edges of the set, from outside
    expect(printable(' ~ ')).toBe(' ~ ');
  });

  it('should keep the control characters the caller names and only those', () => {
    expect(printable('one\ntwo\tthree', '\n')).toBe('one\ntwo�three');
    expect(printable('one\ntwo\tthree', '\n\t')).toBe('one\ntwo\tthree');
    expect(printable('a\u001bb', '\n\t')).toBe('a�b');
  });

  it('should leave what a text draws as it is', () => {
    expect(printable('')).toBe('');
    expect(printable('plain name.txt')).toBe('plain name.txt');
    expect(printable('日本語 🇯🇵 á')).toBe('日本語 🇯🇵 á');
  });

  it('should leave a format character alone, a joiner and a bidi control included', () => {
    // U+200D joins a family emoji, U+200C is how Persian spells some words, and a
    // bidi control is zero width and never reaches the terminal; none is a
    // control character, and widening the set to `\p{Cf}` would break the first two
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(printable(family)).toBe(family);
    expect(printable('a‌b')).toBe('a‌b');
    expect(printable('a‮b⁦c‏d')).toBe('a‮b⁦c‏d');
  });

  it('should leave a lone surrogate alone, since it already draws as a replacement', () => {
    expect(printable('a\uD800b')).toBe('a\uD800b');
    // one column, and UTF-8 has no lone surrogate to write, so it goes out as U+FFFD
    expect(stringWidth('\uD800')).toBe(1);
    expect(Buffer.from('\uD800', 'utf8')).toEqual(Buffer.from('�', 'utf8'));
  });
});

describe('the one set of control characters', () => {
  it('should mark exactly what a text would change, for every code point but the newline', () => {
    // A text keeps a newline, since it is what a line is split on, and draws a
    // tab as a space; every other control character it drops. So outside the
    // newline, `printable()` marks a character exactly when a text would not
    // draw it as given -- which is what one shared definition of the set means,
    // asked of every code point rather than of the ones somebody thought of
    const disagree: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code === 0x0a) {
        continue;
      }
      const char = String.fromCodePoint(code);
      const marked = printable(char) !== char;
      const changed = toDisplayText(char) !== char;
      if (marked !== changed) {
        disagree.push(code.toString(16));
      }
    }
    expect(disagree).toEqual([]);
  });

  it('should draw the newline and the tab as a text always has', () => {
    expect(toDisplayText('a\nb\tc\u001bd\u0085e')).toBe('a\nb cde');
    expect(printable('a\nb')).toBe('a�b');
  });
});
