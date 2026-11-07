import { decodePng, MAX_PIXELS } from '../../src/png/index.js';
import { chunk, grey, idat, IEND, ihdr, pixels, png } from './helpers.js';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

describe('decodePng()', () => {
  describe('reading', () => {
    it('should decode greyscale into opaque RGBA', () => {
      const image = decodePng(
        grey([
          [0, 128],
          [200, 255],
        ])
      );
      expect(image.width).toBe(2);
      expect(image.height).toBe(2);
      expect(pixels(image.data)).toEqual([
        [0, 0, 0, 255],
        [128, 128, 128, 255],
        [200, 200, 200, 255],
        [255, 255, 255, 255],
      ]);
    });

    it('should round a 16-bit sample to the nearest 8-bit one rather than truncating it', () => {
      // 0x0080 is 128/257 = 0.498 and 0x0081 is 0.502, so they land either
      // side of 0.5, and 0xff00 is 254.01. Taking the high byte would make
      // the first two both 0 and the third 255
      const samples = [0x0080, 0x0081, 0xff00, 0xffff];
      const raw = [0, ...samples.flatMap((v) => [v >> 8, v & 0xff])];
      const image = decodePng(png(ihdr(4, 1, 16, 0), idat(raw), IEND));
      expect(pixels(image.data).map(([v]) => v)).toEqual([0, 1, 254, 255]);
    });

    it('should compare a 16-bit tRNS key before reducing, so a neighbour stays opaque', () => {
      // 0x1234 and 0x1235 both round to 18; only the one tRNS names is clear
      const raw = [0, 0x12, 0x34, 0x12, 0x35];
      const image = decodePng(png(ihdr(2, 1, 16, 0), chunk('tRNS', [0x12, 0x34]), idat(raw), IEND));
      expect(pixels(image.data)).toEqual([
        [18, 18, 18, 0],
        [18, 18, 18, 255],
      ]);
    });

    it('should make the one truecolour value tRNS names transparent', () => {
      const raw = [0, 10, 20, 30, 10, 20, 31];
      const trns = chunk('tRNS', [0, 10, 0, 20, 0, 30]);
      const image = decodePng(png(ihdr(2, 1, 8, 2), trns, idat(raw), IEND));
      expect(pixels(image.data)).toEqual([
        [10, 20, 30, 0],
        [10, 20, 31, 255],
      ]);
    });

    it('should leave palette entries past the end of tRNS opaque', () => {
      const plte = chunk('PLTE', [255, 0, 0, 0, 255, 0, 0, 0, 255]);
      const trns = chunk('tRNS', [64]);
      const image = decodePng(png(ihdr(3, 1, 8, 3), plte, trns, idat([0, 0, 1, 2]), IEND));
      expect(pixels(image.data)).toEqual([
        [255, 0, 0, 64],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
      ]);
    });

    it('should ignore the padding bits at the end of a 1-bit row', () => {
      // 3 pixels of 1, 0, 1 and five padding bits of 1 that are not pixels
      const image = decodePng(png(ihdr(3, 1, 1, 0), idat([0, 0b10111111]), IEND));
      expect(pixels(image.data).map(([v]) => v)).toEqual([255, 0, 255]);
    });

    it('should skip an ancillary chunk it does not know', () => {
      const text = chunk('tEXt', Buffer.from('Comment\0hello', 'latin1'));
      const image = decodePng(png(ihdr(1, 1), text, idat([0, 42]), chunk('zzZz', [1, 2]), IEND));
      expect(pixels(image.data)).toEqual([[42, 42, 42, 255]]);
    });

    it('should read one stream split across several IDAT chunks', () => {
      const stream = deflateSync(Uint8Array.from([0, 1, 2, 3, 0, 4, 5, 6]));
      const parts = [stream.subarray(0, 3), stream.subarray(3, 4), stream.subarray(4)];
      const image = decodePng(png(ihdr(3, 2), ...parts.map((p) => chunk('IDAT', p)), IEND));
      expect(pixels(image.data).map(([v]) => v)).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('should ignore whatever follows IEND', () => {
      const bytes = grey([[7]]);
      const padded = new Uint8Array(bytes.length + 5);
      padded.set(bytes);
      expect(pixels(decodePng(padded).data)).toEqual([[7, 7, 7, 255]]);
    });

    it('should read a Buffer, and a view that does not start at offset 0', () => {
      const bytes = grey([[9]]);
      const backing = new Uint8Array(bytes.length + 3);
      backing.set(bytes, 3);
      expect(pixels(decodePng(backing.subarray(3)).data)).toEqual([[9, 9, 9, 255]]);
      expect(pixels(decodePng(Buffer.from(bytes)).data)).toEqual([[9, 9, 9, 255]]);
    });

    it('should undo every filter type, against a zero row above the first', () => {
      // one row per filter, each filtered by hand against the row above it
      const rows = [
        [0, 10, 20],
        [1, 10, 10], // sub: 10, 20
        [2, 5, 5], // up: 15, 25
        [3, 10, 10], // average: 10 + 7, 10 + (17 + 25) / 2 = 17, 31
        [4, 1, 1], // paeth: 1 + 17 = 18, 1 + paeth(18, 31, 17) = 1 + 31 = 32
      ];
      const image = decodePng(png(ihdr(2, 5), idat(rows.flat()), IEND));
      expect(pixels(image.data).map(([v]) => v)).toEqual([10, 20, 10, 20, 15, 25, 17, 31, 18, 32]);
    });
  });

  describe('refusing', () => {
    function refuses(bytes: Uint8Array, message: string | RegExp) {
      expect(() => decodePng(bytes)).toThrow(message);
    }

    it('should refuse something that is not bytes with a TypeError', () => {
      expect(() => decodePng('PNG' as unknown as Uint8Array)).toThrow(TypeError);
    });

    it('should refuse a file too short to hold a signature', () => {
      refuses(new Uint8Array(0), 'Not a PNG file');
      refuses(Uint8Array.of(0x89, 0x50, 0x4e), 'Not a PNG file');
    });

    it('should refuse a file that ends part way through a chunk', () => {
      const bytes = grey([[1]]);
      refuses(bytes.subarray(0, 20), 'Truncated PNG: the IHDR chunk runs past the end of the file');
      refuses(bytes.subarray(0, 8 + 25 + 4), 'Truncated PNG: the file ends before its IEND chunk');
    });

    it('should refuse a file with no IEND', () => {
      refuses(png(ihdr(1, 1), idat([0, 0])), 'Truncated PNG: the file ends before its IEND chunk');
    });

    it('should refuse a CRC that does not match, on an ancillary chunk as much as a critical one', () => {
      refuses(
        png(ihdr(1, 1), chunk('tEXt', [65, 0, 66], { crc: 0 }), idat([0, 0]), IEND),
        'Corrupt PNG: the CRC of the tEXt chunk does not match its data'
      );
    });

    it('should name a chunk type that is not four letters in hex, so no control byte reaches a terminal', () => {
      // a type of ESC [ 2 J would clear the screen of whoever reads the error
      const bytes = png(ihdr(1, 1), chunk('\u001b[2J', []), idat([0, 0]), IEND);
      expect(() => decodePng(bytes)).toThrow('a chunk type of bytes 1b 5b 32 4a at offset 33');
    });

    it('should refuse a declared length past 2^31 - 1', () => {
      refuses(
        png(ihdr(1, 1), chunk('tEXt', [], { length: 0x80000000 })),
        'Invalid PNG: the tEXt chunk declares a length of 2147483648'
      );
    });

    it('should refuse a file that does not start with IHDR, or has two', () => {
      refuses(
        png(idat([0, 0]), ihdr(1, 1), IEND),
        'Invalid PNG: the first chunk is IDAT, not IHDR'
      );
      refuses(png(ihdr(1, 1), ihdr(1, 1), idat([0, 0]), IEND), 'more than one IHDR chunk');
    });

    it('should refuse an IHDR of the wrong length', () => {
      refuses(png(chunk('IHDR', new Uint8Array(12)), IEND), 'IHDR is 12 bytes rather than 13');
    });

    it('should refuse a zero or oversized dimension', () => {
      refuses(png(ihdr(0, 1), IEND), 'Invalid PNG: an image of 0x1 pixels');
      refuses(png(ihdr(0x80000000, 1), IEND), 'Invalid PNG: an image of 2147483648x1 pixels');
    });

    it('should refuse a compression, filter or interlace method that does not exist', () => {
      refuses(png(ihdr(1, 1, 8, 0, { compression: 1 }), IEND), 'compression method 1');
      refuses(png(ihdr(1, 1, 8, 0, { filter: 1 }), IEND), 'filter method 1');
      refuses(png(ihdr(1, 1, 8, 0, { interlace: 2 }), IEND), 'interlace method 2');
    });

    it('should refuse an image over maxPixels before inflating anything', () => {
      // 65536 squared is 2^32 pixels: 16 GiB of RGBA that a few bytes of
      // header ask for. Refused from IHDR alone, so there is no IDAT here at all
      refuses(png(ihdr(65536, 65536), IEND), 'PNG too large: 65536x65536 pixels');
      expect(MAX_PIXELS).toBe(2 ** 28);

      const small = grey([
        [1, 2],
        [3, 4],
      ]);
      expect(() => decodePng(small, { maxPixels: 3 })).toThrow('is more than the 3 allowed');
      expect(decodePng(small, { maxPixels: 4 }).width).toBe(2);
    });

    it('should stop inflating at the size IHDR implies, so a bomb costs nothing', () => {
      // 64 MiB of zeros deflates to about 64 KiB; a 1x1 image needs 2 bytes
      const bomb = chunk('IDAT', deflateSync(new Uint8Array(64 * 1024 * 1024)));
      const started = performance.now();
      refuses(
        png(ihdr(1, 1), bomb, IEND),
        'Corrupt PNG: the image data inflates to more than the 2 bytes a 1x1 image needs'
      );
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it('should refuse image data that is short of what IHDR implies', () => {
      refuses(
        png(ihdr(2, 2), idat([0, 1, 2]), IEND),
        'Corrupt PNG: the image data inflates to 3 bytes rather than 6'
      );
    });

    it('should refuse image data that is not a deflate stream', () => {
      refuses(
        png(ihdr(1, 1), chunk('IDAT', [1, 2, 3, 4]), IEND),
        /Corrupt PNG: the image data does not inflate: /
      );
    });

    it('should refuse no IDAT at all, and IDAT chunks with something between them', () => {
      refuses(png(ihdr(1, 1), IEND), 'Invalid PNG: there is no IDAT chunk');
      const stream = deflateSync(Uint8Array.of(0, 0));
      refuses(
        png(
          ihdr(1, 1),
          chunk('IDAT', stream.subarray(0, 2)),
          chunk('tEXt', [65, 0]),
          chunk('IDAT', stream.subarray(2)),
          IEND
        ),
        'Invalid PNG: the IDAT chunks are not consecutive'
      );
    });

    it('should refuse a filter type past 4', () => {
      refuses(
        png(ihdr(1, 2), idat([0, 0, 5, 0]), IEND),
        'Corrupt PNG: scanline 1 has filter type 5'
      );
    });

    it('should refuse a palette index the palette does not have', () => {
      const plte = chunk('PLTE', [1, 2, 3, 4, 5, 6]);
      refuses(
        png(ihdr(2, 1, 8, 3), plte, idat([0, 1, 2]), IEND),
        'Corrupt PNG: palette index 2 is outside a palette of 2'
      );
    });

    it('should refuse a critical chunk it does not know', () => {
      refuses(
        png(ihdr(1, 1), chunk('ZZZZ', []), idat([0, 0]), IEND),
        'an unknown critical chunk ZZZZ'
      );
    });

    it('should refuse a PLTE that is missing, repeated, misplaced or the wrong size', () => {
      const plte = chunk('PLTE', [1, 2, 3]);
      refuses(png(ihdr(1, 1, 8, 3), idat([0, 0]), IEND), 'an indexed image with no PLTE chunk');
      refuses(png(ihdr(1, 1, 8, 3), plte, plte, idat([0, 0]), IEND), 'more than one PLTE chunk');
      refuses(png(ihdr(1, 1, 8, 3), idat([0, 0]), plte, IEND), 'the PLTE chunk is out of order');
      refuses(png(ihdr(1, 1, 8, 0), plte, idat([0, 0]), IEND), 'a PLTE chunk in a greyscale image');
      refuses(
        png(ihdr(1, 1, 8, 3), chunk('PLTE', [1, 2]), idat([0, 0]), IEND),
        'a PLTE chunk of 2 bytes'
      );
      refuses(
        png(ihdr(1, 1, 8, 3), chunk('PLTE', []), idat([0, 0]), IEND),
        'a PLTE chunk of 0 bytes'
      );
      refuses(
        png(ihdr(1, 1, 8, 3), chunk('PLTE', new Uint8Array(771)), idat([0, 0]), IEND),
        'a PLTE chunk of 771 bytes'
      );
    });

    it('should refuse a tRNS that is repeated, misplaced, the wrong size, or on an image with alpha', () => {
      const plte = chunk('PLTE', [1, 2, 3]);
      const one = chunk('tRNS', [0]);
      refuses(
        png(ihdr(1, 1, 8, 3), one, plte, idat([0, 0]), IEND),
        'the tRNS chunk is out of order'
      );
      refuses(
        png(ihdr(1, 1, 8, 3), plte, one, one, idat([0, 0]), IEND),
        'more than one tRNS chunk'
      );
      refuses(
        png(ihdr(1, 1, 8, 3), plte, chunk('tRNS', [0, 0]), idat([0, 0]), IEND),
        'a tRNS chunk of 2 entries for a palette of 1'
      );
      refuses(
        png(ihdr(1, 1, 8, 2), chunk('tRNS', [0, 0]), idat([0, 0, 0, 0]), IEND),
        'a tRNS chunk of 2 bytes for colour type 2'
      );
      refuses(
        png(ihdr(1, 1, 8, 6), chunk('tRNS', [0, 0, 0, 0, 0, 0]), idat([0, 0, 0, 0, 0]), IEND),
        'a tRNS chunk in an image that already has alpha'
      );
    });

    it('should refuse a bit depth its colour type does not allow', () => {
      refuses(png(ihdr(1, 1, 4, 2), IEND), 'bit depth 4 is not allowed for colour type 2');
      refuses(png(ihdr(1, 1, 16, 3), IEND), 'bit depth 16 is not allowed for colour type 3');
    });
  });
});
