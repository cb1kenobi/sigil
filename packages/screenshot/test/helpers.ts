import { ATTR, type CellBuffer, createCanvas, palette, rgb } from '@ttylabs/sigil/canvas';
import { decodePng, encodePng, type RgbaImage } from '@ttylabs/sigil/png';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';

/** Where the golden files live. */
export const GOLDEN: string = join(import.meta.dirname, 'golden');

/**
 * A frame painted and presented, as a screenshot is taken of one: through
 * `canvas.snapshot()`, which is what binds the grid to its styles.
 */
export function frame(
  width: number,
  height: number,
  draw: Parameters<ReturnType<typeof createCanvas>['paint']>[0]
): CellBuffer {
  const canvas = createCanvas({ height, width });
  canvas.paint(draw);
  canvas.present();
  return canvas.snapshot();
}

/**
 * The frame the golden files are of: every kind of thing a screenshot draws,
 * once -- line drawing in all four weights, blocks, braille, the sixteen and a
 * truecolour ramp, every attribute, a wide character the font lacks, a link.
 */
export function showcase(): CellBuffer {
  return frame(40, 12, (p) => {
    p.text(0, 0, '╭────────╮ ┏━━━━┓ ╔══╦══╗ ┌─┬─┐', { fg: palette(6) });
    p.text(0, 1, '│', { fg: palette(6) });
    p.text(2, 1, 'sigil', { attrs: ATTR.bold, fg: palette(5) });
    p.text(9, 1, '│ ┃ ok ┃ ║  ║  ║ ├─┼─┤', { fg: palette(6) });
    p.text(0, 2, '╰────────╯ ┗━━━━┛ ╚══╩══╝ └─┴─┘', { fg: palette(6) });
    p.text(0, 3, 'bold', { attrs: ATTR.bold });
    p.text(5, 3, 'italic', { attrs: ATTR.italic });
    p.text(12, 3, 'both', { attrs: ATTR.bold | ATTR.italic });
    p.text(17, 3, 'under', { attrs: ATTR.underline });
    p.text(23, 3, 'strike', { attrs: ATTR.strikethrough });
    p.text(30, 3, 'dim', { attrs: ATTR.dim });
    p.text(34, 3, 'inv', { attrs: ATTR.inverse });
    for (let i = 0; i < 16; i++) {
      p.text(i * 2, 4, '██', { fg: palette(i) });
    }
    p.text(0, 5, '▀▄█▌▐░▒▓▖▗▘▙▚▛▜▝▞▟ ▁▂▃▄▅▆▇█ ⣿⠿⡇⢸', { fg: palette(2) });
    for (let x = 0; x < 40; x++) {
      p.text(x, 6, '▀', { bg: rgb(0, x * 6, 40), fg: rgb(x * 6, 0, 255 - x * 6) });
    }
    p.text(0, 7, '漢字 <&> "quotes" ╱╲╳ ┄┅ ╌', { bg: rgb(40, 40, 90), fg: rgb(255, 180, 0) });
    p.text(0, 8, 'a link', {
      attrs: ATTR.underline,
      fg: palette(4),
      link: 'https://example.com/?a=1&b=2',
    });
    p.text(7, 8, 'hidden', { attrs: ATTR.hidden, bg: palette(1) });
    p.text(14, 8, 'overline', { attrs: ATTR.overline });
    p.text(0, 9, 'The quick brown fox jumps over the dog.');
    p.text(0, 10, '0123456789 {}[]()<>=!-+*/\\|&^%$#@~`');
    p.text(0, 11, '╒═╤═╕ ╓─╥─╖ ╞═╪═╡ ╟─╫─╢ ╭╮╰╯', { fg: palette(3) });
  });
}

/**
 * Compares against a golden file, writing it when it is missing or when
 * `SIGIL_UPDATE_GOLDEN` is set -- and never in CI, where a missing golden is a
 * failure rather than a fresh one.
 *
 * A string is compared as text with line endings normalized, since a checkout
 * may have converted them; an image is compared as decoded pixels rather than
 * as PNG bytes, because the claim is what the screenshot looks like and the
 * encoder is `@ttylabs/sigil/png`'s to change.
 */
export function golden(name: string, actual: RgbaImage | string): void {
  const path = join(GOLDEN, name);
  const update = process.env.SIGIL_UPDATE_GOLDEN === '1' || (!existsSync(path) && !process.env.CI);
  if (update) {
    writeFileSync(path, typeof actual === 'string' ? actual : encodePng(actual));
  }
  expect(existsSync(path), `${name} is missing: run with SIGIL_UPDATE_GOLDEN=1`).toBe(true);
  if (typeof actual === 'string') {
    expect(actual).toBe(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'));
    return;
  }
  const expected = decodePng(readFileSync(path));
  expect([actual.width, actual.height]).toEqual([expected.width, expected.height]);
  // compared as a count rather than with `toEqual`, which would print a million
  // numbers on a failure
  let differ = 0;
  for (let i = 0; i < actual.data.length; i++) {
    if (actual.data[i] !== expected.data[i]) {
      differ++;
    }
  }
  expect(differ, `${differ} bytes differ from ${name}`).toBe(0);
}

/** The colour of one pixel. */
export function pixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}
