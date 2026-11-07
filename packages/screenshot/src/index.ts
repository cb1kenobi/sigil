/**
 * Screenshots of a sigil canvas, as SVG or PNG.
 *
 * ```js
 * import { screenshot } from '@ttylabs/screenshot';
 *
 * const svg = screenshot(canvas.snapshot(), { format: 'svg' });
 * ```
 *
 * A package of its own because the font and the rasterizer are about a megabyte
 * together, and an app that never takes a screenshot should pay nothing for
 * them -- the reasoning the config stores follow, for the same constraint.
 */

export {
  BUILTIN_PALETTES,
  type ColorInput,
  type ColorOptions,
  parseColor,
  type ResolvedColors,
  resolveColors,
  type Rgb,
  type TerminalColors,
} from './colors.js';
export { FontError, type Font, type FontMetrics } from './font/truetype.js';
export {
  DEFAULT_FONTS,
  type FontFaces,
  type FontOption,
  type FontSource,
  loadFont,
} from './fonts.js';
export type { CellGrid, ScreenGrid, Shootable, StyleLookup } from './grid.js';
export { DEFAULT_FONT_SIZE, type SizeOptions } from './metrics.js';
export { type RasterOptions, rasterize } from './rasterize.js';
export { DEFAULT_FONT_FAMILY, renderSvg, type SvgOptions } from './svg.js';
export {
  type PngScreenshotOptions,
  screenshot,
  type ScreenshotOptions,
  type SvgScreenshotOptions,
} from './screenshot.js';
export type { RgbaImage } from '@ttylabs/sigil/png';
