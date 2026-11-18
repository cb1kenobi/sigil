import {
  CellBuffer,
  DEFAULT_COLOR,
  Dots,
  palette,
  Painter,
  Pixels,
  rgb,
  StyleTable,
} from '../../src/canvas/index.js';
import { seeded } from '../../src/util/random.js';
import { describe, expect, it } from 'vitest';

/** A painter over a fresh buffer, and the table to read its styles back from. */
function surface(width: number, height: number) {
  const styles = new StyleTable();
  const buffer = new CellBuffer(width, height);
  return { buffer, painter: new Painter(buffer, styles), styles };
}

describe('Dots', () => {
  it('should map every dot position to its own bit', () => {
    // braille was six dots read down the left column then down the right, and
    // the eighth row was appended later -- so the bottom row is bits 3 and 7
    // rather than the next two in sequence. Deriving this gets it subtly wrong
    const expected: [number, number, string][] = [
      [0, 0, '⠁'],
      [1, 0, '⠈'],
      [0, 1, '⠂'],
      [1, 1, '⠐'],
      [0, 2, '⠄'],
      [1, 2, '⠠'],
      [0, 3, '⡀'],
      [1, 3, '⢀'],
    ];

    for (const [x, y, char] of expected) {
      const dots = new Dots(1, 1);
      dots.set(x, y);
      expect(dots.charAt(0, 0), `dot ${x},${y}`).toBe(char);
    }
  });

  it('should fill the cell when every dot is set', () => {
    const dots = new Dots(1, 1);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 2; x++) {
        dots.set(x, y);
      }
    }
    expect(dots.charAt(0, 0)).toBe('⣿');
  });

  it('should report an empty cell as nothing rather than as a blank braille', () => {
    // U+2800 is a real character that some fonts draw the dot frame for, and
    // painting it would also overwrite whatever the plot is sitting on
    expect(new Dots(2, 2).charAt(0, 0)).toBeUndefined();
  });

  it('should size itself in cells and report dots', () => {
    const dots = new Dots(10, 3);
    expect([dots.width, dots.height]).toEqual([10, 3]);
    expect([dots.dotWidth, dots.dotHeight]).toEqual([20, 12]);
  });

  it('should ignore a dot outside the grid rather than throwing', () => {
    // a plot clips at its box, and making every caller bounds-check each point
    // is how the check ends up in the wrong place
    const dots = new Dots(1, 1);
    expect(() => {
      dots.set(-1, 0);
      dots.set(0, -1);
      dots.set(2, 0);
      dots.set(0, 4);
    }).not.toThrow();
    expect(dots.charAt(0, 0)).toBeUndefined();
    expect(dots.get(99, 99)).toBe(false);
  });

  it('should clear a dot without disturbing its neighbours', () => {
    const dots = new Dots(1, 1);
    dots.set(0, 0);
    dots.set(1, 3);
    dots.unset(0, 0);
    expect(dots.get(0, 0)).toBe(false);
    expect(dots.get(1, 3)).toBe(true);
    expect(dots.charAt(0, 0)).toBe('⢀');
  });

  it('should draw a horizontal line across cells', () => {
    const dots = new Dots(3, 1);
    dots.line(0, 0, 5, 0);
    for (let x = 0; x < 6; x++) {
      expect(dots.get(x, 0), `dot ${x}`).toBe(true);
    }
    expect(dots.get(0, 1)).toBe(false);
  });

  it('should draw a diagonal that advances on both axes', () => {
    const dots = new Dots(2, 1);
    dots.line(0, 0, 3, 3);
    expect([dots.get(0, 0), dots.get(1, 1), dots.get(2, 2), dots.get(3, 3)]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('should draw a line the same way in both directions', () => {
    const forward = new Dots(4, 2);
    const backward = new Dots(4, 2);
    forward.line(1, 1, 6, 5);
    backward.line(6, 5, 1, 1);
    expect(forward.charAt(0, 0)).toBe(backward.charAt(0, 0));
    expect(forward.charAt(1, 1)).toBe(backward.charAt(1, 1));
  });

  // a plot with a missing sample is the ordinary caller of this. The loop ends
  // by arriving at the end point, `NaN === NaN` is false, and a step towards an
  // infinity never arrives -- so it ran forever, painting nothing, because
  // `set()` ignores what it cannot place
  it('should return rather than spin on an endpoint that is not a number', () => {
    const dots = new Dots(2, 2);
    expect(() => {
      dots.line(Number.NaN, 0, 1, 1);
      dots.line(0, 0, 1, Number.NaN);
      dots.line(0, 0, Number.POSITIVE_INFINITY, 1);
      dots.line(Number.NEGATIVE_INFINITY, 0, 1, 1);
    }).not.toThrow();
    expect(dots.charAt(0, 0)).toBeUndefined();
  });

  // the same hang with a finite endpoint: `1e308 - 1` is `1e308`, so the step
  // runs and the position does not change. Past 2^53 adding one is a no-op,
  // which is what the guard asks about rather than asking about infinity
  it('should return rather than spin on an endpoint it cannot step towards', () => {
    const dots = new Dots(2, 2);
    expect(() => {
      dots.line(1e308, 0, 0, 0);
      dots.line(0, 0, 2 ** 53, 0);
      dots.line(-(2 ** 53), 0, 0, 0);
    }).not.toThrow();
    expect(dots.charAt(0, 0)).toBeUndefined();
  });

  it('should answer undefined for a cell that is not a number rather than throwing', () => {
    // every comparison is false for `NaN`, so `charAt` indexed `#cells[NaN]`
    // and `String.fromCodePoint(NaN)` threw out of the method that answers
    // `undefined` for everything it cannot find
    const dots = new Dots(2, 2);
    dots.set(0, 0);
    expect(dots.charAt(Number.NaN, 0)).toBeUndefined();
    expect(dots.charAt(0, Number.NaN)).toBeUndefined();
    expect(dots.charAt(Number.POSITIVE_INFINITY, 0)).toBeUndefined();
    // a fraction is the same arithmetic and is truncated, as everywhere else
    expect(dots.charAt(0.5, 0)).toBe(dots.charAt(0, 0));
  });

  it('should ignore a dot that is not a number rather than throwing', () => {
    // every comparison is false for `NaN`, so the bounds test let it through
    // and the row of the bit table read back `undefined`
    const dots = new Dots(1, 1);
    expect(() => {
      dots.set(Number.NaN, 0);
      dots.set(0, Number.NaN);
      dots.unset(0, Number.POSITIVE_INFINITY);
    }).not.toThrow();
    expect(dots.get(0, Number.NaN)).toBe(false);
    expect(dots.charAt(0, 0)).toBeUndefined();
  });

  it('should paint only the cells that have dots', () => {
    // the gap has to be left as it was, which is what lets a plot sit on a
    // background someone else drew
    const { buffer, painter } = surface(4, 1);
    buffer.write(0, 0, '....', StyleTable.DEFAULT);

    const dots = new Dots(4, 1);
    dots.set(0, 0);
    dots.set(6, 0);
    dots.blit(painter, 0, 0);

    expect(buffer.toString()).toBe('⠁..⠁');
  });

  it('should paint at the offset it was given', () => {
    const { buffer, painter } = surface(6, 3);
    const dots = new Dots(1, 1);
    dots.set(0, 0);
    dots.blit(painter, 3, 2);
    expect(buffer.charAt(3, 2)).toBe('⠁');
    expect(buffer.charAt(0, 0)).toBe(' ');
  });

  it('should paint the dots in the style it was given', () => {
    const { buffer, painter, styles } = surface(2, 1);
    const dots = new Dots(2, 1);
    dots.set(0, 0);
    dots.blit(painter, 0, 0, { fg: palette(6) });
    expect(styles.get(buffer.styleAt(0, 0)).fg).toBe(palette(6));
  });
});

describe('Pixels', () => {
  // `text()` interns the style it is handed whether or not anything lands, so a
  // picture taller than its grid made a style per cell nobody could see -- a new
  // set every frame once a sweep had dropped the last, and a sweep every frame
  it('should intern no style for a cell off the grid or outside the clip', () => {
    const pixels = new Pixels(4, 4);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 4; x++) {
        pixels.set(x, y, palette(16 + y * 4 + x));
      }
    }

    const below = surface(4, 2);
    pixels.blit(below.painter, 0, 0);
    // two rows of four cells, each its own pair of colours, and the default
    expect(below.styles.size).toBe(1 + 8);

    const clipped = surface(4, 4);
    clipped.painter.clip({ height: 1, width: 2, x: 0, y: 0 }, (painter) => {
      pixels.blit(painter, 0, 0);
    });
    expect(clipped.styles.size).toBe(1 + 2);
  });

  it('should size itself in cells and report pixel rows', () => {
    const pixels = new Pixels(8, 3);
    expect([pixels.width, pixels.height, pixels.pixelHeight]).toEqual([8, 3, 6]);
  });

  it('should paint two differently coloured halves as one upper block', () => {
    const { buffer, painter, styles } = surface(1, 1);
    const pixels = new Pixels(1, 1);
    pixels.set(0, 0, palette(1));
    pixels.set(0, 1, palette(4));
    pixels.blit(painter, 0, 0);

    expect(buffer.charAt(0, 0)).toBe('▀');
    const style = styles.get(buffer.styleAt(0, 0));
    expect([style.fg, style.bg]).toEqual([palette(1), palette(4)]);
  });

  it('should paint a solid cell as a full block in one colour', () => {
    // `█` in one colour survives a terminal that renders the half blocks a
    // pixel short, which several do at small font sizes
    const { buffer, painter, styles } = surface(1, 1);
    const pixels = new Pixels(1, 1);
    pixels.set(0, 0, palette(2));
    pixels.set(0, 1, palette(2));
    pixels.blit(painter, 0, 0);

    expect(buffer.charAt(0, 0)).toBe('█');
    expect(styles.get(buffer.styleAt(0, 0)).fg).toBe(palette(2));
  });

  it('should paint a lone bottom pixel as a lower block', () => {
    const { buffer, painter, styles } = surface(1, 1);
    const pixels = new Pixels(1, 1);
    pixels.set(0, 1, palette(3));
    pixels.blit(painter, 0, 0);

    expect(buffer.charAt(0, 0)).toBe('▄');
    const style = styles.get(buffer.styleAt(0, 0));
    expect([style.fg, style.bg]).toEqual([palette(3), DEFAULT_COLOR]);
  });

  it('should leave an uncoloured cell alone', () => {
    const { buffer, painter } = surface(2, 1);
    buffer.write(0, 0, 'ab', StyleTable.DEFAULT);
    const pixels = new Pixels(2, 1);
    pixels.set(1, 0, palette(5));
    pixels.blit(painter, 0, 0);

    expect(buffer.charAt(0, 0)).toBe('a');
    expect(buffer.charAt(1, 0)).toBe('▀');
  });

  it('should ignore a pixel outside the grid', () => {
    const pixels = new Pixels(1, 1);
    expect(() => {
      pixels.set(-1, 0, palette(1));
      pixels.set(0, 2, palette(1));
      pixels.set(1, 0, palette(1));
    }).not.toThrow();
    expect(pixels.get(0, 0)).toBe(DEFAULT_COLOR);
    expect(pixels.get(99, 99)).toBe(DEFAULT_COLOR);
  });

  it('should ignore a pixel that is not a number', () => {
    // it did not throw the way `Dots` did; it wrote to index `NaN`, which a
    // typed array drops, and handed back `undefined` with `Color` written on it
    const pixels = new Pixels(1, 1);
    expect(() => pixels.set(Number.NaN, 0, palette(1))).not.toThrow();
    expect(pixels.get(Number.NaN, 0)).toBe(DEFAULT_COLOR);
    expect(pixels.get(0, Number.POSITIVE_INFINITY)).toBe(DEFAULT_COLOR);
  });

  it('should clear back to the terminal colour', () => {
    const pixels = new Pixels(2, 1);
    pixels.set(0, 0, palette(1));
    pixels.clear();
    expect(pixels.get(0, 0)).toBe(DEFAULT_COLOR);
  });
});

/**
 * A picture with every case a cell can be in: solid, two colours, only the top
 * or only the bottom drawn, and nothing drawn -- a texture of tiles in two
 * shades with an edge of the terminal's own colour between them, the shape a
 * treemap is.
 */
function picture(width: number, height: number, random = seeded(476)): Pixels {
  const pixels = new Pixels(width, height);
  for (let y = 0; y < pixels.pixelHeight; y++) {
    for (let x = 0; x < width; x++) {
      const roll = random();
      if (roll < 0.25) {
        continue;
      }
      pixels.set(x, y, roll < 0.5 ? palette(1 + (x % 6)) : rgb(x * 7, y * 11, 200));
    }
  }
  return pixels;
}

/**
 * Which pixels a painted grid shows, read off the glyph and its style: the shape
 * the picture has on screen, whatever colours it was drawn in.
 */
function shapeOf(buffer: CellBuffer, styles: StyleTable): string[] {
  const rows: string[] = [];
  for (let y = 0; y < buffer.height; y++) {
    let top = '';
    let bottom = '';
    for (let x = 0; x < buffer.width; x++) {
      const char = buffer.charAt(x, y);
      const { bg } = styles.get(buffer.styleAt(x, y));
      // an upper block over a background of its own is two pixels, which is how
      // a cell in two colours is drawn
      const upper = char === '█' || char === '▀';
      const lower = char === '█' || char === '▄' || (char === '▀' && bg !== DEFAULT_COLOR);
      top += upper ? '#' : '.';
      bottom += lower ? '#' : '.';
    }
    rows.push(top, bottom);
  }
  return rows;
}

describe('Pixels at colour level 0', () => {
  it('should draw the same shape at level 0 as at level 3', () => {
    const pixels = picture(24, 6);
    const lit = surface(24, 6);
    pixels.blit(lit.painter, 0, 0, { colorLevel: 3 });
    const plain = surface(24, 6);
    pixels.blit(plain.painter, 0, 0, { colorLevel: 0 });

    const shape = shapeOf(lit.buffer, lit.styles);
    expect(shapeOf(plain.buffer, plain.styles)).toEqual(shape);
    // and it is the picture's: a pixel is on wherever a colour was set
    const expected = Array.from({ length: pixels.pixelHeight }, (_, y) =>
      Array.from({ length: 24 }, (_, x) => (pixels.get(x, y) === DEFAULT_COLOR ? '.' : '#')).join(
        ''
      )
    );
    expect(shape).toEqual(expected);
    // the picture has every kind of cell at both levels, so the comparison
    // covers them all
    for (const { buffer } of [lit, plain]) {
      expect([...new Set(buffer.toLines().join(''))].sort()).toEqual([' ', '▀', '▄', '█'].sort());
    }
    // and the two are drawn differently: a cell in two colours is an upper block
    // over a background at level 3, and a full block at level 0
    const twoColour = lit.buffer
      .toLines()
      .flatMap((line, y) => [...line].map((char, x) => ({ char, x, y })))
      .filter(
        ({ char, x, y }) =>
          char === '▀' && lit.styles.get(lit.buffer.styleAt(x, y)).bg !== DEFAULT_COLOR
      );
    expect(twoColour.length).toBeGreaterThan(0);
    for (const { x, y } of twoColour) {
      expect(plain.buffer.charAt(x, y)).toBe('█');
    }
  });

  // a colour at level 0 is an escape sequence `NO_COLOR` and a pipe asked not
  // to get, and the canvas emits whatever it is handed
  it('should write no colour at level 0', () => {
    const pixels = picture(16, 4);
    const { buffer, painter, styles } = surface(16, 4);
    pixels.blit(painter, 0, 0, { colorLevel: 0 });

    expect(styles.size).toBe(1);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 16; x++) {
        expect(buffer.styleAt(x, y)).toBe(StyleTable.DEFAULT);
      }
    }
    expect(buffer.toLines().join('')).toMatch(/[▀▄█]/);
  });

  it('should draw a two-colour cell as a full block, since both halves are on', () => {
    const { buffer, painter } = surface(1, 1);
    const pixels = new Pixels(1, 1);
    pixels.set(0, 0, palette(1));
    pixels.set(0, 1, palette(4));
    pixels.blit(painter, 0, 0, { colorLevel: 0 });
    expect(buffer.charAt(0, 0)).toBe('█');
  });

  it('should leave a cell with neither half on alone at level 0', () => {
    const { buffer, painter } = surface(3, 1);
    buffer.write(0, 0, 'abc', StyleTable.DEFAULT);
    const pixels = new Pixels(3, 1);
    pixels.set(0, 0, palette(2));
    pixels.set(2, 1, palette(2));
    pixels.blit(painter, 0, 0, { colorLevel: 0 });
    expect(buffer.toLines()).toEqual(['▀b▄']);
  });

  it('should draw shapes below 0, and colours for a level that is not a number', () => {
    const pixels = new Pixels(1, 1);
    pixels.set(0, 0, palette(1));
    pixels.set(0, 1, palette(4));
    const below = surface(1, 1);
    pixels.blit(below.painter, 0, 0, { colorLevel: -1 });
    expect(below.buffer.charAt(0, 0)).toBe('█');
    // `NaN <= 0` is false, so it is the colour path that was always there
    const nan = surface(1, 1);
    pixels.blit(nan.painter, 0, 0, { colorLevel: Number.NaN });
    expect(nan.buffer.charAt(0, 0)).toBe('▀');
  });

  // a shape is a glyph `text()` writes, and a glyph keeps the background under it
  // -- the canvas rule for every glyph, so it is not a colour level 0 added
  it('should keep the background under a shape, as any glyph does', () => {
    const { buffer, painter, styles } = surface(2, 1);
    painter.fill(0, 0, 2, 1, { bg: palette(4) });
    const pixels = new Pixels(2, 1);
    pixels.set(0, 0, palette(1));
    pixels.set(0, 1, palette(1));
    pixels.blit(painter, 0, 0, { colorLevel: 0 });
    expect(buffer.charAt(0, 0)).toBe('█');
    expect(styles.get(buffer.styleAt(0, 0))).toMatchObject({ bg: palette(4), fg: DEFAULT_COLOR });
  });

  it('should paint a run with a gap that starts left of the grid and the clip', () => {
    const pixels = new Pixels(6, 1);
    for (const x of [0, 1, 2, 4, 5]) {
      pixels.set(x, 0, palette(2));
    }
    const off = surface(6, 1);
    pixels.blit(off.painter, -1, 0, { colorLevel: 0 });
    expect(off.buffer.toLines()).toEqual(['▀▀ ▀▀ ']);

    const { buffer, painter } = surface(6, 1);
    painter.clip({ height: 1, width: 4, x: 2, y: 0 }, (inner) => {
      pixels.blit(inner, 0, 0, { colorLevel: 0 });
    });
    expect(buffer.toLines()).toEqual(['  ▀ ▀▀']);
  });

  it('should paint at the offset it was given and stay inside the clip', () => {
    const pixels = new Pixels(4, 1);
    for (let x = 0; x < 4; x++) {
      pixels.set(x, 0, palette(3));
      pixels.set(x, 1, palette(3));
    }
    const { buffer, painter } = surface(6, 2);
    painter.clip({ height: 1, width: 3, x: 2, y: 1 }, (inner) => {
      pixels.blit(inner, 1, 1, { colorLevel: 0 });
    });
    // the picture is columns 1 to 4 and the clip 2 to 4
    expect(buffer.toLines()).toEqual(['      ', '  ███ ']);
  });

  // the ticket's other half: levels 1 to 3 are what they were. Painted with no
  // option, which is the code this option did not touch, and with `{}` and each
  // level named, over pictures that run off the grid and through a clip. What
  // the colour path itself draws is pinned by the cases in `Pixels` above; this
  // says the option does not reach it
  it('should paint exactly what it painted before at levels 1 to 3', () => {
    const random = seeded(3);
    for (let round = 0; round < 20; round++) {
      const width = 1 + Math.floor(random() * 12);
      const height = 1 + Math.floor(random() * 5);
      const pixels = picture(width, height, random);
      const at = Math.floor(random() * 4) - 2;
      const clip = { height: 3, width: 6, x: 1, y: 1 };

      const before = surface(10, 4);
      before.painter.clip(clip, (inner) => pixels.blit(inner, at, at));
      for (const opts of [{}, { colorLevel: 1 }, { colorLevel: 2 }, { colorLevel: 3 }]) {
        const after = surface(10, 4);
        after.painter.clip(clip, (inner) => pixels.blit(inner, at, at, opts));
        expect(after.styles.size, `round ${round} ${JSON.stringify(opts)}`).toBe(
          before.styles.size
        );
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 10; x++) {
            expect(after.buffer.charAt(x, y)).toBe(before.buffer.charAt(x, y));
            expect(after.styles.get(after.buffer.styleAt(x, y))).toEqual(
              before.styles.get(before.buffer.styleAt(x, y))
            );
          }
        }
      }
    }
  });
});
