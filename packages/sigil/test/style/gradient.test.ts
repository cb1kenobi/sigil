import { ansi } from '../../src/ansi/index.js';
import { palette, rgb } from '../../src/canvas/style.js';
import { box, renderToString, text } from '../../src/element/index.js';
import {
  degradeColor,
  gradient,
  gradientBox,
  gradientColors,
  mixColors,
} from '../../src/style/index.js';
import { stringWidth } from '../../src/width/index.js';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';

// the escape character is built rather than typed: the repository keeps raw
// control characters out of source, and a test is source
const ESC = String.fromCharCode(0x1b);
const sgr = (params: string) => `${ESC}[${params}m`;
const OFF = sgr('39');
/** Any SGR sequence, for counting how many a string holds. */
const ANY_SGR = new RegExp(`${ESC}\\[[0-9;]+m`, 'g');

const RED = '#ff0000';
const BLUE = '#0000ff';

/** The truecolor open sequence for a triple. */
const fg = (r: number, g: number, b: number) => sgr(`38;2;${r};${g};${b}`);

/** The colour `column` of `span` columns along a red-to-blue ramp, as channels. */
function colorAtColumn(column: number, span: number): [number, number, number] {
  const value = mixColors(rgb(255, 0, 0), rgb(0, 0, 255), column / (span - 1))! - 0x100;
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** The middle colour of a three-cell red-to-blue ramp. */
const mid = () => colorAtColumn(1, 3);

describe('the ramp across a string', () => {
  it('should colour the first cell the first stop and the last cell the last', () => {
    expect(gradient('abc', [RED, BLUE], { level: 3 })).toBe(
      `${fg(255, 0, 0)}a${fg(...mid())}b${fg(0, 0, 255)}c${OFF}`
    );
  });

  it('should mix through Oklab, the way a transition does', () => {
    // and not the muddy sRGB midpoint, which is what a naive ramp would give
    expect(mid()).not.toEqual([128, 0, 128]);
    expect(mid()).toEqual(colorAtColumn(0.5, 2));
  });

  it('should be the first stop for a single stop, however long the text', () => {
    expect(gradient('abc', [RED], { level: 3 })).toBe(`${fg(255, 0, 0)}abc${OFF}`);
  });

  it('should be the first stop for a single cell', () => {
    expect(gradient('a', [RED, BLUE], { level: 3 })).toBe(`${fg(255, 0, 0)}a${OFF}`);
  });

  it('should pass through three stops, landing exactly on the middle one', () => {
    const out = gradient('abc', [RED, '#00ff00', BLUE], { level: 3 });
    expect(out).toBe(`${fg(255, 0, 0)}a${fg(0, 255, 0)}b${fg(0, 0, 255)}c${OFF}`);
  });

  it('should accept a colour built with rgb() as a stop', () => {
    expect(gradient('ab', [rgb(1, 2, 3), rgb(4, 5, 6)], { level: 3 })).toBe(
      `${fg(1, 2, 3)}a${fg(4, 5, 6)}b${OFF}`
    );
  });

  it('should leave the visible text exactly as it was', () => {
    const words = 'Hello, wörld 日本 👨‍👩‍👧 é';
    expect(stripVTControlCharacters(gradient(words, [RED, BLUE], { level: 3 }))).toBe(words);
  });

  it('should not split a grapheme cluster between two colours', () => {
    const family = '👨‍👩‍👧';
    const out = gradient(`a${family}b`, [RED, BLUE], { level: 3 });
    expect(out).toContain(family);
    // one open for each of the three clusters
    expect(out.split(`${ESC}[38;2`)).toHaveLength(4);
  });

  it('should ramp by column, so a wide character takes two columns of it', () => {
    // `日本` is four columns, as wide as `abcd`. A cluster is coloured by the
    // middle of its columns: 日 is columns 0-1, so 0.5, and 本 is 2-3, so 2.5
    const wide = gradient('日本', [RED, BLUE], { level: 3 });
    expect(wide).toBe(`${fg(...colorAtColumn(0.5, 4))}日${fg(...colorAtColumn(2.5, 4))}本${OFF}`);
    const narrow = gradient('abcd', [RED, BLUE], { level: 3 });
    expect(narrow).toContain(fg(0, 0, 255));
    expect(wide).not.toContain(fg(0, 0, 255));
  });

  it('should ramp every line over the widest, so a column is one colour', () => {
    const out = gradient('ab\nabc', [RED, BLUE], { level: 3 }).split('\n');
    expect(out[0].startsWith(fg(255, 0, 0))).toBe(true);
    // the short line stops short of the last stop
    expect(out[0]).not.toContain(fg(0, 0, 255));
    expect(out[1].endsWith(`${fg(0, 0, 255)}c${OFF}`)).toBe(true);
    // each line closes its own colour
    expect(out[0].endsWith(OFF)).toBe(true);
  });

  it('should return an empty string untouched', () => {
    expect(gradient('', [RED, BLUE], { level: 3 })).toBe('');
  });

  it('should keep the escape sequences it was handed and take no column for them', () => {
    const bold = `${sgr('1')}ab${sgr('22')}c`;
    const out = gradient(bold, [RED, BLUE], { level: 3 });
    expect(stripVTControlCharacters(out)).toBe('abc');
    expect(out).toContain(sgr('1'));
    // the sequence is not a cell: `c` is still the last of three
    expect(out).toContain(`${fg(0, 0, 255)}c`);
  });

  it('should colour again after a sequence of the text own, which may have reset it', () => {
    const out = gradient(`a${sgr('0')}a`, [RED, RED], { level: 3 });
    expect(out).toBe(`${fg(255, 0, 0)}a${sgr('0')}${fg(255, 0, 0)}a${OFF}`);
  });

  it('should write a colour once for a run of cells that share it', () => {
    expect(gradient('aaaa', [RED, RED], { level: 3 })).toBe(`${fg(255, 0, 0)}aaaa${OFF}`);
  });
});

describe('degrading to the terminal depth', () => {
  it('should be the text itself at level 0', () => {
    expect(gradient('abc', [RED, BLUE], { level: 0 })).toBe('abc');
    expect(gradient('a\nb', [RED, BLUE], { level: 0 })).toBe('a\nb');
  });

  it('should quantize every cell through the cascade degrader at level 2', () => {
    const out = gradient('abc', [RED, BLUE], { level: 2 });
    const mixed = mixColors(rgb(255, 0, 0), rgb(0, 0, 255), 0.5)!;
    const index = (c: number) => degradeColor(c, 2);
    expect(out).toBe(
      `${sgr(`38;5;${index(rgb(255, 0, 0))}`)}a${sgr(`38;5;${index(mixed)}`)}b` +
        `${sgr(`38;5;${index(rgb(0, 0, 255))}`)}c${OFF}`
    );
    expect(out).not.toContain('38;2');
  });

  it('should be one colour at level 1, the nearest basic colour to the first stop', () => {
    const out = gradient('abcdef', [RED, BLUE], { level: 1 });
    // pure red in xterm's defaults is bright red, index 9, which is SGR 91
    expect(degradeColor(rgb(255, 0, 0), 1)).toBe(9);
    expect(out).toBe(`${sgr('91')}abcdef${OFF}`);
  });

  it('should never band at level 1, whatever the stops', () => {
    const out = gradient('abcdefghij', ['#ff0000', '#00ff00', '#0000ff'], { level: 1 });
    expect(out.match(ANY_SGR)).toHaveLength(2);
  });

  it('should write nothing the level cannot render', () => {
    for (const level of [0, 1, 2] as const) {
      expect(gradient('abc', [RED, BLUE], { level })).not.toContain('38;2');
    }
  });

  it('should refuse a bad level rather than guess', () => {
    expect(() => gradient('a', [RED], { level: 7 as never })).toThrow(/color level/);
  });

  it('should default to the detected level', () => {
    const before = ansi.level;
    try {
      ansi.level = 0;
      expect(gradient('abc', [RED, BLUE])).toBe('abc');
      ansi.level = 3;
      expect(gradient('a', [RED, BLUE])).toBe(`${fg(255, 0, 0)}a${OFF}`);
    } finally {
      ansi.level = before;
    }
  });
});

describe('what a stop may be', () => {
  it('should refuse a list with no stops', () => {
    expect(() => gradient('a', [], { level: 3 })).toThrow(/at least one/);
  });

  it('should refuse a palette colour, which has no channels to blend', () => {
    expect(() => gradient('a', ['red', BLUE], { level: 3 })).toThrow(/24-bit/);
    expect(() => gradient('a', [palette(4), BLUE], { level: 3 })).toThrow(/24-bit/);
  });

  it('should refuse it at every level, so a stop list does not depend on the terminal', () => {
    expect(() => gradient('a', ['red', BLUE], { level: 0 })).toThrow(/24-bit/);
    expect(() => gradient('a', ['red', BLUE], { level: 1 })).toThrow(/24-bit/);
  });

  it('should refuse a colour it cannot read', () => {
    expect(() => gradient('a', ['#nope', BLUE], { level: 3 })).toThrow(/Invalid colour/);
  });

  it('should read the short hex form and rgb()', () => {
    expect(gradient('a', ['#f00'], { level: 3 })).toBe(`${fg(255, 0, 0)}a${OFF}`);
    expect(gradient('a', ['rgb(1, 2, 3)'], { level: 3 })).toBe(`${fg(1, 2, 3)}a${OFF}`);
  });
});

describe('the colours of a ramp', () => {
  it('should answer one colour per cell, ends exact', () => {
    const colors = gradientColors([RED, BLUE], 5, { level: 3 });
    expect(colors).toHaveLength(5);
    expect(colors[0]).toBe(rgb(255, 0, 0));
    expect(colors[4]).toBe(rgb(0, 0, 255));
  });

  it('should degrade each one, so a caller painting a canvas gets what it can emit', () => {
    for (const color of gradientColors([RED, BLUE], 9, { level: 2 })) {
      expect(color).toBeLessThan(0x100);
    }
  });

  it('should be the first stop for every cell at level 1', () => {
    expect(new Set(gradientColors([RED, BLUE], 6, { level: 1 }))).toEqual(new Set([9]));
  });

  it('should answer an empty list for zero cells and refuse a fractional count', () => {
    expect(gradientColors([RED, BLUE], 0, { level: 3 })).toEqual([]);
    expect(() => gradientColors([RED, BLUE], 1.5, { level: 3 })).toThrow(/whole number/);
  });
});

describe('a box with a ramp for a border', () => {
  it('should draw the same box the border-style property draws', () => {
    for (const border of ['ascii', 'bold', 'double', 'round', 'single'] as const) {
      const drawn = renderToString(
        // in a row, so the box is as wide as its content rather than the screen
        box(
          { 'flex-direction': 'row' },
          box({ 'border-style': border, padding: '0 1' }, text('hi there'))
        ),
        { colorLevel: 0, width: 20 }
      );
      expect(gradientBox('hi there', [RED, BLUE], { border, level: 0 }), border).toBe(drawn);
    }
  });

  it('should colour the border along the columns and leave the content alone', () => {
    const lines = gradientBox('hi', [RED, BLUE], { level: 3 }).split('\n');
    expect(lines).toHaveLength(3);
    // top-left is the first stop, top-right the last
    expect(lines[0].startsWith(`${fg(255, 0, 0)}╭${OFF}`)).toBe(true);
    expect(lines[0].endsWith(`${fg(0, 0, 255)}╮${OFF}`)).toBe(true);
    // the left edge of every row is the first stop and the right the last
    expect(lines[1].startsWith(`${fg(255, 0, 0)}│${OFF} hi `)).toBe(true);
    expect(lines[1].endsWith(`${fg(0, 0, 255)}│${OFF}`)).toBe(true);
    expect(lines[2].startsWith(`${fg(255, 0, 0)}╰${OFF}`)).toBe(true);
  });

  it('should be as wide as the widest line plus padding and border', () => {
    const lines = gradientBox('ab\nabcd\n日本', [RED, BLUE], { level: 3, padding: 2 }).split('\n');
    for (const line of lines) {
      expect(stringWidth(line)).toBe(4 + 4 + 2);
    }
  });

  it('should pad a row by display width, not by length', () => {
    const [, wide, narrow] = gradientBox('日本\nab', [RED, BLUE], { level: 0 }).split('\n');
    expect(stringWidth(wide)).toBe(stringWidth(narrow));
  });

  it('should keep the content exactly, styling and all', () => {
    const content = `${sgr('1')}bold${sgr('22')}`;
    expect(gradientBox(content, [RED, BLUE], { level: 3 })).toContain(` ${content} `);
  });

  it('should take no padding', () => {
    const lines = gradientBox('ab', [RED, BLUE], { level: 0, padding: 0 }).split('\n');
    expect(lines).toEqual(['╭──╮', '│ab│', '╰──╯']);
  });

  it('should be a plain box at level 0 and one colour at level 1', () => {
    expect(gradientBox('ab', [RED, BLUE], { level: 0 })).not.toContain(ESC);
    const one = gradientBox('ab', [RED, BLUE], { level: 1 });
    expect(new Set(one.match(ANY_SGR))).toEqual(new Set([sgr('91'), OFF]));
  });

  it('should refuse a border set and a padding that do not exist', () => {
    expect(() => gradientBox('a', [RED], { border: 'dotted' as never })).toThrow(/border/);
    expect(() => gradientBox('a', [RED], { padding: -1 })).toThrow(/padding/);
  });
});
