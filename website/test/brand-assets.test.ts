import { APP_ICONS, brandAssets, faviconFrames, lockupSvg } from '../scripts/brand-assets.ts';
import { decodeIco, decodePng, hex } from '../scripts/lib/raster.ts';
import { readFont } from '../scripts/lib/sfnt.ts';
import manifest from '../src/app/manifest.ts';
import { BG, BRAND, FG, FG_STRONG, ICON_GROUND, MUTED } from '../src/lib/brand.ts';
import { SEAL_PATH, sealGrid } from '../src/lib/seal.ts';
import { woff2ToSfnt } from '../src/lib/woff2.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path));
const pixel = (image: { width: number; data: Uint8Array }, x: number, y: number) =>
  Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4));

describe('the seal', () => {
  it('is the 7 by 7 block with the channel carved out that SIG-102 drew', () => {
    const rows = sealGrid().map((row) => row.map((cell) => (cell ? '#' : '.')).join(''));
    assert.deepEqual(rows, [
      '#######',
      '#....##',
      '#.#####',
      '#.....#',
      '#####.#',
      '##....#',
      '#######',
    ]);
  });
});

describe('the brand files', () => {
  for (const { path, contents } of brandAssets()) {
    it(`should have ${path} exactly as scripts/brand-assets.ts writes it`, () => {
      const committed = read(path);
      if (typeof contents === 'string') {
        assert.equal(committed.toString('utf8'), contents);
      } else if (path.endsWith('.ico')) {
        // compared as pixels: the deflate stream is zlib's to choose, and a
        // different zlib is not a different icon
        assert.deepEqual(decodeIco(committed), decodeIco(contents));
      } else {
        assert.deepEqual(decodePng(committed), decodePng(contents));
      }
    });
  }

  it('should carry the seal in icon.svg as the one SEAL_PATH', () => {
    const svg = read('src/app/icon.svg').toString('utf8');
    assert.ok(svg.includes(`d="${SEAL_PATH}"`));
    assert.ok(svg.includes(`fill="${BRAND}"`));
    assert.ok(svg.includes('shape-rendering="crispEdges"'));
  });

  it('should have a favicon of 16, 32 and 48 px', () => {
    assert.deepEqual(
      decodeIco(read('src/app/favicon.ico')).map((frame) => frame.width),
      [16, 32, 48]
    );
  });

  it('should keep the channel open in the 16 px favicon, which is the 14 px seal with a 1 px margin', () => {
    const [frame] = faviconFrames();
    const ink = [...hex(BRAND)];
    const clear = [0, 0, 0, 0];
    // the margin
    for (let i = 0; i < 16; i++) {
      assert.deepEqual(pixel(frame, i, 0), clear);
      assert.deepEqual(pixel(frame, 0, i), clear);
      assert.deepEqual(pixel(frame, i, 15), clear);
      assert.deepEqual(pixel(frame, 15, i), clear);
    }
    // each cell is 2 px: the first channel cell is column 1, row 1, and a
    // channel two cells wide would mean a smudge here, not a gap
    assert.deepEqual(pixel(frame, 1 + 2, 1 + 2), clear);
    assert.deepEqual(pixel(frame, 1 + 2 * 4, 1 + 2 * 1), clear);
    assert.deepEqual(pixel(frame, 1 + 2 * 4, 1 + 2 * 2), ink);
    // and every channel cell and its neighbour is exactly one cell of ink or gap
    const grid = sealGrid();
    grid.forEach((row, r) =>
      row.forEach((on, c) => {
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          assert.deepEqual(pixel(frame, 1 + c * 2 + dx, 1 + r * 2 + dy), on ? ink : clear);
        }
      })
    );
  });

  it('should put the seal at about half the width of each app icon, on whole pixels, on the avatar ground', () => {
    for (const { path, size, seal } of APP_ICONS) {
      const image = decodePng(read(path));
      assert.equal(image.width, size);
      assert.equal(image.height, size);
      assert.equal(seal % 7, 0);
      assert.ok(Math.abs(seal / size - 0.5) < 0.04, `${path}: ${seal}/${size}`);
      assert.deepEqual(pixel(image, 0, 0), [...hex(ICON_GROUND)]);
      assert.deepEqual(pixel(image, size - 1, size - 1), [...hex(ICON_GROUND)]);
      assert.deepEqual(pixel(image, size / 2, (size - seal) / 2), [...hex(BRAND)]);
    }
  });

  it('should point the manifest at icons that exist, at the sizes it says', () => {
    const { icons, theme_color, background_color } = manifest();
    assert.equal(theme_color, BG);
    assert.equal(background_color, BG);
    assert.ok(icons?.length);
    for (const icon of icons ?? []) {
      const image = decodePng(read(`public${icon.src}`));
      assert.equal(`${image.width}x${image.height}`, icon.sizes);
    }
  });
});

describe('the lockup', () => {
  it('should be outlined, so that no font has to be installed to draw it', () => {
    for (const color of [FG_STRONG, '#17161d']) {
      const svg = lockupSvg(color);
      assert.ok(!/<text|font-family/.test(svg));
      assert.ok(svg.includes(`fill="${color}"`));
    }
  });
});

describe('the colours copied out of the stylesheet', () => {
  const css = read('src/app/globals.css').toString('utf8');
  const token = (name: string) =>
    new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(css)?.[1];

  it('should still be what globals.css says they are', () => {
    assert.equal(token('bg'), BG);
    assert.equal(token('terminal'), ICON_GROUND);
    assert.equal(token('brand'), BRAND);
    assert.equal(token('fg-strong'), FG_STRONG);
    assert.equal(token('fg'), FG);
    assert.equal(token('muted'), MUTED);
  });
});

describe('woff2 decoding', () => {
  const fonts = [
    'barlow-semi-condensed-latin-600',
    'instrument-sans-latin',
    'jetbrains-mono-latin-400',
    'martian-mono-latin-500',
  ];

  for (const name of fonts) {
    it(`should turn ${name} into a font with outlines for the letters of "sigil"`, () => {
      const font = readFont(woff2ToSfnt(read(`src/fonts/${name}.woff2`)));
      for (const char of 'sigil') {
        const glyph = font.glyphIndex(char.codePointAt(0)!);
        assert.ok(glyph > 0, `${name} has no ${char}`);
        assert.ok(font.outline(glyph).startsWith('M'), `${name}: ${char} has no outline`);
      }
    });
  }

  it('should give Martian Mono the same advance for every letter, which is what makes it mono', () => {
    const font = readFont(woff2ToSfnt(read('src/fonts/martian-mono-latin-500.woff2')));
    const advances = new Set(
      [...'sigil'].map((c) => font.advance(font.glyphIndex(c.codePointAt(0)!)))
    );
    assert.equal(advances.size, 1);
  });

  it('should refuse what is not a woff2 file', () => {
    assert.throws(() => woff2ToSfnt(new Uint8Array(64)), /not a woff2 file/);
  });

  it('should leave out the variation tables when asked for the default instance', () => {
    const bytes = read('src/fonts/instrument-sans-latin.woff2');
    const tags = (sfnt: Uint8Array) => {
      const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
      return Array.from({ length: view.getUint16(4) }, (_, i) =>
        String.fromCharCode(...sfnt.subarray(12 + i * 16, 16 + i * 16))
      );
    };
    assert.ok(tags(woff2ToSfnt(bytes)).includes('fvar'));
    assert.ok(!tags(woff2ToSfnt(bytes, { default: true })).includes('fvar'));
  });
});
