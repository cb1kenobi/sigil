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
      const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
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
    // a no-break space, a zero-width space, a combining mark, an emoji and a
    // backslash: none of them is `\p{Cc}`
    const text = 'caf\u00e9 \u00a0\u200b e\u0301 \u{1f600} C:\\x1B';
    expect(escapeControls(text)).toBe(text);
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
