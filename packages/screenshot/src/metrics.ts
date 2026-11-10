import type { Font } from './font/truetype.js';

/**
 * How big a cell is, worked out once from the font and the options and shared by
 * both formats -- so an SVG and a PNG of one frame have the same geometry, and a
 * caller switching between them does not find the image a different size.
 */

/** The size options. */
export interface SizeOptions {
  /** The font size in CSS pixels. Defaults to 14. */
  fontSize?: number;
  /**
   * The cell height, as a multiple of the font size. Defaults to the font's own
   * line height -- ascender, descender and line gap -- which is what a terminal
   * sizes its cells from.
   */
  lineHeight?: number;
  /** Space around the grid, in CSS pixels, filled with the background. Defaults to 0. */
  padding?: number;
  /**
   * Device pixels per CSS pixel, as `devicePixelRatio`: `2` is a high-DPI image.
   * A PNG is rendered at it; an SVG is scaled to it, which is the same picture.
   * Defaults to 1.
   */
  scale?: number;
}

/** A cell, in device pixels. */
export interface CellMetrics {
  /** The baseline, down from the top of a cell. */
  baseline: number;
  /** The font size, in device pixels. */
  fontPx: number;
  height: number;
  /** A light line, for box drawing and the tofu box. */
  light: number;
  /** The padding, in device pixels. */
  padding: number;
  /** Device pixels per font unit. */
  unit: number;
  width: number;
}

/** The default font size, which is what most terminals open at. */
export const DEFAULT_FONT_SIZE = 14;

function positive(value: number | undefined, fallback: number, name: string, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) {
    throw new TypeError(
      `Invalid ${name} ${String(value)}: expected a number above 0 and at most ${max}`
    );
  }
  return value;
}

/**
 * Works out the cell.
 *
 * Whole pixels throughout, because a cell that is 8.4 pixels wide puts every
 * other column boundary through the middle of a pixel and box drawing can no
 * longer meet itself. The width is the advance of `0` rounded, the height the
 * line height rounded, and the glyphs are centered in what that leaves: a few
 * tenths of a pixel either way, which is the same trade every terminal makes.
 * Both, and the padding, are rounded at 1x and then scaled.
 *
 * @param font - The regular face.
 * @param opts - The size options.
 * @param scale - Overrides `opts.scale`, which is how an SVG asks for its
 *   unscaled geometry.
 * @returns The cell.
 */
export function cellMetrics(font: Font, opts: SizeOptions, scale?: number): CellMetrics {
  const fontSize = positive(opts.fontSize, DEFAULT_FONT_SIZE, 'fontSize', 1024);
  const factor = scale ?? positive(opts.scale, 1, 'scale', 64);
  const padding = opts.padding ?? 0;
  if (typeof padding !== 'number' || !Number.isFinite(padding) || padding < 0 || padding > 4096) {
    throw new TypeError(`Invalid padding ${String(padding)}: expected 0 to 4096`);
  }

  const { ascender, descender, lineGap, unitsPerEm } = font.metrics;
  const fontPx = fontSize * factor;
  const unit = fontPx / unitsPerEm;
  const zero = font.glyphFor(0x30);
  const advance = font.advance(zero) || font.advance(0) || unitsPerEm / 2;
  // rounded at 1x and then scaled, so a 2x image is exactly twice the 1x one
  // -- which is what keeps a PNG and an SVG of one frame the same size, since
  // an SVG is the 1x geometry scaled. Rounding at the device size instead gives
  // 17 for 2 x 8.4, and the two drift a column apart across a wide frame
  const width = Math.max(1, Math.round(Math.round((advance * fontSize) / unitsPerEm) * factor));
  const natural = (ascender - descender + lineGap) / unitsPerEm;
  const lineHeight = positive(opts.lineHeight, natural, 'lineHeight', 8);
  const height = Math.max(1, Math.round(Math.round(lineHeight * fontSize) * factor));
  const baseline = Math.round((height - (ascender - descender) * unit) / 2 + ascender * unit);

  return {
    baseline,
    fontPx,
    height,
    light: Math.max(1, Math.round(fontPx / 14)),
    padding: Math.round(Math.round(padding) * factor),
    unit,
    width,
  };
}
