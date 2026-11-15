import { createAnsi } from '../../src/ansi/index.js';
import { nearestPaletteIndex, paletteRgb } from '../../src/ansi/quantize.js';
import { palette, rgb } from '../../src/canvas/index.js';
import { degradeColor, quantizeColor } from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);

/** Sixteen evenly spaced levels per channel: 4,096 colors, corners included. */
const STEPS = Array.from({ length: 16 }, (_, i) => i * 17);

/** The SGR parameter a color at this level is written with, from the style engine. */
function viaStyle(r: number, g: number, b: number, level: 1 | 2, background: boolean): string {
  const index = quantizeColor(rgb(r, g, b), level);
  if (level === 2) {
    return `${background ? 48 : 38};5;${index}`;
  }
  const base = index < 8 ? 30 + index : 90 + (index - 8);
  return String(background ? base + 10 : base);
}

/** The first SGR parameter string in a styled string. */
function params(text: string): string {
  const match = new RegExp(`${ESC}\\[([\\d;]+)m`).exec(text);
  return match![1]!;
}

describe('one quantizer for the styler and the style engine', () => {
  // two degraders, each with its own palette and metric, drew one declared
  // value as two colors: rgb(0, 0, 255) was bright blue through ansi.rgb() and
  // plain blue through the style engine, and 1,288 of 4,096 sampled colors
  // disagreed even at 256
  it.each([1, 2] as const)(
    'should write ansi.rgb() as the color the style engine degrades to at level %i',
    (level) => {
      const out = createAnsi({ level });
      const disagreeing: string[] = [];

      for (const r of STEPS) {
        for (const g of STEPS) {
          for (const b of STEPS) {
            const wanted = viaStyle(r, g, b, level, false);
            const got = params(out.rgb(r, g, b)('x'));
            if (got !== wanted) {
              disagreeing.push(`rgb(${r}, ${g}, ${b}): ansi ${got}, style ${wanted}`);
            }
          }
        }
      }

      expect(disagreeing.slice(0, 5)).toEqual([]);
      expect(disagreeing).toHaveLength(0);
    }
  );

  it.each([1, 2] as const)(
    'should write a background and a hex the same way at level %i',
    (level) => {
      const out = createAnsi({ level });

      for (const r of STEPS) {
        for (const g of STEPS) {
          for (const b of STEPS) {
            const hex = [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
            expect(params(out.bgRgb(r, g, b)('x'))).toBe(viaStyle(r, g, b, level, true));
            expect(params(out.hex(hex)('x'))).toBe(viaStyle(r, g, b, level, false));
          }
        }
      }
    }
  );

  it('should degrade an ansi256() color to what the style engine does with the same index at level 1', () => {
    const out = createAnsi({ level: 1 });

    for (let n = 0; n < 256; n++) {
      const index = degradeColor(palette(n), 1);
      const base = index < 8 ? 30 + index : 90 + (index - 8);
      expect(params(out.ansi256(n)('x')), `index ${n}`).toBe(String(base));
    }
  });

  it('should give the two examples in the ticket one answer', () => {
    expect(params(createAnsi({ level: 1 }).rgb(0, 0, 255)('x'))).toBe('34');
    expect(params(createAnsi({ level: 2 }).rgb(0, 0, 51)('x'))).toBe('38;5;17');
  });

  it('should never land on the sixteen at level 2, and only on them at level 1', () => {
    for (const r of STEPS) {
      for (const g of STEPS) {
        for (const b of STEPS) {
          expect(nearestPaletteIndex(r, g, b, 2)).toBeGreaterThanOrEqual(16);
          expect(nearestPaletteIndex(r, g, b, 1)).toBeLessThan(16);
        }
      }
    }
  });

  it('should map every palette entry to itself', () => {
    for (let n = 16; n < 256; n++) {
      expect(nearestPaletteIndex(...paletteRgb(n), 2)).toBe(n);
    }
    for (let n = 0; n < 16; n++) {
      expect(nearestPaletteIndex(...paletteRgb(n), 1)).toBe(n);
    }
  });
});
