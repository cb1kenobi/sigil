import { escapeRegExp } from '../../src/reference/index.js';
import { describe, expect, it } from 'vitest';

describe('escapeRegExp()', () => {
  const SYNTAX = [...'\\^$.*+?()[]{}|'];

  it.each(SYNTAX)('should escape %j', (char) => {
    expect(escapeRegExp(char)).toBe(`\\${char}`);
  });

  it('should leave everything else alone, a slash and a dash included', () => {
    expect(escapeRegExp('abc-/_ 1@#&!~,:;=<>\'"`')).toBe('abc-/_ 1@#&!~,:;=<>\'"`');
    expect(escapeRegExp('日本語')).toBe('日本語');
  });

  // the property that matters: the pattern matches the string and only it,
  // under every flag set a caller builds one with -- the pager's is `gu`
  it.each(['', 'u', 'v', 'gi'])('should match exactly the text under flags %j', (flags) => {
    const text = 'a.b*c+d?e^f$g(h)i[j]k{l}m|n\\o/p-q';
    const pattern = new RegExp(`^${escapeRegExp(text)}$`, flags);
    expect(pattern.test(text)).toBe(true);
    expect(pattern.test(text.replace('.', 'x'))).toBe(false);
  });

  it('should escape a package name the way sigil build reads one', () => {
    const external = new RegExp(`^${escapeRegExp('@scope/pkg.js')}/`);
    expect(external.test('@scope/pkg.js/sub')).toBe(true);
    expect(external.test('@scope/pkgxjs/sub')).toBe(false);
  });
});
