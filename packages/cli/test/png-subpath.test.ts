import * as png from '@ttylabs/sigil/png';
import { describe, expect, it } from 'vitest';

/**
 * `@ttylabs/sigil/png` through its published name, which is how the screenshot
 * package reaches it: the runtime's own tests import `src/` through vite and
 * say nothing about the `exports` map or the bundle -- and the bundle is where
 * the control-character escape pass runs over a module whose signature is
 * three control bytes.
 */

function gradient(width: number, height: number): png.RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data.set([i & 0xff, (i * 7) & 0xff, (i * 13) & 0xff, 255 - (i & 0x7f)], i * 4);
  }
  return { data, height, width };
}

describe('@ttylabs/sigil/png', () => {
  it('should publish the codec and nothing else', () => {
    expect(Object.keys(png).sort()).toEqual(['MAX_PIXELS', 'decodePng', 'encodePng']);
  });

  it('should round-trip through the bundle, signature and all', () => {
    const image = gradient(40, 30);
    const bytes = png.encodePng(image);
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const back = png.decodePng(bytes);
    expect([back.width, back.height]).toEqual([40, 30]);
    expect(back.data).toEqual(image.data);
  });

  it('should refuse a damaged file with the sentence the source throws', () => {
    const bytes = png.encodePng(gradient(4, 4));
    // the last byte of IHDR's data, so its CRC no longer matches
    bytes[8 + 8 + 12] ^= 1;
    expect(() => png.decodePng(bytes)).toThrow(
      'Corrupt PNG: the CRC of the IHDR chunk does not match its data'
    );
  });
});
