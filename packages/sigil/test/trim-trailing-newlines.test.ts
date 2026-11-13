import { trimTrailingNewlines } from '../src/util/trim-trailing-newlines.js';
import { describe, expect, it } from 'vitest';

describe('trimTrailingNewlines', () => {
  it('should trim a trailing run of \\n', () => {
    expect(trimTrailingNewlines('a\n\n\n')).toBe('a');
  });

  it('should trim a trailing run of \\r\\n', () => {
    expect(trimTrailingNewlines('a\r\n\r\n')).toBe('a');
  });

  it('should trim a trailing run that mixes \\r and \\n in any order', () => {
    expect(trimTrailingNewlines('a\n\r\r\n\n\r')).toBe('a');
  });

  it('should leave a text with no trailing newline as it was', () => {
    expect(trimTrailingNewlines('a\n\nb')).toBe('a\n\nb');
    expect(trimTrailingNewlines('')).toBe('');
  });

  it('should leave interior newlines and trailing spaces alone', () => {
    expect(trimTrailingNewlines('a\r\n\nb \n')).toBe('a\r\n\nb ');
    expect(trimTrailingNewlines('a\t\n')).toBe('a\t');
  });

  it('should answer the empty string for a text that is all newlines', () => {
    expect(trimTrailingNewlines('\n')).toBe('');
    expect(trimTrailingNewlines('\r\n\r\n\n\r')).toBe('');
  });

  it('should agree with the regex it replaced', () => {
    for (const text of ['', 'x', '\n', 'x\n', 'x\r\n', '\nx', '\r\nx\r\n\n', 'x\n\ny\r', ' \n ']) {
      expect(trimTrailingNewlines(text)).toBe(text.replace(/[\r\n]+$/, ''));
    }
  });

  // SIG-342: `replace(/[\r\n]+$/, '')` is not anchored at its start, so an
  // interior run of k newlines is tried from each of its k positions -- k² steps.
  // 200,000 is tens of seconds that way and under a millisecond this way, so the
  // test timeout is what fails a regression rather than a wall-clock assertion --
  // and the test below is the deterministic half, since a timeout is only
  // reported once synchronous code has finished
  it('should not be quadratic in an interior run of newlines', () => {
    const run = '\n'.repeat(200_000);
    expect(trimTrailingNewlines(`a${run}x`)).toBe(`a${run}x`);
    expect(trimTrailingNewlines(`a${run}x${run}`)).toBe(`a${run}x`);
  });

  it('should be a walk rather than a regex, which is what keeps it linear', () => {
    const source = trimTrailingNewlines.toString();
    expect(source).not.toMatch(/RegExp|\.replace\(|\.match\(|\.test\(|\.exec\(/);
    expect(source).toContain('charCodeAt');
  });
});
