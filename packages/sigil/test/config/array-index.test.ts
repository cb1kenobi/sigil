import { isArrayIndex } from '../../src/config/index.js';
import { describe, expect, it } from 'vitest';

describe('isArrayIndex()', () => {
  // SIG-242: the output formats asked a pattern and the YAML store asked a
  // round trip through `Number`, each written separately. They agreed over
  // every key below, which is what made one of them safe to delete -- and these
  // are the keys either spelling could have got wrong, so the one that is left
  // is pinned over all of them
  it.each([
    ['0', true],
    ['7', true],
    ['4294967294', true],
    ['4294967295', false],
    ['-1', false],
    ['-0', false],
    ['01', false],
    ['1.5', false],
    ['1.0', false],
    ['1e3', false],
    ['+1', false],
    [' 1', false],
    ['0x10', false],
    ['', false],
    ['NaN', false],
    ['Infinity', false],
    ['9007199254740991', false],
    ['99999999999999999999', false],
  ])('should answer %j as %s', (key, expected) => {
    expect(isArrayIndex(key)).toBe(expected);
  });
});
