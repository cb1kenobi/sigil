import {
  CellBuffer,
  DEFAULT_COLOR,
  Painter,
  palette,
  resampleImage,
  type RgbaImage,
  rgb,
  StyleTable,
} from '../../src/canvas/index.js';
import { describe, expect, it } from 'vitest';

/** A picture from a function of its pixel coordinates. */
function picture(
  width: number,
  height: number,
  at: (x: number, y: number) => readonly [number, number, number, number]
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set(at(x, y), (y * width + x) * 4);
    }
  }
  return { data, height, width };
}

/** One pixel of a picture, as its four bytes. */
function pixel(image: RgbaImage, x: number, y: number): number[] {
  const at = (y * image.width + x) * 4;
  return [...image.data.subarray(at, at + 4)];
}

describe('resampleImage()', () => {
  it('should average every source pixel that lands in a destination pixel', () => {
    // a 4x2 checkerboard of black and white into one pixel is the mean of all
    // eight: a nearest-neighbour sample would be one of the two, whichever the
    // rounding picked
    const board = picture(4, 2, (x, y) =>
      (x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]
    );
    expect(pixel(resampleImage(board, 1, 1), 0, 0)).toEqual([128, 128, 128, 255]);
  });

  it('should weight a source pixel by how much of it lands in a destination pixel', () => {
    // three columns into two: each destination pixel is a column and a half, so
    // the middle one is split between them -- counting it whole in both would
    // make the two halves 85 and 170 rather than 64 and 191
    const ramp = picture(3, 1, (x) => {
      const v = [0, 128, 255][x];
      return [v, v, v, 255];
    });
    const out = resampleImage(ramp, 2, 1);
    // (0 * 1 + 128 * 0.5) / 1.5 and (128 * 0.5 + 255 * 1) / 1.5
    expect(pixel(out, 0, 0)).toEqual([43, 43, 43, 255]);
    expect(pixel(out, 1, 0)).toEqual([213, 213, 213, 255]);
  });

  it('should be the identity at the same size', () => {
    const noise = picture(5, 3, (x, y) => [
      (x * 53) % 256,
      (y * 97) % 256,
      (x * y * 31) % 256,
      255,
    ]);
    expect([...resampleImage(noise, 5, 3).data]).toEqual([...noise.data]);
  });

  it('should average premultiplied, so a transparent pixel adds no colour', () => {
    // a red pixel beside a transparent *black* one. Averaged straight, the
    // colour is half red and half the black nobody can see -- the dark fringe
    // round a resized cut-out. Premultiplied, it is all red and half there
    const edge = picture(2, 1, (x) => (x === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
    expect(pixel(resampleImage(edge, 1, 1), 0, 0)).toEqual([255, 0, 0, 128]);
  });

  it('should leave a pixel nothing opaque landed in transparent', () => {
    const clear = picture(2, 2, () => [200, 100, 50, 0]);
    expect(pixel(resampleImage(clear, 1, 1), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('should repeat a pixel when scaling up', () => {
    const two = picture(2, 1, (x) => (x === 0 ? [10, 20, 30, 255] : [200, 210, 220, 255]));
    const out = resampleImage(two, 4, 2);
    for (let y = 0; y < 2; y++) {
      expect(pixel(out, 0, y)).toEqual([10, 20, 30, 255]);
      expect(pixel(out, 1, y)).toEqual([10, 20, 30, 255]);
      expect(pixel(out, 2, y)).toEqual([200, 210, 220, 255]);
      expect(pixel(out, 3, y)).toEqual([200, 210, 220, 255]);
    }
  });

  it('should resample only the rectangle it is given', () => {
    // the right half of a picture whose left half is black
    const halves = picture(4, 2, (x) => (x < 2 ? [0, 0, 0, 255] : [0, 255, 0, 255]));
    const out = resampleImage(halves, 1, 1, { height: 2, width: 2, x: 2, y: 0 });
    expect(pixel(out, 0, 0)).toEqual([0, 255, 0, 255]);
  });

  it('should take a fractional rectangle, which a centred crop is', () => {
    // half a column of black and a whole one of white, so a third black
    const halves = picture(2, 1, (x) => (x === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const out = resampleImage(halves, 1, 1, { height: 1, width: 1.5, x: 0.5, y: 0 });
    expect(pixel(out, 0, 0)).toEqual([170, 170, 170, 255]);
  });

  it('should clamp a rectangle that reaches past the picture', () => {
    const solid = picture(2, 2, () => [9, 8, 7, 255]);
    const out = resampleImage(solid, 1, 1, { height: 10, width: 10, x: -5, y: -5 });
    expect(pixel(out, 0, 0)).toEqual([9, 8, 7, 255]);
  });

  it('should refuse a rectangle with nothing of the picture in it', () => {
    const solid = picture(2, 2, () => [9, 8, 7, 255]);
    expect(() => resampleImage(solid, 1, 1, { height: 1, width: 1, x: 5, y: 0 })).toThrow(
      RangeError
    );
    expect(() => resampleImage(solid, 1, 1, { height: 1, width: Number.NaN, x: 0, y: 0 })).toThrow(
      RangeError
    );
  });

  it('should come back empty at no size, and from no picture', () => {
    const solid = picture(2, 2, () => [9, 8, 7, 255]);
    expect(resampleImage(solid, 0, 3)).toEqual({ data: new Uint8Array(0), height: 3, width: 0 });
    const none = { data: new Uint8Array(0), height: 0, width: 0 };
    expect(resampleImage(none, 2, 1).data).toEqual(new Uint8Array(8));
  });

  it('should refuse a size that is not a whole number of pixels', () => {
    const solid = picture(2, 2, () => [9, 8, 7, 255]);
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resampleImage(solid, bad, 1), String(bad)).toThrow(RangeError);
      expect(() => resampleImage(solid, 1, bad), String(bad)).toThrow(RangeError);
    }
  });

  it('should refuse data that does not match the size it claims', () => {
    // a row short reads as `undefined`, which the arithmetic would turn into a
    // `NaN` that `rgb()` throws about from somewhere else entirely
    const short = { data: new Uint8Array(12), height: 2, width: 2 };
    expect(() => resampleImage(short, 1, 1)).toThrow(/expected 16 bytes of RGBA for 2x2, got 12/);
    const wrong = { data: [1, 2, 3, 4] as unknown as Uint8Array, height: 1, width: 1 };
    expect(() => resampleImage(wrong, 1, 1)).toThrow(TypeError);
    expect(() => resampleImage({ data: new Uint8Array(0), height: 1.5, width: 0 }, 1, 1)).toThrow(
      /whole numbers/
    );
  });

  it('should take a Buffer, which is what readFileSync hands a decoder', () => {
    const buffer = Buffer.from([1, 2, 3, 255]);
    expect(pixel(resampleImage({ data: buffer, height: 1, width: 1 }, 1, 1), 0, 0)).toEqual([
      1, 2, 3, 255,
    ]);
  });

  it('should read each source row once, however far it downscales', () => {
    // 1,002 rows into 48 is 20.875 a row, so most destination rows start and
    // end inside a source row: the weights of every destination row have to
    // sum to one or a band of the picture comes out brighter than the rest
    const grey = picture(3, 1002, () => [100, 100, 100, 255]);
    const out = resampleImage(grey, 1, 48);
    for (let y = 0; y < 48; y++) {
      expect(pixel(out, 0, y), `row ${y}`).toEqual([100, 100, 100, 255]);
    }
  });
});

describe('Painter.backgroundAt()', () => {
  it('should read the background already in a cell', () => {
    const styles = new StyleTable();
    const buffer = new CellBuffer(4, 1);
    const painter = new Painter(buffer, styles);
    painter.fill(0, 0, 2, 1, { bg: palette(4) });
    painter.text(2, 0, 'x', { bg: rgb(1, 2, 3), fg: palette(1) });

    expect(painter.backgroundAt(0, 0)).toBe(palette(4));
    expect(painter.backgroundAt(2, 0)).toBe(rgb(1, 2, 3));
    expect(painter.backgroundAt(3, 0)).toBe(DEFAULT_COLOR);
  });

  it('should answer the terminal own off the grid and outside the clip', () => {
    const styles = new StyleTable();
    const buffer = new CellBuffer(4, 1);
    const painter = new Painter(buffer, styles);
    painter.fill(0, 0, 4, 1, { bg: palette(4) });

    expect(painter.backgroundAt(-1, 0)).toBe(DEFAULT_COLOR);
    expect(painter.backgroundAt(4, 0)).toBe(DEFAULT_COLOR);
    painter.clip({ height: 1, width: 2, x: 0, y: 0 }, (clipped) => {
      expect(clipped.backgroundAt(1, 0)).toBe(palette(4));
      expect(clipped.backgroundAt(2, 0)).toBe(DEFAULT_COLOR);
    });
  });
});
