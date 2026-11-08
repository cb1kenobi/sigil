import type { Shootable } from './grid.js';
import { rasterize, type RasterOptions } from './rasterize.js';
import { renderSvg, type SvgOptions } from './svg.js';
import { encodePng } from '@ttylabs/sigil/png';

/** An SVG screenshot's options. */
export type SvgScreenshotOptions = SvgOptions & { format?: 'svg' };

/** A PNG screenshot's options. */
export type PngScreenshotOptions = RasterOptions & { format: 'png' };

/** What `screenshot()` takes: a format, and the options that format reads. */
export type ScreenshotOptions = PngScreenshotOptions | SvgScreenshotOptions;

/**
 * Turns a frame into an image.
 *
 * Takes `canvas.snapshot()` -- the frame that is on screen, bound to the styles
 * that painted it -- or a testing `Screen`, which holds characters and no
 * styling and is drawn in the default colours. A canvas into a pipe never
 * presents, so its snapshot is blank: take a screenshot of a canvas that was
 * presented, or of the testing screen.
 *
 * Synchronous: the fonts are read the first time they are asked for and kept,
 * and the PNG is encoded by `@ttylabs/sigil/png`. `await` on it is harmless,
 * which is how the examples read.
 *
 * @param input - The frame.
 * @param options - The format, colours, font and size.
 * @returns The SVG document as a string, or the PNG's bytes.
 */
export function screenshot(input: Shootable, options: PngScreenshotOptions): Uint8Array;
export function screenshot(input: Shootable, options?: SvgScreenshotOptions): string;
export function screenshot(input: Shootable, options?: ScreenshotOptions): string | Uint8Array;
export function screenshot(input: Shootable, options: ScreenshotOptions = {}): string | Uint8Array {
  const format = options.format ?? 'svg';
  if (format === 'svg') {
    return renderSvg(input, options);
  }
  if (format === 'png') {
    return encodePng(rasterize(input, options));
  }
  throw new TypeError(`Invalid format ${JSON.stringify(format)}: expected 'svg' or 'png'`);
}
