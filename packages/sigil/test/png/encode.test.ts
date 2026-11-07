import { decodePng, encodePng, type RgbaImage } from '../../src/png/index.js';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

/** The chunks of a PNG as `[type, body]`, with no checking: the decoder does that. */
function chunks(bytes: Uint8Array): [string, Uint8Array][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: [string, Uint8Array][] = [];
  for (let pos = 8; pos < bytes.length;) {
    const length = view.getUint32(pos);
    out.push([
      String.fromCharCode(...bytes.subarray(pos + 4, pos + 8)),
      bytes.subarray(pos + 8, pos + 8 + length),
    ]);
    pos += 12 + length;
  }
  return out;
}

function body(bytes: Uint8Array, type: string): Uint8Array | undefined {
  return chunks(bytes).find(([t]) => t === type)?.[1];
}

/** `[bit depth, colour type]` from IHDR. */
function format(bytes: Uint8Array): [number, number] {
  const ihdr = body(bytes, 'IHDR')!;
  return [ihdr[8], ihdr[9]];
}

/** An image whose pixels cycle through `colours`, one per pixel. */
function image(width: number, height: number, colours: number[][]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const [r, g, b, a = 255] = colours[i % colours.length];
    data.set([r, g, b, a], i * 4);
  }
  return { data, height, width };
}

/** `n` distinct opaque colours. */
function distinct(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => [i & 0xff, i >> 8, 7]);
}

/** A deterministic pseudo-random image, so a test is the same test every run. */
function noise(width: number, height: number, alpha: boolean, seed = 1): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  let s = seed;
  for (let i = 0; i < data.length; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    data[i] = alpha || i % 4 !== 3 ? s >>> 24 : 255;
  }
  return { data, height, width };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function roundTrips(input: RgbaImage) {
  const output = decodePng(encodePng(input));
  expect(output.width).toBe(input.width);
  expect(output.height).toBe(input.height);
  expect(Buffer.from(output.data).equals(Buffer.from(input.data))).toBe(true);
}

describe('encodePng()', () => {
  describe('choosing the format', () => {
    it.each([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 4],
      [16, 4],
      [17, 8],
      [256, 8],
    ])('should write %i colours as a palette at depth %i', (count, depth) => {
      const input = image(64, 5, distinct(count));
      const bytes = encodePng(input);
      expect(format(bytes)).toEqual([depth, 3]);
      expect(body(bytes, 'PLTE')).toHaveLength(count * 3);
      expect(body(bytes, 'tRNS')).toBeUndefined();
      roundTrips(input);
    });

    it('should write RGB past 256 colours, and RGBA once any of them has alpha', () => {
      const opaque = image(300, 2, distinct(257));
      expect(format(encodePng(opaque))).toEqual([8, 2]);
      roundTrips(opaque);

      const translucent = image(300, 2, [...distinct(256), [1, 2, 3, 254]]);
      expect(format(encodePng(translucent))).toEqual([8, 6]);
      roundTrips(translucent);
    });

    it('should count a colour as all four channels, so alpha alone makes two', () => {
      const bytes = encodePng(
        image(2, 1, [
          [9, 9, 9, 255],
          [9, 9, 9, 0],
        ])
      );
      expect(format(bytes)).toEqual([1, 3]);
      expect([...body(bytes, 'PLTE')!]).toEqual([9, 9, 9, 9, 9, 9]);
    });

    it('should put translucent palette entries first, so tRNS stops at the last of them', () => {
      const colours = [
        [1, 1, 1, 255],
        [2, 2, 2, 128],
        [3, 3, 3, 255],
        [4, 4, 4, 0],
      ];
      const input = image(4, 1, colours);
      const bytes = encodePng(input);
      expect([...body(bytes, 'PLTE')!]).toEqual([2, 2, 2, 4, 4, 4, 1, 1, 1, 3, 3, 3]);
      expect([...body(bytes, 'tRNS')!]).toEqual([128, 0]);
      roundTrips(input);
    });

    it('should write IHDR, PLTE, tRNS, IDAT and IEND and nothing ancillary', () => {
      expect(
        chunks(
          encodePng(
            image(2, 1, [
              [0, 0, 0, 0],
              [1, 1, 1, 255],
            ])
          )
        ).map(([t]) => t)
      ).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
      expect(chunks(encodePng(noise(20, 20, false))).map(([t]) => t)).toEqual([
        'IHDR',
        'IDAT',
        'IEND',
      ]);
    });
  });

  describe('filtering', () => {
    it('should pick a filter per row by the smallest sum of absolute values', () => {
      // a horizontal ramp: the first row is best as Sub, since there is no row
      // above it to predict from, and every row after it is all zeros as Up
      const width = 300;
      const data = new Uint8Array(width * 4 * 4);
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < width; x++) {
          data.set([x & 0xff, (x * 3) & 0xff, (x >> 1) & 0xff, 255], (y * width + x) * 4);
        }
      }
      const bytes = encodePng({ data, height: 4, width });
      expect(format(bytes)).toEqual([8, 2]);

      const raw = inflateSync(body(bytes, 'IDAT')!);
      const stride = width * 3 + 1;
      expect([0, 1, 2, 3].map((y) => raw[y * stride])).toEqual([1, 2, 2, 2]);
    });

    it('should keep whichever of filtered and unfiltered is smaller for a palette', () => {
      // a vertical greyscale ramp fits a palette and its indices are a ramp
      // too, so filtering them wins; the module comment has the other half
      const width = 64;
      const height = 200;
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          data.set([y, y, y, 255], (y * width + x) * 4);
        }
      }
      const bytes = encodePng({ data, height, width });
      expect(format(bytes)).toEqual([8, 3]);
      const raw = inflateSync(body(bytes, 'IDAT')!);
      expect(raw[(width + 1) * 5]).not.toBe(0);
    });
  });

  describe('round trips', () => {
    it.each([1, 2, 3, 7, 8, 9, 15, 17, 33])(
      'should pack indices right at every depth for a width of %i',
      (width) => {
        for (const count of [2, 4, 16, 200]) {
          roundTrips(image(width, 3, distinct(count).reverse()));
        }
      }
    );

    it('should round-trip noise, with alpha and without', () => {
      roundTrips(noise(61, 47, false));
      roundTrips(noise(61, 47, true));
      roundTrips(noise(1, 1, true));
    });

    it('should take a Uint8ClampedArray, which is what a canvas hands back', () => {
      const input = noise(5, 5, true);
      const clamped = new Uint8ClampedArray(input.data);
      expect(encodePng({ ...input, data: clamped as unknown as Uint8Array })).toEqual(
        encodePng(input)
      );
    });

    it('should leave the pixels it was given alone', () => {
      const input = noise(9, 9, false);
      const before = sha256(input.data);
      encodePng(input);
      expect(sha256(input.data)).toBe(before);
    });
  });

  describe('determinism', () => {
    it('should give the same bytes for the same pixels, from separate arrays', () => {
      const a = noise(40, 30, true, 7);
      const b = { ...a, data: a.data.slice() };
      expect(encodePng(a)).toEqual(encodePng(b));
    });

    it('should write the same bytes on every platform CI runs on', () => {
      // the claim a committed screenshot depends on, and the one a local run
      // cannot check: these are the bytes of one indexed and one truecolour
      // image as encoded where this was written, and CI asserts them on three
      // operating systems and three node versions
      expect(sha256(encodePng(image(97, 31, distinct(13))))).toBe(
        'f980b7ada6066b47083913156bfb3cdb94f480b17be1d14a06b4dffb70a0c63c'
      );
      expect(sha256(encodePng(noise(97, 31, true, 3)))).toBe(
        'bf5fe5166430bf5f98e953cefd90117b957a30a9331356c75c3a4eb70202b3a2'
      );
    });
  });

  describe('refusing', () => {
    it.each([
      ['no image', undefined],
      ['a zero width', { data: new Uint8Array(0), height: 1, width: 0 }],
      ['a fractional height', { data: new Uint8Array(6), height: 1.5, width: 1 }],
      ['a NaN width', { data: new Uint8Array(4), height: 1, width: Number.NaN }],
      ['data of the wrong length', { data: new Uint8Array(15), height: 2, width: 2 }],
      ['a plain array', { data: [0, 0, 0, 0], height: 1, width: 1 }],
      ['a Float32Array', { data: new Float32Array(4), height: 1, width: 1 }],
    ])('should refuse %s with a TypeError', (_, input) => {
      expect(() => encodePng(input as unknown as RgbaImage)).toThrow(TypeError);
    });
  });
});
