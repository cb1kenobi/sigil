import { escapeControls as published } from '../../src/error-handler.js';
import { escapeControls } from '../../src/util/escape-controls.js';
import { describe, expect, it } from 'vitest';

describe('escapeControls()', () => {
  it('should be what @ttylabs/sigil/error-handler publishes', () => {
    expect(published).toBe(escapeControls);
  });

  it('should write every C0, DEL and C1 character as two upper-case hex digits', () => {
    for (let code = 0; code <= 0xa0; code++) {
      const char = String.fromCharCode(code);
      // U+00AD, the soft hyphen, is a format character and takes the same spelling
      const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xad;
      expect(escapeControls(char)).toBe(
        control ? `\\x${code.toString(16).toUpperCase().padStart(2, '0')}` : char
      );
    }
  });

  it('should escape a tab, a newline and a carriage return like the rest', () => {
    // a newline in an echoed value would forge a second line of the message
    expect(escapeControls('a\tb\nError: forged\r')).toBe('a\\x09b\\x0AError: forged\\x0D');
  });

  it('should leave what is not a control character alone', () => {
    // a no-break space, a combining mark, an emoji, a backslash, an ideographic
    // space and a line of CJK: none of them is `\p{Cc}`, `\p{Cf}`, U+2028 or U+2029
    const text = 'caf\u00e9 \u00a0 e\u0301 \u{1f600} C:\\x1B \u3000 \u65e5\u672c';
    expect(escapeControls(text)).toBe(text);
  });

  it('should write a right-to-left override as \\u{202E}', () => {
    // the terminal draws what follows U+202E reversed, so the message would
    // read differently from what was written
    expect(escapeControls('o/n\u202e')).toBe('o/n\\u{202E}');
    expect(escapeControls('a\u202eb\u202dc\u2066d\u2069')).toBe(
      'a\\u{202E}b\\u{202D}c\\u{2066}d\\u{2069}'
    );
  });

  it('should write a zero-width character as an escape, so two values that print alike differ', () => {
    expect(escapeControls('a\u200bb')).toBe('a\\u{200B}b');
    expect(escapeControls('a\u200cb\u200db\u200e\u2060')).toBe(
      'a\\u{200C}b\\u{200D}b\\u{200E}\\u{2060}'
    );
    expect(escapeControls('ab')).not.toBe(escapeControls('a\u200bb'));
  });

  it('should write a line and a paragraph separator as an escape', () => {
    // either one ends a line to JavaScript, which is a forged second line
    expect(escapeControls('x\u2028Error: forged\u2029')).toBe('x\\u{2028}Error: forged\\u{2029}');
  });

  it('should write the joiners in an emoji, which is what was typed', () => {
    // a family emoji is three pictographs joined by U+200D
    expect(escapeControls('\u{1f468}\u200d\u{1f469}\u200d\u{1f467}')).toBe(
      '\u{1f468}\\u{200D}\u{1f469}\\u{200D}\u{1f467}'
    );
  });

  it('should write a byte order mark, a soft hyphen and a tag character', () => {
    expect(escapeControls('\ufeffa')).toBe('\\u{FEFF}a');
    expect(escapeControls('a\u00adb')).toBe('a\\xADb');
    // above the BMP: the escape takes as many digits as the code point needs
    expect(escapeControls('\u{e0041}')).toBe('\\u{E0041}');
    expect(escapeControls('\u{e0001}')).toBe('\\u{E0001}');
  });

  it('should leave nothing of the format class in a hostile value', () => {
    const hostile = 'a\u202eb\u200bc\u2028d\u2029e\ufefff\u{e0041}g\u200d';
    expect(escapeControls(hostile)).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it('should leave every other space alone', () => {
    // \p{Zs} is drawn, so a value holding one reads as the value it is
    const spaces = '\u00a0\u1680\u2000\u2003\u2009\u202f\u205f\u3000';
    expect(escapeControls(spaces)).toBe(spaces);
  });

  it('should turn a value that is not a string into one first', () => {
    expect(escapeControls(42)).toBe('42');
    expect(escapeControls(undefined)).toBe('undefined');
    expect(escapeControls({ [Symbol.toStringTag]: '\u001b[2J' })).toBe('[object \\x1B[2J]');
  });

  it('should leave nothing for a terminal to act on in a hostile value', () => {
    expect(escapeControls('bu\u001b]0;PWNED\u0007ild')).toBe('bu\\x1B]0;PWNED\\x07ild');
    expect(escapeControls('\u009b2J\u007f')).toBe('\\x9B2J\\x7F');
    expect(escapeControls('\u001b[2J\u001b]52;c;ZXZpbA==\u0007')).not.toMatch(/\p{Cc}/u);
  });
});
