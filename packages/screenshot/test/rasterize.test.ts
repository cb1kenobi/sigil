import { BUILTIN_PALETTES } from '../src/colors.js';
import { DEFAULT_FONTS } from '../src/fonts.js';
import { rasterize, type RasterOptions } from '../src/rasterize.js';
import { buildFont, simpleGlyph } from './font-builder.js';
import { frame, golden, pixel, showcase } from './helpers.js';
import { ATTR, CellBuffer, DEFAULT_COLOR, palette, rgb, StyleTable } from '@ttylabs/sigil/canvas';
import { Screen } from '@ttylabs/sigil/testing';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The PNG half, short of the encoding: pixels asserted where the claim is
 * about a pixel, and golden files where it is about the whole picture.
 */

const OPTS: RasterOptions = { env: {} };
const dark = BUILTIN_PALETTES.dark;
const rgbOf = (c: { b: number; g: number; r: number }): [number, number, number, number] => [
  c.r,
  c.g,
  c.b,
  255,
];

/** The cell the default font and size give: 8 by 18. */
const W = 8;
const H = 18;

/** Every pixel of one cell. */
function cellPixels(
  image: ReturnType<typeof rasterize>,
  column: number,
  row: number
): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let y = row * H; y < (row + 1) * H; y++) {
    for (let x = column * W; x < (column + 1) * W; x++) {
      out.push(pixel(image, x, y));
    }
  }
  return out;
}

const key = (p: readonly number[]): string => p.join(',');

describe('the size of the image', () => {
  it('should be the grid in cells, plus the padding on every side', () => {
    const image = rasterize(new CellBuffer(10, 3), OPTS);
    expect([image.width, image.height]).toEqual([10 * W, 3 * H]);
    expect(image.data.length).toBe(image.width * image.height * 4);
    const padded = rasterize(new CellBuffer(10, 3), { ...OPTS, padding: 5 });
    expect([padded.width, padded.height]).toEqual([10 * W + 10, 3 * H + 10]);
  });

  it('should scale everything by the scale, padding included', () => {
    const image = rasterize(new CellBuffer(10, 3), { ...OPTS, padding: 5, scale: 2 });
    // exactly twice the 1x cell, rather than the 2x font's own 16.8 rounded
    expect([image.width, image.height]).toEqual([10 * 16 + 20, 3 * 36 + 20]);
  });

  it('should take a font size and a line height', () => {
    const image = rasterize(new CellBuffer(1, 1), { ...OPTS, fontSize: 20, lineHeight: 1.5 });
    expect([image.width, image.height]).toEqual([12, 30]);
  });

  it.each([
    ['scale', 0],
    ['scale', Number.NaN],
    ['fontSize', -1],
    ['lineHeight', Infinity],
    ['padding', -1],
  ])('should refuse a %s of %s', (name, value) => {
    expect(() => rasterize(new CellBuffer(1, 1), { ...OPTS, [name]: value })).toThrow(TypeError);
  });

  it('should refuse an image too large to hold, from its size alone', () => {
    // a grid whose dimensions are big and whose cells cost nothing to build,
    // and that says so if anything reads one: the refusal is decided before
    // the frame is read. Reading the cells first made this take ten seconds
    // and more on CI to say no
    let read = 0;
    const big = {
      cellAt: () => {
        read++;
        return ' ';
      },
      height: 4000,
      width: 4000,
    };
    // the fonts are read once per process, so they are read first and only the
    // refusal is timed
    rasterize(new CellBuffer(1, 1), OPTS);
    const started = performance.now();
    expect(() => rasterize(big, { ...OPTS, scale: 4 })).toThrow(/too large to draw/);
    expect(read).toBe(0);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('the colours of a cell', () => {
  it('should fill an empty grid and its padding with the default background', () => {
    const image = rasterize(new CellBuffer(2, 1), { ...OPTS, padding: 3 });
    expect(pixel(image, 0, 0)).toEqual(rgbOf(dark.background));
    expect(pixel(image, image.width - 1, image.height - 1)).toEqual(rgbOf(dark.background));
  });

  it('should fill a background colour across the whole cell', () => {
    const shot = frame(2, 1, (p) => p.text(0, 0, ' ', { bg: rgb(10, 20, 30) }));
    const image = rasterize(shot, OPTS);
    expect(new Set(cellPixels(image, 0, 0).map(key))).toEqual(new Set(['10,20,30,255']));
    expect(pixel(image, W, 0)).toEqual(rgbOf(dark.background));
  });

  it('should draw a glyph in its foreground, anti-aliased against the background', () => {
    // large enough that a stroke covers whole pixels
    const shot = frame(1, 1, (p) => p.text(0, 0, '#', { bg: palette(4), fg: palette(3) }));
    const image = rasterize(shot, { ...OPTS, fontSize: 60 });
    const seen = new Set(
      Array.from({ length: image.width * image.height }, (_, i) =>
        key(pixel(image, i % image.width, Math.floor(i / image.width)))
      )
    );
    expect(seen).toContain(key(rgbOf(dark.palette[3])));
    expect(seen).toContain(key(rgbOf(dark.palette[4])));
    // and something in between, which is what the edges are
    expect(seen.size).toBeGreaterThan(2);
  });

  it('should swap the colours of an inverse cell, defaults included', () => {
    const shot = frame(1, 1, (p) => p.text(0, 0, ' ', { attrs: ATTR.inverse }));
    expect(pixel(rasterize(shot, OPTS), 0, 0)).toEqual(rgbOf(dark.foreground));
  });

  it('should draw a hidden cell as its background and nothing else', () => {
    const plain = frame(1, 1, (p) => p.text(0, 0, '#', { bg: palette(1) }));
    const hidden = frame(1, 1, (p) =>
      p.text(0, 0, '#', { attrs: ATTR.hidden | ATTR.underline, bg: palette(1) })
    );
    expect(new Set(cellPixels(rasterize(hidden, OPTS), 0, 0).map(key))).toEqual(
      new Set([key(rgbOf(dark.palette[1]))])
    );
    expect(new Set(cellPixels(rasterize(plain, OPTS), 0, 0).map(key)).size).toBeGreaterThan(1);
  });

  it('should draw dim at half strength', () => {
    const shot = (attrs: number): ReturnType<typeof frame> =>
      frame(1, 1, (p) => p.text(0, 0, '█', { attrs, bg: rgb(0, 0, 0), fg: rgb(200, 200, 200) }));
    expect(pixel(rasterize(shot(0), OPTS), 4, 9)).toEqual([200, 200, 200, 255]);
    expect(pixel(rasterize(shot(ATTR.dim), OPTS), 4, 9)).toEqual([100, 100, 100, 255]);
  });

  it('should ignore blink, which a still image cannot show', () => {
    // there is no blink bit in a cell style to begin with, so the claim is that
    // every bit the style has is one this draws -- and the overline is the one
    // nothing else exercises
    const shot = frame(1, 1, (p) => p.text(0, 0, ' ', { attrs: ATTR.overline }));
    expect(pixel(rasterize(shot, OPTS), 3, 0)).toEqual(rgbOf(dark.foreground));
  });
});

describe('lines under, through and over', () => {
  /** The rows of a cell's centre column that are not the background. */
  const inkedRows = (attrs: number): number[] => {
    const shot = frame(1, 1, (p) => p.text(0, 0, ' ', { attrs }));
    const image = rasterize(shot, OPTS);
    const rows: number[] = [];
    for (let y = 0; y < H; y++) {
      if (key(pixel(image, 4, y)) !== key(rgbOf(dark.background))) {
        rows.push(y);
      }
    }
    return rows;
  };

  it('should put an underline below the baseline and a strike above it', () => {
    const under = inkedRows(ATTR.underline);
    const strike = inkedRows(ATTR.strikethrough);
    const over = inkedRows(ATTR.overline);
    expect(under.length).toBeGreaterThan(0);
    expect(strike.length).toBeGreaterThan(0);
    expect(over).toEqual([0]);
    expect(Math.min(...under)).toBeGreaterThan(Math.max(...strike));
    expect(Math.max(...under)).toBeLessThan(H);
  });

  it('should run a line under both halves of a wide character', () => {
    const shot = frame(2, 1, (p) => p.text(0, 0, '漢', { attrs: ATTR.underline }));
    const image = rasterize(shot, OPTS);
    const under = inkedRows(ATTR.underline)[0];
    expect(pixel(image, 2 * W - 1, under)).toEqual(rgbOf(dark.foreground));
  });
});

describe('what is drawn in a cell', () => {
  it('should draw a box for a character no font has, across both cells of a wide one', () => {
    const narrow = rasterize(
      frame(1, 1, (p) => p.text(0, 0, '͸')),
      OPTS
    );
    const wide = rasterize(
      frame(2, 1, (p) => p.text(0, 0, '漢')),
      OPTS
    );
    // the box's right edge is in the second cell
    const ink = (image: ReturnType<typeof rasterize>, x: number): boolean =>
      Array.from({ length: H }, (_, y) => key(pixel(image, x, y))).some(
        (k) => k !== key(rgbOf(dark.background))
      );
    expect(ink(narrow, 1)).toBe(true);
    expect(ink(narrow, W - 1)).toBe(false);
    // the right-hand side of the box, in the second cell
    expect(ink(wide, 2 * W - 3)).toBe(true);
    // and its top runs straight across the boundary between the two
    expect(ink(wide, W)).toBe(true);
  });

  it('should look in a fallback font for what the faces lack', () => {
    // the bundled regular as a fallback for a font set that is only the bold:
    // nothing is missing from either, so a fallback is proved by a font that
    // lacks `A` -- which the regular stands in for by mapping to it
    const regular = readFileSync(DEFAULT_FONTS.regular);
    const shot = frame(1, 1, (p) => p.text(0, 0, '͸'));
    const withFallback = rasterize(shot, { ...OPTS, font: { fallback: [regular], regular } });
    const without = rasterize(shot, { ...OPTS, font: regular });
    // neither has U+0378, so both draw the box: the same picture
    expect(withFallback.data).toEqual(without.data);
  });

  it('should synthesize bold and italic for a font given as one face', () => {
    const regular = readFileSync(DEFAULT_FONTS.regular);
    const draw = (attrs: number): Uint8Array =>
      rasterize(
        frame(1, 1, (p) => p.text(0, 0, 'l', { attrs })),
        { ...OPTS, font: regular }
      ).data;
    const ink = (data: Uint8Array): number => {
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += data[i];
      }
      return sum;
    };
    expect(ink(draw(ATTR.bold))).toBeGreaterThan(ink(draw(0)));
    expect(draw(ATTR.italic)).not.toEqual(draw(0));
  });

  it('should draw the bundled bold face, not a synthesized one, by default', () => {
    const bundled = rasterize(
      frame(1, 1, (p) => p.text(0, 0, 'a', { attrs: ATTR.bold })),
      OPTS
    );
    const synthesized = rasterize(
      frame(1, 1, (p) => p.text(0, 0, 'a', { attrs: ATTR.bold })),
      { ...OPTS, font: readFileSync(DEFAULT_FONTS.regular) }
    );
    expect(bundled.data).not.toEqual(synthesized.data);
  });

  it('should drop a variation selector rather than drawing it', () => {
    const plain = rasterize(
      frame(1, 1, (p) => p.text(0, 0, '#')),
      OPTS
    );
    const selected = rasterize(
      frame(1, 1, (p) => p.text(0, 0, '#︎')),
      OPTS
    );
    expect(selected.data).toEqual(plain.data);
  });

  it('should draw a combining mark over its base', () => {
    const plain = rasterize(
      frame(1, 1, (p) => p.text(0, 0, 'e')),
      OPTS
    );
    const marked = rasterize(
      frame(1, 1, (p) => p.text(0, 0, 'é')),
      OPTS
    );
    expect(marked.data).not.toEqual(plain.data);
  });

  it.each([
    ['e', 3],
    ['ｅ', 4],
    ['✔', 3],
  ])('should put a combining mark over %s, not beside it', (base, width) => {
    // review round 1: a mark was centred on its own zero advance, which puts a
    // font's mark -- drawn to the left of its origin, over the glyph before it
    // -- half a cell left of its base. Reachable for a fullwidth form and a
    // symbol once those stopped being boxes. The mark's ink is what the second
    // image has and the first does not, and it has to sit over the base's
    const draw = (text: string): ReturnType<typeof rasterize> =>
      rasterize(
        frame(width, 1, (p) => p.text(1, 0, text)),
        OPTS
      );
    const plain = draw(base);
    const marked = draw(`${base}́`);
    const bg = key(rgbOf(dark.background));
    const columns = (image: ReturnType<typeof rasterize>, only?: typeof plain): number[] => {
      const out: number[] = [];
      for (let x = 0; x < image.width; x++) {
        for (let y = 0; y < H; y++) {
          const here = key(pixel(image, x, y));
          if (here !== bg && (!only || here !== key(pixel(only, x, y)))) {
            out.push(x);
            break;
          }
        }
      }
      return out;
    };
    const ink = columns(plain);
    const mark = columns(marked, plain);
    expect(mark.length).toBeGreaterThan(0);
    expect(Math.min(...mark)).toBeGreaterThanOrEqual(Math.min(...ink));
    expect(Math.max(...mark)).toBeLessThanOrEqual(Math.max(...ink));
  });
});

describe('the bundled symbol font', () => {
  /** The first and last columns holding anything but the background. */
  const inked = (image: ReturnType<typeof rasterize>): [number, number] => {
    const bg = key(rgbOf(dark.background));
    let first = Infinity;
    let last = -Infinity;
    for (let x = 0; x < image.width; x++) {
      for (let y = 0; y < image.height; y++) {
        if (key(pixel(image, x, y)) !== bg) {
          first = Math.min(first, x);
          last = Math.max(last, x);
        }
      }
    }
    return [first, last];
  };
  const one = (char: string, attrs = 0): ReturnType<typeof rasterize> =>
    rasterize(
      frame(3, 1, (p) => p.text(1, 0, char, { attrs })),
      OPTS
    );
  const tofu = one('͸');

  it.each([...'✔✖ℹ☐☒◐◴✸⊶ⁿ⌠'])('should draw %s rather than a box', (char) => {
    expect(one(char).data).not.toEqual(tofu.data);
    expect(one(char, ATTR.bold | ATTR.italic).data).not.toEqual(tofu.data);
  });

  it.each([...'✔✖☐☒◐✸⊶'])('should centre %s in its cell, whatever its advance', (char) => {
    // DejaVu Sans is proportional, and these are wider than the cell: the
    // advance is centred, and their bearings are even, so the ink is too --
    // overhanging both neighbours alike, as a terminal's fallback does
    const [first, last] = inked(one(char));
    expect(Math.abs(first - W - (2 * W - 1 - last))).toBeLessThanOrEqual(1);
  });

  it("should draw a fallback at its own em rather than the regular face's", () => {
    // the bug this found: a fallback was scaled by the regular face's units per
    // em, so DejaVu's 2048 read at JetBrains Mono's 1000 drew every symbol at
    // twice its size. The same square at two ems is the same picture
    const square = (em: number): Uint8Array =>
      buildFont(
        [
          simpleGlyph([
            [em / 10, 0],
            [em / 2, 0],
            [em / 2, (em * 6) / 10],
            [em / 10, (em * 6) / 10],
          ]),
        ],
        { 0x27_14: 1 },
        em
      );
    const regular = readFileSync(DEFAULT_FONTS.regular);
    const shot = frame(3, 1, (p) => p.text(1, 0, '✔'));
    const at = (em: number): Uint8Array =>
      rasterize(shot, { ...OPTS, font: { fallback: [square(em)], regular } }).data;
    expect(at(2000)).toEqual(at(1000));
  });

  it('should look in a fallback that was given before the bundled one', () => {
    const square = buildFont(
      [
        simpleGlyph([
          [0, -300],
          [600, -300],
          [600, 900],
          [0, 900],
        ]),
      ],
      { 0x27_14: 1 }
    );
    const regular = readFileSync(DEFAULT_FONTS.regular);
    const shot = frame(1, 1, (p) => p.text(0, 0, '✔'));
    const given = rasterize(shot, { ...OPTS, font: { fallback: [square], regular } });
    // a solid block where DejaVu's tick has its open corner
    expect(pixel(given, 1, 4)).toEqual(rgbOf(dark.foreground));
    expect(given.data).not.toEqual(rasterize(shot, OPTS).data);
  });

  it('should be looked in behind a font set that names none of the bundled faces', () => {
    const regular = readFileSync(DEFAULT_FONTS.regular);
    const shot = frame(1, 1, (p) => p.text(0, 0, '✔'));
    expect(rasterize(shot, { ...OPTS, font: regular }).data).toEqual(rasterize(shot, OPTS).data);
  });
});

describe('fullwidth ASCII', () => {
  it('should draw a fullwidth form as its ASCII glyph, centred across both cells', () => {
    // the advance is centred in sixteen pixels rather than eight, which is four
    // whole pixels along: the same subpixel phase, so the very same pixels
    for (const [wide, narrow] of [
      ['Ａ', 'A'],
      ['０', '0'],
      ['！', '!'],
      ['～', '~'],
    ]) {
      const full = rasterize(
        frame(2, 1, (p) => p.text(0, 0, wide)),
        OPTS
      );
      const ascii = rasterize(
        frame(2, 1, (p) => p.text(0, 0, narrow)),
        OPTS
      );
      const bg = rgbOf(dark.background);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < 2 * W; x++) {
          expect(pixel(full, x, y), `${wide} at ${x},${y}`).toEqual(
            x < 4 ? bg : pixel(ascii, x - 4, y)
          );
        }
      }
    }
  });

  it('should keep the style of the cell', () => {
    const draw = (attrs: number): Uint8Array =>
      rasterize(
        frame(2, 1, (p) => p.text(0, 0, 'Ａ', { attrs })),
        OPTS
      ).data;
    expect(draw(ATTR.bold)).not.toEqual(draw(0));
    expect(draw(ATTR.italic)).not.toEqual(draw(0));
  });

  it('should draw a real fullwidth glyph where a font has one', () => {
    const square = buildFont(
      [
        simpleGlyph([
          [0, 0],
          [1000, 0],
          [1000, 700],
          [0, 700],
        ]),
      ],
      { 0xff_21: 1 }
    );
    const regular = readFileSync(DEFAULT_FONTS.regular);
    const shot = frame(2, 1, (p) => p.text(0, 0, 'Ａ'));
    const given = rasterize(shot, { ...OPTS, font: { fallback: [square], regular } });
    expect(given.data).not.toEqual(rasterize(shot, OPTS).data);
    // the square spans the middle of both cells, where an `A` has its counter
    expect(pixel(given, W, 10)).toEqual(rgbOf(dark.foreground));
  });

  it('should leave the rest of the fullwidth block to the fonts', () => {
    // U+FF5F, a fullwidth white parenthesis, is past the ASCII forms: no font
    // here has it, and it is not the wide spelling of anything to borrow
    const past = rasterize(
      frame(2, 1, (p) => p.text(0, 0, '｟')),
      OPTS
    );
    const box = rasterize(
      frame(2, 1, (p) => p.text(0, 0, '漢')),
      OPTS
    );
    expect(past.data).toEqual(box.data);
  });
});

describe('what it reads', () => {
  it('should refuse a grid that cannot say what its styles are', () => {
    const table = new StyleTable();
    const loose = new CellBuffer(1, 1);
    loose.put(0, 0, 'x', table.intern({ fg: palette(1) }));
    expect(() => rasterize(loose, OPTS)).toThrow(/cannot say what its styles are/);
    // and takes the table it was painted with when it is handed one
    expect(() => rasterize(loose, { ...OPTS, styles: table })).not.toThrow();
  });

  it('should draw a grid holding only the default style without a table', () => {
    const loose = new CellBuffer(1, 1);
    loose.put(0, 0, 'x', StyleTable.DEFAULT);
    expect(() => rasterize(loose, OPTS)).not.toThrow();
  });

  it('should draw a testing Screen in the default colours', () => {
    const screen = new Screen(5, 2);
    screen.write('hi 漢\r\n─');
    expect(screen.cellAt(4, 0)).toBe('');
    const fromScreen = rasterize(screen, OPTS);
    const fromCanvas = rasterize(
      frame(5, 2, (p) => {
        p.text(0, 0, 'hi 漢', { bg: DEFAULT_COLOR });
        p.text(0, 1, '─');
      }),
      OPTS
    );
    expect(fromScreen.data).toEqual(fromCanvas.data);
  });

  it('should refuse something that is not a grid', () => {
    expect(() => rasterize({} as CellBuffer, OPTS)).toThrow(TypeError);
    expect(() => rasterize(null as unknown as CellBuffer, OPTS)).toThrow(TypeError);
  });
});

describe('determinism', () => {
  it('should draw the same frame to the same bytes every time', () => {
    const a = rasterize(showcase(), { ...OPTS, padding: 6 });
    const b = rasterize(showcase(), { ...OPTS, padding: 6 });
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });

  it('should match the golden showcase at 1x', () => {
    golden('showcase.png', rasterize(showcase(), { ...OPTS, padding: 8 }));
  });

  it('should match the golden showcase at 2x, light', () => {
    golden(
      'showcase-light@2x.png',
      rasterize(showcase(), { ...OPTS, colorScheme: 'light', padding: 8, scale: 2 })
    );
  });
});

describe('what review round 1 found', () => {
  it('should cut a glyph that runs off the 16-bit plane to what the image can show', () => {
    // 16 units per em at 14px is nearly a pixel a unit, so a glyph spanning the
    // int16 range asked for an accumulator 28,000 pixels on a side -- 6 GB --
    // for one cell
    const huge = simpleGlyph([
      [-16_000, -16_000],
      [16_000, -16_000],
      [16_000, 16_000],
      [-16_000, 16_000],
    ]);
    const font = buildFont([huge], { 0x41: 1 }, 16);
    const started = Date.now();
    const image = rasterize(
      frame(1, 1, (p) => p.text(0, 0, 'A', { fg: rgb(255, 0, 0) })),
      { ...OPTS, font }
    );
    expect(Date.now() - started).toBeLessThan(2000);
    // the glyph covers the whole cell, and nothing outside the image was asked for
    expect(pixel(image, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('should synthesize a fallback from what the cell asked for, not which slot a font is in', () => {
    // one file as both the regular and the bold loads as one font, so asking
    // whether the face picked *is* the bold called a regular character bold
    const fallback = buildFont(
      [
        simpleGlyph([
          [100, 0],
          [500, 0],
          [500, 600],
          [100, 600],
        ]),
      ],
      { 0x4e_00: 1 }
    );
    const regular = readFileSync(DEFAULT_FONTS.regular);
    const shot = frame(2, 1, (p) => p.text(0, 0, '一'));
    const shared = rasterize(shot, {
      ...OPTS,
      font: { bold: regular, fallback: [fallback], regular },
    });
    const apart = rasterize(shot, { ...OPTS, font: { fallback: [fallback], regular } });
    expect(shared.data).toEqual(apart.data);
    // and a bold cell still is
    const bold = frame(2, 1, (p) => p.text(0, 0, '一', { attrs: ATTR.bold }));
    expect(rasterize(bold, { ...OPTS, font: { fallback: [fallback], regular } }).data).not.toEqual(
      apart.data
    );
  });

  it('should refuse a grid too large to read before reading it', () => {
    const screen = { cellAt: () => ' ', height: 1e7, width: 1e7 };
    expect(() => rasterize(screen, OPTS)).toThrow(RangeError);
    // review round 2: a width of 0 made the product 0, and the rows were walked
    expect(() => rasterize({ cellAt: () => ' ', height: 1e12, width: 0 }, OPTS)).toThrow(
      RangeError
    );
  });
});
