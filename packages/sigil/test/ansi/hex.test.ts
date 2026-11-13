import { ansi, hexChannels } from '../../src/ansi/index.js';
import { rgb } from '../../src/canvas/index.js';
import { parseColor, StyleError } from '../../src/style/value.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Every hex reader in the package, by what it accepts and what it refuses.
 *
 * Three callers read hex digits through one function, and each keeps its own
 * rule about the `#`, about surrounding whitespace, and about what it throws.
 * These tables are what each caller did before the digits were shared and are
 * the proof that sharing them changed nothing: `ansi.hex()` takes the `#` or
 * not and trims nothing, a stylesheet's `parseColor()` requires the `#` and
 * trims, and the screenshot package's (in its own suite) does the same with a
 * `TypeError`. None of them takes four or eight digits.
 */

const ESC = String.fromCharCode(0x1b);

beforeEach(() => {
  ansi.level = 3;
});

afterEach(() => {
  ansi.level = undefined;
});

describe('hexChannels()', () => {
  it.each([
    ['abc', [0xaa, 0xbb, 0xcc]],
    ['ABC', [0xaa, 0xbb, 0xcc]],
    ['f00', [255, 0, 0]],
    ['000', [0, 0, 0]],
    ['fff', [255, 255, 255]],
    ['5f87af', [95, 135, 175]],
    ['5F87aF', [95, 135, 175]],
    ['000000', [0, 0, 0]],
    ['ffffff', [255, 255, 255]],
    ['102030', [0x10, 0x20, 0x30]],
  ] as const)('should read %j', (digits, channels) => {
    expect(hexChannels(digits)).toEqual(channels);
  });

  // the `#` is the caller's to take off, and four and eight digits are CSS's
  // alpha forms, which no caller has ever taken
  it.each([
    '',
    '#abc',
    '#aabbcc',
    'ab',
    'abcd',
    'abcde',
    'aabbccd',
    'aabbccdd',
    'abg',
    ' abc',
    'abc ',
    'abc\n',
    '0xabc',
    'a b c',
    '１２３',
  ])('should answer undefined for %j', (text) => {
    expect(hexChannels(text)).toBeUndefined();
  });
});

describe('ansi.hex() and ansi.bgHex()', () => {
  const accepted: [input: unknown, channels: [number, number, number]][] = [
    ['#abc', [0xaa, 0xbb, 0xcc]],
    ['abc', [0xaa, 0xbb, 0xcc]],
    ['#ABC', [0xaa, 0xbb, 0xcc]],
    ['AbC', [0xaa, 0xbb, 0xcc]],
    ['#f00', [255, 0, 0]],
    ['#5f87af', [95, 135, 175]],
    ['5F87AF', [95, 135, 175]],
    ['#000000', [0, 0, 0]],
    ['ffffff', [255, 255, 255]],
    // `String()` is applied first, so a number of three digits is a colour
    [123, [0x11, 0x22, 0x33]],
  ];

  it.each(accepted)('should accept %j', (input, [r, g, b]) => {
    expect(ansi.hex(input as string)('x')).toBe(`${ESC}[38;2;${r};${g};${b}mx${ESC}[39m`);
    expect(ansi.bgHex(input as string)('x')).toBe(`${ESC}[48;2;${r};${g};${b}mx${ESC}[49m`);
  });

  const refused: unknown[] = [
    '',
    '#',
    '#ab',
    'ab',
    '#abcd',
    'abcd',
    '#abcde',
    '#aabbccd',
    '#aabbccdd',
    'aabbccdd',
    '##abc',
    '#abg',
    'xyz',
    ' #abc',
    '#abc ',
    'abc\n',
    '0xabc',
    '#a b c',
  ];

  it.each(refused)('should refuse %j with an Error naming it', (input) => {
    for (const method of [ansi.hex, ansi.bgHex]) {
      let thrown: unknown;
      try {
        method.call(ansi, input as string);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).constructor).toBe(Error);
      expect((thrown as Error).message).toBe(`Invalid hex color "${String(input)}"`);
    }
  });
});

describe("a stylesheet's parseColor()", () => {
  const accepted: [input: string, channels: [number, number, number]][] = [
    ['#abc', [0xaa, 0xbb, 0xcc]],
    ['#ABC', [0xaa, 0xbb, 0xcc]],
    ['#f80', [255, 136, 0]],
    ['#ff8800', [255, 136, 0]],
    ['#5F87af', [95, 135, 175]],
    [' #abc ', [0xaa, 0xbb, 0xcc]],
    ['\t#aabbcc\n', [0xaa, 0xbb, 0xcc]],
  ];

  it.each(accepted)('should accept %j', (input, [r, g, b]) => {
    expect(parseColor(input)).toBe(rgb(r, g, b));
  });

  const refused: string[] = [
    'abc',
    'aabbcc',
    'ABCDEF',
    '#',
    '#ab',
    '#abcd',
    '#abcde',
    '#aabbccd',
    '#aabbccdd',
    '##abc',
    '#abg',
    '# abc',
    '0xabc',
  ];

  it.each(refused)('should refuse %j with a StyleError naming it', (input) => {
    expect(() => parseColor(input)).toThrow(StyleError);
    expect(() => parseColor(input)).toThrow(`Invalid colour "${input.trim()}"`);
  });
});
