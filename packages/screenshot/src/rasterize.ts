import { cellColors, type ColorOptions, resolveColors, type Rgb } from './colors.js';
import { type Coverage, rasterizeOutline } from './font/raster.js';
import type { Font } from './font/truetype.js';
import { type FontOption, type LoadedFaces, loadFaces } from './fonts.js';
import { type CellBox, CoveragePen, drawGeometry, drawTofu, isGeometry } from './geometry.js';
import { readShot, type Shootable, type ShotCell, type StyleLookup } from './grid.js';
import { type CellMetrics, cellMetrics, type SizeOptions } from './metrics.js';
import { ATTR } from '@ttylabs/sigil/canvas';
import type { RgbaImage } from '@ttylabs/sigil/png';

/**
 * Drawing a frame into pixels: the PNG half, short of the encoding.
 *
 * Three passes over the grid, in the order a terminal paints: every background,
 * then every glyph, then the lines -- underline, strikethrough, overline. Glyphs
 * after backgrounds, rather than cell by cell, so an italic or a fallback glyph
 * that overhangs its cell is not painted over by its neighbour's background,
 * which is what a terminal shows as well.
 */

/** Everything a raster screenshot takes. */
export interface RasterOptions extends ColorOptions, SizeOptions {
  /** The font to draw with. Defaults to the bundled JetBrains Mono. */
  font?: FontOption;
  /** What resolves the style indices of a grid `canvas.snapshot()` did not make. */
  styles?: StyleLookup;
}

/** The most pixels an image may have: 256 megapixels, a gigabyte of RGBA. */
const MAX_PIXELS = 1 << 28;

/** How far a synthesized italic leans: about 11°, as a slope rather than an angle. */
const ITALIC_SHEAR = 0.2;

/** How far a synthesized bold is smeared, as a fraction of the font size. */
const EMBOLDEN = 0.04;

/** What dim draws a foreground at, out of 255. */
const DIM = 128;

/** Code points that change how a cluster looks rather than adding to it. */
const INVISIBLE = new Set([0x20_0d, 0xfe_0e, 0xfe_0f]);

/** A face as it is drawn: the font and whatever it has to synthesize. */
interface Face {
  bold: boolean;
  font: Font;
  /** Which face this is, for the glyph cache's key. */
  id: number;
  italic: boolean;
}

/**
 * Picks the face for a style, synthesizing what the font set lacks.
 *
 * A bold italic with no face of its own is the bold sheared if there is a bold,
 * else the italic smeared, else the regular with both: always from the nearest
 * real design, because a synthetic attribute is an approximation of one.
 */
function faceFor(faces: LoadedFaces, attrs: number): Face {
  const bold = (attrs & ATTR.bold) !== 0;
  const italic = (attrs & ATTR.italic) !== 0;
  if (bold && italic) {
    if (faces.boldItalic) {
      return { bold: false, font: faces.boldItalic, id: 3, italic: false };
    }
    if (faces.bold) {
      return { bold: false, font: faces.bold, id: 1, italic: true };
    }
    if (faces.italic) {
      return { bold: true, font: faces.italic, id: 2, italic: false };
    }
    return { bold: true, font: faces.regular, id: 0, italic: true };
  }
  if (bold) {
    return faces.bold
      ? { bold: false, font: faces.bold, id: 1, italic: false }
      : { bold: true, font: faces.regular, id: 0, italic: false };
  }
  if (italic) {
    return faces.italic
      ? { bold: false, font: faces.italic, id: 2, italic: false }
      : { bold: false, font: faces.regular, id: 0, italic: true };
  }
  return { bold: false, font: faces.regular, id: 0, italic: false };
}

/** One pixel, `a` of the way from what is there to `color`, out of 255. */
function blend(image: RgbaImage, x: number, y: number, color: Rgb, a: number): void {
  if (a <= 0 || x < 0 || y < 0 || x >= image.width || y >= image.height) {
    return;
  }
  const i = (y * image.width + x) * 4;
  const d = image.data;
  if (a >= 255) {
    d[i] = color.r;
    d[i + 1] = color.g;
    d[i + 2] = color.b;
    return;
  }
  const keep = 255 - a;
  d[i] = Math.floor((d[i] * keep + color.r * a + 127) / 255);
  d[i + 1] = Math.floor((d[i + 1] * keep + color.g * a + 127) / 255);
  d[i + 2] = Math.floor((d[i + 2] * keep + color.b * a + 127) / 255);
}

function fillRect(image: RgbaImage, x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
  for (let y = Math.max(0, y0); y < Math.min(image.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(image.width, x1); x++) {
      const i = (y * image.width + x) * 4;
      image.data[i] = c.r;
      image.data[i + 1] = c.g;
      image.data[i + 2] = c.b;
      image.data[i + 3] = 255;
    }
  }
}

/** Lays a coverage bitmap onto the image in a colour, at a strength out of 255. */
function stamp(
  image: RgbaImage,
  cover: Coverage,
  x: number,
  y: number,
  color: Rgb,
  strength: number
): void {
  for (let row = 0; row < cover.height; row++) {
    for (let column = 0; column < cover.width; column++) {
      const c = cover.data[row * cover.width + column];
      if (c !== 0) {
        blend(
          image,
          x + cover.left + column,
          y + cover.top + row,
          color,
          ((c * strength + 127) / 255) | 0
        );
      }
    }
  }
}

/**
 * Draws a frame into pixels.
 *
 * The image is opaque: every pixel is a cell's background, the padding's, or a
 * glyph blended over one. Deterministic, so the same frame and options give the
 * same bytes on every machine -- which is what a golden file or a visual
 * regression test compares.
 *
 * @param input - A `canvas.snapshot()`, or a testing `Screen`.
 * @param options - Colours, font and size.
 * @returns The image.
 */
export function rasterize(input: Shootable, options: RasterOptions = {}): RgbaImage {
  const shot = readShot(input, options.styles);
  const colors = resolveColors(options);
  const faces = loadFaces(options.font);
  const metrics = cellMetrics(faces.regular, options);

  const width = shot.width * metrics.width + metrics.padding * 2;
  const height = shot.height * metrics.height + metrics.padding * 2;
  if (width * height > MAX_PIXELS) {
    throw new RangeError(`A screenshot of ${width}x${height} pixels is too large to draw`);
  }
  const image: RgbaImage = { data: new Uint8Array(width * height * 4), height, width };
  fillRect(image, 0, 0, width, height, colors.background);

  const origin = (index: number): [number, number] => [
    metrics.padding + (index % shot.width) * metrics.width,
    metrics.padding + Math.floor(index / shot.width) * metrics.height,
  ];
  /** The lead of a continuation, whose style both halves are drawn in. */
  const owner = (index: number): ShotCell => {
    const cell = shot.cells[index];
    if (cell.width === 0 && index % shot.width > 0) {
      const lead = shot.cells[index - 1];
      if (lead.width === 2) {
        return lead;
      }
    }
    return cell;
  };

  // backgrounds
  for (let i = 0; i < shot.cells.length; i++) {
    const { bg } = cellColors(owner(i).style, colors);
    const [x, y] = origin(i);
    fillRect(image, x, y, x + metrics.width, y + metrics.height, bg);
  }

  const glyphs = new GlyphCache(faces, metrics);

  // glyphs
  for (let i = 0; i < shot.cells.length; i++) {
    const cell = shot.cells[i];
    if (cell.width === 0 || cell.char === ' ' || cell.char === '') {
      continue;
    }
    const { attrs } = cell.style;
    if (attrs & ATTR.hidden) {
      continue;
    }
    const { fg } = cellColors(cell.style, colors);
    const strength = attrs & ATTR.dim ? DIM : 255;
    const [x, y] = origin(i);
    for (const cover of glyphs.cluster(cell.char, attrs, cell.width)) {
      stamp(image, cover, x, y, fg, strength);
    }
  }

  // the lines
  const font = faces.regular.metrics;
  const thickness = (units: number): number => Math.max(1, Math.round(units * metrics.unit));
  const under = thickness(font.underlineThickness);
  const strike = thickness(font.strikeoutSize);
  const underTop = Math.min(
    metrics.height - under,
    metrics.baseline - Math.round(font.underlinePosition * metrics.unit)
  );
  const strikeTop = metrics.baseline - Math.round(font.strikeoutPosition * metrics.unit);
  for (let i = 0; i < shot.cells.length; i++) {
    const cell = shot.cells[i];
    const { attrs } = cell.style;
    if (cell.width === 0 || attrs & ATTR.hidden) {
      continue;
    }
    if (!(attrs & (ATTR.underline | ATTR.strikethrough | ATTR.overline))) {
      continue;
    }
    const { fg } = cellColors(cell.style, colors);
    const strength = attrs & ATTR.dim ? DIM : 255;
    const [x, y] = origin(i);
    const right = x + metrics.width * cell.width;
    const line = (top: number, size: number): void => {
      for (let row = Math.max(0, top); row < Math.min(metrics.height, top + size); row++) {
        for (let column = x; column < right; column++) {
          blend(image, column, y + row, fg, strength);
        }
      }
    };
    if (attrs & ATTR.underline) {
      line(underTop, under);
    }
    if (attrs & ATTR.strikethrough) {
      line(strikeTop, strike);
    }
    if (attrs & ATTR.overline) {
      line(0, under);
    }
  }

  return image;
}

/**
 * Rasterized glyphs, kept for the length of one screenshot.
 *
 * A frame repeats a few dozen characters across thousands of cells, so the
 * outline is drawn once per character and face and stamped wherever it appears.
 * The coverage is positioned relative to the cell's top-left, so a cached glyph
 * is the same bitmap in every cell.
 */
class GlyphCache {
  #faces: LoadedFaces;
  #metrics: CellMetrics;
  #glyphs = new Map<string, Coverage | undefined>();
  #shapes = new Map<string, Coverage>();

  constructor(faces: LoadedFaces, metrics: CellMetrics) {
    this.#faces = faces;
    this.#metrics = metrics;
  }

  /** Everything a cluster draws, in order: its base, then its marks. */
  cluster(cluster: string, attrs: number, span: number): Coverage[] {
    const points = [...cluster].map((c) => c.codePointAt(0) ?? 0);
    const base = points[0];
    if (isGeometry(base)) {
      return [this.#shape(base, span)];
    }
    const face = faceFor(this.#faces, attrs);
    const found = this.#find(base, face);
    if (!found) {
      return [this.#tofu(span)];
    }
    const out: Coverage[] = [];
    const add = (font: Face, glyph: number): void => {
      const cover = this.#glyph(font, glyph, span);
      if (cover) {
        out.push(cover);
      }
    };
    add(found.face, found.glyph);
    for (const mark of points.slice(1)) {
      if (INVISIBLE.has(mark)) {
        continue;
      }
      // a mark is looked for in the face its base was found in, and dropped if
      // it is not there: a mark from another font sits at another font's height
      const glyph = found.face.font.glyphFor(mark);
      if (glyph !== 0) {
        add(found.face, glyph);
      }
    }
    return out;
  }

  /** The face that has a character: the styled one, then each fallback. */
  #find(codePoint: number, face: Face): { face: Face; glyph: number } | undefined {
    const glyph = face.font.glyphFor(codePoint);
    if (glyph !== 0) {
      return { face, glyph };
    }
    for (const [i, font] of this.#faces.fallback.entries()) {
      const fallback = font.glyphFor(codePoint);
      if (fallback !== 0) {
        // the fallback has no faces of its own, so the style is synthesized
        const weight =
          face.bold || face.font === this.#faces.bold || face.font === this.#faces.boldItalic;
        const slant =
          face.italic || face.font === this.#faces.italic || face.font === this.#faces.boldItalic;
        return { face: { bold: weight, font, id: 10 + i, italic: slant }, glyph: fallback };
      }
    }
    return undefined;
  }

  #glyph(face: Face, glyph: number, span: number): Coverage | undefined {
    const key = `${face.id}:${glyph}:${face.bold ? 1 : 0}:${face.italic ? 1 : 0}:${span}`;
    if (this.#glyphs.has(key)) {
      return this.#glyphs.get(key);
    }
    const m = this.#metrics;
    const advance = face.font.advance(glyph) * m.unit;
    const cover = rasterizeOutline(face.font.outline(glyph), {
      embolden: face.bold ? m.fontPx * EMBOLDEN : 0,
      scale: m.unit,
      shear: face.italic ? ITALIC_SHEAR : 0,
      x: (m.width * span - advance) / 2,
    });
    // positioned against the cell's top rather than the baseline
    const placed = cover ? { ...cover, top: cover.top + m.baseline } : undefined;
    this.#glyphs.set(key, placed);
    return placed;
  }

  #shape(codePoint: number, span: number): Coverage {
    const key = `${codePoint}:${span}`;
    let cover = this.#shapes.get(key);
    if (!cover) {
      const m = this.#metrics;
      const box: CellBox = { height: m.height, light: m.light, width: m.width * span };
      const pen = new CoveragePen(box.width, box.height);
      drawGeometry(codePoint, box, pen);
      cover = { data: pen.data, height: box.height, left: 0, top: 0, width: box.width };
      this.#shapes.set(key, cover);
    }
    return cover;
  }

  #tofu(span: number): Coverage {
    const key = `tofu:${span}`;
    let cover = this.#shapes.get(key);
    if (!cover) {
      const m = this.#metrics;
      const box: CellBox = { height: m.height, light: m.light, width: m.width * span };
      const pen = new CoveragePen(box.width, box.height);
      drawTofu(box, pen);
      cover = { data: pen.data, height: box.height, left: 0, top: 0, width: box.width };
      this.#shapes.set(key, cover);
    }
    return cover;
  }
}
