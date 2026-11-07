import {
  CellBuffer,
  createCanvas,
  DEFAULT_COLOR,
  Painter,
  palette,
  rgb,
  type Style,
  StyleTable,
} from '../../src/canvas/index.js';
import { image, imageView } from '../../src/components/image.js';
import { arrange, box, type Element, paint, resolveStyles } from '../../src/element/index.js';
import { decodePng, encodePng, type RgbaImage } from '../../src/png/index.js';
import { Cascade, Restyler } from '../../src/style/index.js';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Rgba = readonly [number, number, number, number];

/** A picture from a function of its pixel coordinates. */
function picture(width: number, height: number, at: (x: number, y: number) => Rgba): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(at(x, y), (y * width + x) * 4);
    }
  }
  return { data, height, width };
}

const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];

/**
 * Resolves, lays out and paints a tree at a colour depth, and reads cells back.
 *
 * Through `resolveStyles()` rather than straight to `paint()`, because the depth
 * an image degrades to is the one its style was resolved at -- skipping the
 * resolve is drawing at a depth nobody chose.
 */
function grid(root: Element, width: number, height: number, colorLevel: 0 | 1 | 2 | 3 = 3) {
  const cascade = new Cascade([]);
  cascade.media = { ...cascade.media, colorLevel };
  const styles = new StyleTable();
  const buffer = new CellBuffer(width, height);
  resolveStyles(root, new Restyler(cascade));
  arrange(root, { height, width });
  paint(root, new Painter(buffer, styles));

  const at = (x: number, y: number): Style => styles.get(buffer.styleAt(x, y));
  return {
    at,
    char: (x: number, y: number): string => buffer.charAt(x, y),
    lines: (): string[] => buffer.toLines().map((line) => line.trimEnd()),
    styles,
  };
}

/** Paints a tree into a canvas for some frames, and says what the table did. */
function frames(
  count: number,
  tree: (frame: number) => Element,
  width: number,
  height: number,
  direction: 'column' | 'row' = 'column'
) {
  const canvas = createCanvas({ height, width });
  const restyler = new Restyler(new Cascade([]));
  let peak = 0;
  for (let f = 0; f < count; f++) {
    const root = box({ 'flex-direction': direction, height, width }, tree(f));
    resolveStyles(root, restyler);
    arrange(root, { height, width });
    canvas.paint((painter) => paint(root, painter));
    peak = Math.max(peak, canvas.stats.styles);
    canvas.present();
  }
  const live = new Set(canvas.cells.rawStyles()).size;
  return { live, peak, sweeps: canvas.stats.sweeps };
}
describe('imageView()', () => {
  it('should ask for a column per pixel and a row per two', () => {
    // a cell is about twice as tall as it is wide, and a half block makes it
    // two pixels, so a square picture is half as many rows as columns
    const { height, width } = imageView(picture(8, 8, () => RED));
    expect({ height, width }).toEqual({ height: 4, width: 8 });
  });

  it('should keep its proportions in a box narrower than it is', () => {
    const { element } = imageView(picture(40, 20, () => RED));
    const root = box({ 'flex-direction': 'column', width: 10 }, element);
    grid(root, 10, 10);
    // 40x20 pixels is 2:1, so ten columns are ten pixels by five, which is
    // two and a half rows -- rounded to three
    expect(element.box).toMatchObject({ height: 3, width: 10 });
  });

  it('should take a width, and work the height out from the picture', () => {
    const { element, height, width } = imageView(
      picture(40, 20, () => RED),
      { width: 20 }
    );
    expect({ height, width }).toEqual({ height: 5, width: 20 });
    grid(box({ 'align-items': 'flex-start' }, element), 60, 20);
    expect(element.box).toMatchObject({ height: 5, width: 20 });
  });

  it('should take a height, and work the width out from the picture', () => {
    const { element, height, width } = imageView(
      picture(40, 20, () => RED),
      { height: 4 }
    );
    expect({ height, width }).toEqual({ height: 4, width: 16 });
    grid(box({ 'align-items': 'flex-start' }, element), 60, 20);
    expect(element.box).toMatchObject({ height: 4, width: 16 });
  });

  it('should refuse a size that is not a whole number of cells', () => {
    const red = picture(2, 2, () => RED);
    expect(() => imageView(red, { width: 2.5 })).toThrow(/whole number of cells/);
    expect(() => imageView(red, { height: -1 })).toThrow(/whole number of cells/);
  });

  it('should refuse a picture whose data does not match its size', () => {
    expect(() => imageView({ data: new Uint8Array(3), height: 1, width: 1 })).toThrow(TypeError);
  });

  it('should draw a solid cell as one full block, and two colours as a half block', () => {
    // red over blue in the first column, all red in the second
    const pic = picture(2, 2, (x, y) => (x === 1 || y === 0 ? RED : BLUE));
    const { element } = imageView(pic);
    const g = grid(box({}, element), 2, 1);

    expect(g.char(0, 0)).toBe('▀');
    expect(g.at(0, 0)).toMatchObject({ bg: rgb(0, 0, 255), fg: rgb(255, 0, 0) });
    expect(g.char(1, 0)).toBe('█');
    expect(g.at(1, 0).fg).toBe(rgb(255, 0, 0));
  });

  it('should resample to the box it was given rather than the size it asked for', () => {
    // a picture that asks for four columns, in a box that gives it two: each
    // drawn pixel is the average of two source columns, red and blue
    const stripes = picture(4, 2, (x) => (x % 2 === 0 ? RED : BLUE));
    const { element } = imageView(stripes, { fit: 'fill' });
    const g = grid(box({ width: 2 }, element), 2, 1);
    expect(g.at(0, 0).fg).toBe(rgb(128, 0, 128));
  });

  it('should letterbox a picture in a box that is not its shape, by default', () => {
    // 4x2 pixels is 2:1; a box of 4 by 4 cells is 4x8 pixels, so the picture is
    // drawn at its own size in the middle -- pixel rows 3 and 4, which is the
    // bottom half of row 1 and the top half of row 2. Half a cell is a real
    // offset here, because each half has its own colour
    const { element } = imageView(picture(4, 2, () => RED));
    const g = grid(box({ height: 4, width: 4 }, box({ flex: 1 }, element)), 4, 4);

    expect(element.box).toMatchObject({ height: 4, width: 4 });
    expect(g.lines()).toEqual(['', '▄▄▄▄', '▀▀▀▀', '']);
  });

  it('should crop to fill the box with cover', () => {
    // red | blue | red across a 3x1 picture, into one square-ish cell: cover
    // keeps the middle third, which is all blue
    const bands = picture(3, 1, (x) => (x === 1 ? BLUE : RED));
    const { element } = imageView(bands, { fit: 'cover', height: 1, width: 1 });
    const g = grid(box({}, element), 1, 1);
    expect(g.char(0, 0)).toBe('█');
    expect(g.at(0, 0).fg).toBe(rgb(0, 0, 255));
  });

  it('should stretch to the box with fill', () => {
    const { element } = imageView(
      picture(4, 2, () => RED),
      { fit: 'fill' }
    );
    const g = grid(box({ height: 4, width: 4 }, box({ flex: 1 }, element)), 4, 4);
    expect(g.lines()).toEqual(['████', '████', '████', '████']);
  });

  it('should draw nothing for an empty picture, and ask for no room', () => {
    const none = { data: new Uint8Array(0), height: 0, width: 0 };
    const { element, height, width } = imageView(none);
    expect({ height, width }).toEqual({ height: 0, width: 0 });
    const g = grid(box({ height: 2, width: 2 }, box({ flex: 1 }, imageView(none).element)), 2, 2);
    expect(g.lines()).toEqual(['', '']);
    expect(element.type).toBe('raw');
  });
});

describe('an image from a PNG', () => {
  it('should draw PNG bytes exactly as it draws the pixels in them', () => {
    const pic = picture(6, 4, (x, y) => [x * 40, y * 60, 200, x === 5 ? 0 : 255]);
    const fromPng = grid(box({}, imageView(encodePng(pic)).element), 6, 2);
    const fromRgba = grid(box({}, imageView(pic).element), 6, 2);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 6; x++) {
        expect(fromPng.char(x, y), `${x},${y}`).toBe(fromRgba.char(x, y));
        expect(fromPng.at(x, y), `${x},${y}`).toEqual(fromRgba.at(x, y));
      }
    }
  });

  it('should take a Buffer, which is what readFileSync hands back', () => {
    const png = Buffer.from(encodePng(picture(2, 2, () => RED)));
    expect(imageView(png)).toMatchObject({ height: 1, width: 2 });
  });

  it('should refuse bytes that are not a PNG when the view is built, not in a frame', () => {
    expect(() => imageView(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not a PNG file/);
    expect(() => image(new Uint8Array(0), { colorLevel: 0 })).toThrow(/Not a PNG file/);
  });

  it('should take the RGBA a canvas hands back, which is clamped', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 255, 0, 0, 255]);
    const view = imageView({ data: data as unknown as Uint8Array, height: 2, width: 1 });
    expect(grid(box({}, view.element), 1, 1).at(0, 0).fg).toBe(rgb(255, 0, 0));
  });
});

describe('an image over a background', () => {
  it('should mix a part-transparent pixel with the box it is in', () => {
    // half-covered red over a blue box is half way between them, which is what
    // alpha means and what the grid can answer because the box filled first
    const half = picture(1, 2, () => [255, 0, 0, 128]);
    const { element } = imageView(half);
    const g = grid(box({ 'background-color': '#0000ff' }, element), 1, 1);
    expect(g.char(0, 0)).toBe('█');
    expect(g.at(0, 0).fg).toBe(rgb(128, 0, 127));
  });

  it('should mix over a palette background through the xterm defaults', () => {
    const half = picture(1, 2, () => [255, 255, 255, 128]);
    const { element } = imageView(half);
    // palette 4 is xterm's blue, 0,0,238
    const g = grid(box({ 'background-color': 'blue' }, element), 1, 1);
    expect(g.at(0, 0).fg).toBe(rgb(128, 128, 247));
  });

  it('should take each cell its own background', () => {
    const half = picture(2, 2, () => [255, 255, 255, 128]);
    const { element } = imageView(half);
    const root = box(
      { 'flex-direction': 'row', width: 2 },
      box({ 'background-color': '#000000', width: 1 }),
      box({ 'background-color': '#ffffff', width: 1 })
    );
    // the image laid over both, absolutely, so the grid holds two backgrounds
    // under one picture and an ancestor walk would find neither
    const layered = box(
      { width: 2 },
      root,
      box({ left: 0, position: 'absolute', top: 0 }, element)
    );
    const g = grid(layered, 2, 1);
    expect(g.at(0, 0).fg).toBe(rgb(128, 128, 128));
    expect(g.at(1, 0).fg).toBe(rgb(255, 255, 255));
  });

  it('should draw a pixel more than half there over the terminal own, and leave one less', () => {
    // there is no colour to mix with: the terminal's background is not one this
    // library knows, so a pixel is drawn or it is not
    const pic = picture(2, 2, (x) => (x === 0 ? [255, 0, 0, 200] : [255, 0, 0, 100]));
    const { element } = imageView(pic);
    const g = grid(box({}, element), 2, 1);
    expect(g.char(0, 0)).toBe('█');
    expect(g.at(0, 0).fg).toBe(rgb(255, 0, 0));
    expect(g.char(1, 0)).toBe(' ');
    expect(g.at(1, 0)).toMatchObject({ bg: DEFAULT_COLOR, fg: DEFAULT_COLOR });
  });

  it('should leave a transparent half showing the box under it', () => {
    // red on top, nothing below, over a blue box: a lower half block cannot say
    // "transparent", so the top is the glyph and the bottom keeps the box's own
    const pic = picture(1, 2, (_x, y) => (y === 0 ? RED : [0, 0, 0, 0]));
    const { element } = imageView(pic);
    const g = grid(box({ 'background-color': '#0000ff' }, element), 1, 1);
    expect(g.char(0, 0)).toBe('▀');
    expect(g.at(0, 0)).toMatchObject({ bg: rgb(0, 0, 255), fg: rgb(255, 0, 0) });
  });

  it('should paint nothing at all where the picture is wholly transparent', () => {
    const clear = picture(2, 2, () => [255, 0, 0, 0]);
    const { element } = imageView(clear);
    const g = grid(box({ 'background-color': '#0000ff' }, element), 2, 1);
    expect(g.char(0, 0)).toBe(' ');
    expect(g.at(0, 0)).toMatchObject({ bg: rgb(0, 0, 255), fg: DEFAULT_COLOR });
  });
});

describe('an image at a colour depth', () => {
  /** A picture of many colours, so the depth has something to quantize. */
  const rainbow = picture(16, 8, (x, y) => [x * 16, y * 32, 255 - x * 16, 255]);

  it('should draw truecolor at level 3', () => {
    const g = grid(box({}, imageView(rainbow).element), 16, 4, 3);
    expect(g.at(3, 1).fg).toBeGreaterThanOrEqual(0x100);
  });

  it('should land on the cube and the grey ramp at level 2, never the sixteen', () => {
    const g = grid(box({}, imageView(rainbow).element), 16, 4, 2);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 16; x++) {
        const { bg, fg } = g.at(x, y);
        for (const color of [fg, bg]) {
          if (color !== DEFAULT_COLOR) {
            expect(color, `${x},${y}`).toBeGreaterThanOrEqual(16);
            expect(color, `${x},${y}`).toBeLessThan(256);
          }
        }
      }
    }
  });

  it('should land on the basic sixteen at level 1', () => {
    const g = grid(box({}, imageView(rainbow).element), 16, 4, 1);
    const seen = new Set<number>();
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 16; x++) {
        seen.add(g.at(x, y).fg);
      }
    }
    expect([...seen].every((color) => color >= 0 && color < 16)).toBe(true);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('should draw nothing at level 0, and keep its box', () => {
    const { element } = imageView(rainbow);
    const g = grid(box({}, element), 16, 4, 0);
    expect(g.lines()).toEqual(['', '', '', '']);
    expect(g.styles.size).toBe(1);
    expect(element.box).toMatchObject({ height: 4, width: 16 });
  });

  it('should follow a depth that moved, rather than the one it first drew at', () => {
    // the element is kept across frames by an app, and a level refined from what
    // the terminal said is a later resolve at a different depth
    const { element } = imageView(rainbow);
    const root = box({}, element);
    expect(grid(root, 16, 4, 3).at(3, 1).fg).toBeGreaterThanOrEqual(0x100);
    expect(grid(root, 16, 4, 2).at(3, 1).fg).toBeLessThan(0x100);
  });

  it('should mix over a degraded background and then degrade the mix', () => {
    const half = picture(1, 2, () => [255, 255, 255, 128]);
    const { element } = imageView(half);
    const g = grid(box({ 'background-color': '#0000ff' }, element), 1, 1, 2);
    // the box is the cube's pure blue at 256 colours, 21, and the mix of white
    // over it is a light blue the cube also has
    expect(g.at(0, 0).bg).toBe(palette(21));
    expect(g.at(0, 0).fg).toBeGreaterThanOrEqual(16);
    expect(g.at(0, 0).fg).toBeLessThan(256);
  });
});

describe('image()', () => {
  it('should print the picture as lines of half blocks', () => {
    const pic = picture(2, 2, (x, y) => (x === 1 || y === 0 ? RED : BLUE));
    const out = image(pic, { colorLevel: 3 });
    expect(out).toBe('\u001b[38;2;255;0;0;48;2;0;0;255m▀\u001b[49m█\u001b[0m');
  });

  it('should be nothing at level 0', () => {
    expect(
      image(
        picture(4, 4, () => RED),
        { colorLevel: 0 }
      )
    ).toBe('');
  });

  it('should be as wide as it was asked to be', () => {
    const out = image(
      picture(40, 20, () => RED),
      { colorLevel: 3, width: 10 }
    );
    expect(out.split('\n')).toHaveLength(3);
  });
});

describe('the style table under a picture', () => {
  // a photograph is the worst case the sweep has: every half-cell its own
  // colour, so a frame interns a style per cell. A noise field stands in for one
  // here, and a real photograph is measured under `a photograph` below
  const noise = picture(80, 96, (x, y) => {
    const h = Math.imul(x * 374761393 + y * 668265263, 1274126177) >>> 0;
    return [h & 255, (h >>> 8) & 255, (h >>> 16) & 255, 255];
  });

  it('should sweep a still picture once and never again, overflowing its grid or not', () => {
    // 80 columns of a picture 80 wide is 48 rows, twice the grid: half of every
    // frame is off the bottom -- a row stretches a measuring item to the larger of
    // the room and its height, so it overflows rather than shrinking -- and
    // interning those cells is what made the table grow past its trigger on
    // every frame
    const still = imageView(noise).element;
    const { live, peak, sweeps } = frames(30, () => still, 80, 24, 'row');
    expect(still.box?.height).toBe(48);
    expect(sweeps).toBe(1);
    expect(peak).toBeLessThanOrEqual(live + 1);
  });

  it('should hold a picture that changes every frame to about three times what it draws', () => {
    // the trigger is twice what survived the last sweep, checked after a frame
    // has interned: so the table can hold the survivors, one frame that did not
    // cross, and the one that did
    const views = Array.from(
      { length: 8 },
      (_, i) =>
        imageView(picture(80, 48, (x, y) => [(x * 3 + i * 29) & 255, (y * 5) & 255, i * 30, 255]))
          .element
    );
    const { live, peak, sweeps } = frames(40, (f) => views[f % views.length], 80, 24);
    expect(sweeps).toBeGreaterThanOrEqual(10);
    expect(peak).toBeLessThanOrEqual(live * 3 + 3);
  });
});

describe('a photograph', () => {
  // a public-domain photograph by Adrian Pingstone, which the image demo draws:
  // the measurement `src/canvas/AGENTS.md` records under "An image over
  // `Pixels`", kept as a test so that the claim is one a change can fail
  const photo = decodePng(
    readFileSync(new URL('../../../../demos/components/images/macaw.png', import.meta.url))
  );

  it('should be the photograph the measurement was taken against', () => {
    expect({ height: photo.height, width: photo.width }).toEqual({ height: 321, width: 240 });
  });

  it('should sweep a still photograph once at every size, however many styles it holds', () => {
    for (const [width, height] of [
      [80, 24],
      [200, 60],
    ]) {
      const still = imageView(photo, { fit: 'cover' }).element;
      const { live, peak, sweeps } = frames(20, () => still, width, height);
      expect(sweeps, `${width}x${height}`).toBe(1);
      expect(peak, `${width}x${height}`).toBeLessThanOrEqual(live + 1);
      // and it is the worst case it is said to be: most cells their own style
      expect(live, `${width}x${height}`).toBeGreaterThan(width * height * 0.9);
    }
  });

  it('should hold a panning photograph to about three times what it draws', () => {
    // a crop one source pixel further along each frame, so each frame is a
    // screen of colours the last did not have: the worst case the trigger has
    const crops = Array.from({ length: 12 }, (_, offset) => {
      const data = new Uint8Array(180 * 241 * 4);
      for (let y = 0; y < 241; y++) {
        const from = ((y + offset) * photo.width + offset) * 4;
        data.set(photo.data.subarray(from, from + 180 * 4), y * 180 * 4);
      }
      return imageView({ data, height: 241, width: 180 }, { fit: 'cover' }).element;
    });
    const { live, peak, sweeps } = frames(48, (f) => crops[f % crops.length], 80, 24);
    expect(sweeps).toBeGreaterThanOrEqual(20);
    expect(sweeps).toBeLessThanOrEqual(30);
    expect(peak / live).toBeLessThan(3.5);
  });
});
