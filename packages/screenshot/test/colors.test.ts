import { BUILTIN_PALETTES, colorOf, parseColor, resolveColors } from '../src/colors.js';
import { DEFAULT_COLOR, palette, rgb } from '@ttylabs/sigil/canvas';
import { parseCapabilityResponse, readCapabilities } from '@ttylabs/sigil/input';
import { describe, expect, it } from 'vitest';

/**
 * Which colours a screenshot is drawn in: the options, then the terminal, then
 * the built-in palette for the scheme -- and per colour, not per source.
 */

const ESC = '\u001b';
const BEL = '\u0007';

describe('the precedence', () => {
  it('should use the built-in dark palette when nothing says otherwise', () => {
    const colors = resolveColors({ env: {} });
    expect(colors.colorScheme).toBe('dark');
    expect(colors).toEqual(BUILTIN_PALETTES.dark);
  });

  it('should take what the terminal reported over the built-in', () => {
    const terminal = readCapabilities(
      [
        `${ESC}]10;rgb:aaaa/bbbb/cccc${BEL}`,
        `${ESC}]11;rgb:ffff/ffff/ffff${BEL}`,
        `${ESC}]4;1;rgb:8080/0000/0000${BEL}`,
      ].map(parseReply)
    );
    const colors = resolveColors({ env: {}, terminal });
    expect(colors.foreground).toEqual({ b: 0xcc, g: 0xbb, r: 0xaa });
    expect(colors.background).toEqual({ b: 255, g: 255, r: 255 });
    expect(colors.palette[1]).toEqual({ b: 0, g: 0, r: 128 });
    // a white background reported makes the scheme light, and the entries the
    // terminal did not answer come from the light palette
    expect(colors.colorScheme).toBe('light');
    expect(colors.palette[2]).toEqual(BUILTIN_PALETTES.light.palette[2]);
  });

  it('should take the options over the terminal', () => {
    const colors = resolveColors({
      bg: '#000',
      env: {},
      fg: { b: 1, g: 2, r: 3 },
      palette: [undefined, '#00ff00'],
      terminal: { background: { b: 9, g: 9, r: 9 }, palette: [undefined, { b: 7, g: 7, r: 7 }] },
    });
    expect(colors.background).toEqual({ b: 0, g: 0, r: 0 });
    expect(colors.foreground).toEqual({ b: 1, g: 2, r: 3 });
    expect(colors.palette[1]).toEqual({ b: 0, g: 255, r: 0 });
    // a hole in the option falls through to the built-in, not to nothing
    expect(colors.palette[0]).toEqual(BUILTIN_PALETTES.dark.palette[0]);
  });

  it('should resolve the scheme the way a renderer does', () => {
    // an explicit option first
    expect(
      resolveColors({ colorScheme: 'light', env: { SIGIL_COLOR_SCHEME: 'dark' } }).colorScheme
    ).toBe('light');
    // then the user's override, over the terminal's report
    expect(
      resolveColors({ env: { SIGIL_COLOR_SCHEME: 'light' }, terminal: { colorScheme: 'dark' } })
        .colorScheme
    ).toBe('light');
    // then the terminal, over COLORFGBG
    expect(
      resolveColors({ env: { COLORFGBG: '0;15' }, terminal: { colorScheme: 'dark' } }).colorScheme
    ).toBe('dark');
    // then COLORFGBG
    expect(resolveColors({ env: { COLORFGBG: '0;15' } }).colorScheme).toBe('light');
  });

  it('should refuse a palette longer than sixteen and a scheme that is not one', () => {
    expect(() => resolveColors({ env: {}, palette: Array(17).fill('#000') })).toThrow(/at most 16/);
    expect(() => resolveColors({ colorScheme: 'sepia' as 'dark', env: {} })).toThrow(/colorScheme/);
  });
});

describe('a colour option', () => {
  it('should read both hex forms and channels', () => {
    expect(parseColor('#fff')).toEqual({ b: 255, g: 255, r: 255 });
    expect(parseColor('#102030')).toEqual({ b: 0x30, g: 0x20, r: 0x10 });
    expect(parseColor({ b: 3, g: 2, r: 1 })).toEqual({ b: 3, g: 2, r: 1 });
  });

  it.each(['red', '#ff', '#gggggg', 'ffffff', ''])('should refuse %j', (value) => {
    expect(() => parseColor(value)).toThrow(TypeError);
  });

  it('should refuse a channel out of range rather than clamp it', () => {
    expect(() => parseColor({ b: 256, g: 0, r: 0 })).toThrow(TypeError);
    expect(() => parseColor({ b: 0.5, g: 0, r: 0 })).toThrow(TypeError);
  });
});

describe('what a cell colour looks like', () => {
  const colors = resolveColors({ env: {} });

  it('should read the defaults in their roles', () => {
    expect(colorOf(DEFAULT_COLOR, colors, 'fg')).toBe(colors.foreground);
    expect(colorOf(DEFAULT_COLOR, colors, 'bg')).toBe(colors.background);
  });

  it('should take the sixteen from the palette and the rest from the xterm cube', () => {
    expect(colorOf(palette(9), colors, 'fg')).toBe(colors.palette[9]);
    // 196 is the cube's pure red, and 232 the darkest grey
    expect(colorOf(palette(196), colors, 'fg')).toEqual({ b: 0, g: 0, r: 255 });
    expect(colorOf(palette(232), colors, 'fg')).toEqual({ b: 8, g: 8, r: 8 });
  });

  it('should unpack 24-bit as it was packed', () => {
    expect(colorOf(rgb(1, 2, 3), colors, 'fg')).toEqual({ b: 3, g: 2, r: 1 });
  });
});

/** A reply, parsed the way the router hands one to `readCapabilities()`. */
function parseReply(sequence: string): NonNullable<ReturnType<typeof parseCapabilityResponse>> {
  const reply = parseCapabilityResponse(sequence);
  if (!reply) {
    throw new Error(`not a reply: ${JSON.stringify(sequence)}`);
  }
  return reply;
}
