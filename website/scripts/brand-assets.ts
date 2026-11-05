import { BRAND, FG_STRONG, ICON_GROUND, INK } from '../src/lib/brand.ts';
import { SEAL_CELLS, SEAL_PATH } from '../src/lib/seal.ts';
import { woff2ToSfnt } from '../src/lib/woff2.ts';
import { encodeIco, encodePng, hex, sealImage } from './lib/raster.ts';
import { readFont } from './lib/sfnt.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Writes the site's brand files from the seal's geometry and the vendored
 * Martian Mono, so they can be regenerated rather than redrawn:
 *
 *   node scripts/brand-assets.ts
 *
 * | File                                | What                                          |
 * | ----------------------------------- | --------------------------------------------- |
 * | `src/app/icon.svg`                  | The seal in the brand colour, transparent     |
 * | `src/app/favicon.ico`               | 16, 32 and 48 px, transparent                 |
 * | `src/app/apple-icon.png`            | 180 px on the avatar ground                   |
 * | `public/icon-192.png`, `icon-512.png` | The manifest's, same treatment              |
 * | `public/brand/sigil-lockup-*.svg`   | Seal and wordmark, the wordmark outlined      |
 *
 * `test/brand-assets.test.ts` calls `brandAssets()` and compares it with what
 * is committed, so editing the seal without running this fails a test.
 *
 * ## Why the PNGs are stamped and not rendered
 *
 * An SVG rasteriser anti-aliases, and the seal is whole cells. At 16 px the
 * seal is 14 px: each cell is 2 px, and the channel is one cell wide, so one
 * pixel of blur either side of it closes the channel into a smudge. Stamping
 * the cells is exact, and it needs no image library. See `lib/raster.ts`.
 */

const ROOT = join(import.meta.dirname, '..');

/** A file's path from the package root, and what it should hold. */
export type Asset = { path: string; contents: Buffer | string };

/** The seal on its own, as a static file for Next's `icon.svg` convention. */
export function iconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SEAL_CELLS} ${SEAL_CELLS}" shape-rendering="crispEdges">\n  <path fill="${BRAND}" fill-rule="evenodd" d="${SEAL_PATH}"/>\n</svg>\n`;
}

/**
 * The favicon's frames: the seal at 14, 28 and 42 px, each with a margin of
 * 1, 2 and 3 px. The 16 px one is "the 14 px seal with a 1 px margin" (SIG-102).
 */
export function faviconFrames() {
  return [16, 32, 48].map((size) => sealImage(size, size * (7 / 8), hex(BRAND), null));
}

/** The seal at about half the icon's width, on the avatar's ground. */
export const APP_ICONS = [
  { path: 'src/app/apple-icon.png', size: 180, seal: 84 },
  { path: 'public/icon-192.png', size: 192, seal: 98 },
  { path: 'public/icon-512.png', size: 512, seal: 252 },
];

/**
 * The wordmark, outlined, beside the seal.
 *
 * The geometry is the canvas's lockup at display size (SIG-102): the seal as
 * tall as the font size, the word set in Martian Mono 500 at that size with a
 * letter-spacing of -0.04em, and a gap of about a quarter of the seal between
 * them. The line box is the font size, so the baseline sits where CSS puts it
 * for `line-height: 1`.
 *
 * `height` is the seal's side, a multiple of 7 so that its cells land on whole
 * units. The viewBox is cut to the ink, which is taller than the seal at the
 * bottom: the `g` has a descender.
 */
export function lockupSvg(wordColor: string, height = 112, gap = 32): string {
  const font = readFont(
    woff2ToSfnt(readFileSync(join(ROOT, 'src/fonts/martian-mono-latin-500.woff2')))
  );
  const scale = height / font.unitsPerEm;
  const baseline = (height - (font.ascender - font.descender) * scale) / 2 + font.ascender * scale;
  const tracking = -0.04 * height;

  let pen = height + gap;
  let right = 0;
  let top = 0;
  let bottom = height;
  const outlines: string[] = [];
  for (const char of 'sigil') {
    const glyph = font.glyphIndex(char.codePointAt(0)!);
    const x = pen;
    outlines.push(font.outline(glyph, (px, py) => [x + px * scale, baseline - py * scale]));
    const box = font.box(glyph);
    if (box) {
      right = Math.max(right, x + box[2] * scale);
      top = Math.min(top, baseline - box[3] * scale);
      bottom = Math.max(bottom, baseline - box[1] * scale);
    }
    pen += font.advance(glyph) * scale + tracking;
  }

  const fix = (v: number) => Math.round(v * 100) / 100;
  const y = Math.floor(top);
  const width = Math.ceil(right);
  const h = Math.ceil(bottom) - y;
  const cell = height / SEAL_CELLS;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${y} ${width} ${h}" width="${width}" height="${h}" role="img" aria-labelledby="title">`,
    '  <title id="title">sigil</title>',
    `  <path transform="scale(${fix(cell)})" fill="${BRAND}" fill-rule="evenodd" shape-rendering="crispEdges" d="${SEAL_PATH}"/>`,
    `  <path fill="${wordColor}" d="${outlines.join('')}"/>`,
    '</svg>',
    '',
  ].join('\n');
}

/** Every file this script owns, as the bytes it would write. */
export function brandAssets(): Asset[] {
  return [
    { path: 'src/app/icon.svg', contents: iconSvg() },
    { path: 'src/app/favicon.ico', contents: encodeIco(faviconFrames()) },
    ...APP_ICONS.map(({ path, size, seal }) => ({
      path,
      contents: encodePng(sealImage(size, seal, hex(BRAND), hex(ICON_GROUND))),
    })),
    // the word is the page's own `--color-fg-strong` on the site's dark ground, and the
    // ink colour on a light one; neither file paints a background of its own
    { path: 'public/brand/sigil-lockup-dark.svg', contents: lockupSvg(FG_STRONG) },
    { path: 'public/brand/sigil-lockup-light.svg', contents: lockupSvg(INK) },
  ];
}

if (import.meta.main) {
  for (const { path, contents } of brandAssets()) {
    writeFileSync(join(ROOT, path), contents);
    console.log(`wrote ${path}`);
  }
}
