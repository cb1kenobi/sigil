import { escapeControls as published } from '../../src/error-handler.js';
import { escapeControls } from '../../src/util/escape-controls.js';
import { describe, expect, it } from 'vitest';

describe('escapeControls()', () => {
  it('should be what @ttylabs/sigil/error-handler publishes', () => {
    expect(published).toBe(escapeControls);
  });

  it('should write every C0, DEL and C1 character as two upper-case hex digits', () => {
    for (let code = 0; code <= 0xff; code++) {
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
    // below U+1000 the escape is padded to four digits
    expect(escapeControls('\u0600\u061c')).toBe('\\u{0600}\\u{061C}');
  });

  it('should write the Hangul fillers and the combining grapheme joiner, which are in no format class', () => {
    // U+115F and U+3164 are letters (`Lo`) drawn blank, U+034F is a mark: a value
    // holding one prints like one that does not
    expect(escapeControls('a\u3164b\u115fc\u034fd')).toBe('a\\u{3164}b\\u{115F}c\\u{034F}d');
    expect(escapeControls('a\u1160b\uffa0c')).toBe('a\\u{1160}b\\u{FFA0}c');
    expect(escapeControls('ab')).not.toBe(escapeControls('a\u3164b'));
  });

  it('should write a variation selector, U+FE0F after an emoji included', () => {
    // a heart then VS16: the selector is what chose the emoji glyph, and it is
    // there whether or not anything is drawn for it
    expect(escapeControls('\u2764\ufe0f')).toBe('\u2764\\u{FE0F}');
    expect(escapeControls('a\ufe00b\ufe0e')).toBe('a\\u{FE00}b\\u{FE0E}');
    // the supplementary selectors: a payload has been hidden in these
    expect(escapeControls('\u{e0100}\u{e01ef}')).toBe('\\u{E0100}\\u{E01EF}');
  });

  it('should write the Mongolian free variation selectors and the unassigned points inside default-ignorable blocks', () => {
    expect(escapeControls('\u180b\u180d\u180f')).toBe('\\u{180B}\\u{180D}\\u{180F}');
    // unassigned, but default-ignorable, so as invisible as the tag characters
    expect(escapeControls('\u2065\ufff0\u{e0080}\u{e0fff}')).toBe(
      '\\u{2065}\\u{FFF0}\\u{E0080}\\u{E0FFF}'
    );
  });

  it('should escape exactly what the source check refuses, bar the spaces, and spell each one the same way', () => {
    // the class `FORMAT` in sources.test.ts names, without its `Zs` half -- which
    // is the one deliberate difference -- and with U+2800 (SIG-557), which no
    // property covers
    const unsafe = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/u;
    const wrong: string[] = [];
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const char = String.fromCodePoint(code);
      const hex = code.toString(16).toUpperCase();
      const want = unsafe.test(char)
        ? code < 0x100
          ? `\\x${hex.padStart(2, '0')}`
          : `\\u{${hex.padStart(4, '0')}}`
        : char;
      if (escapeControls(char) !== want) wrong.push(`U+${hex}`);
    }
    expect(wrong).toEqual([]);
  });

  it('should write the blank braille pattern as \\u{2800}, and leave the rest of the block alone', () => {
    // U+2800 draws as a space but is a symbol, so a value holding it prints like
    // one holding U+0020 and differs (SIG-557)
    expect(escapeControls('a\u2800b')).toBe('a\\u{2800}b');
    expect(escapeControls('a b')).not.toBe(escapeControls('a\u2800b'));
    // the dots are drawn
    expect(escapeControls('\u2801\u28ff')).toBe('\u2801\u28ff');
  });

  it('should leave nothing of the format class in a hostile value', () => {
    const hostile = 'a\u202eb\u200bc\u2028d\u2029e\ufefff\u{e0041}g\u200d\u3164\u034f\ufe0f\u2800';
    expect(escapeControls(hostile)).not.toMatch(
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/u
    );
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
