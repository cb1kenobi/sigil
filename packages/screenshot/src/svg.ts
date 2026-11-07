import {
  cellColors,
  type ColorOptions,
  type ResolvedColors,
  resolveColors,
  type Rgb,
  sameColor,
  toHex,
} from './colors.js';
import { type FontOption, loadFaces } from './fonts.js';
import { type CellBox, type Contour, drawGeometry, isGeometry, type Pen } from './geometry.js';
import { readShot, type Shootable, type StyleLookup } from './grid.js';
import { cellMetrics, type SizeOptions } from './metrics.js';
import { ATTR, type Style } from '@ttylabs/sigil/canvas';

/**
 * A frame as SVG: text the viewer draws, over rectangles.
 *
 * No rasterizer. Text is `<text>` in a monospace font stack and the viewer's
 * own font draws it -- which is the point of an SVG in a README: it is crisp at
 * every zoom, its text can be selected and searched, and it is a few kilobytes.
 * What the viewer's font cannot be trusted with is drawn as geometry instead:
 * box drawing, block elements and braille are the same rectangles and paths the
 * PNG path draws, so a box meets itself whichever font the reader has.
 *
 * Each run of text carries a `textLength`, so a viewer whose fallback font has a
 * different advance still puts the run in the columns it occupies rather than
 * letting it drift across the row.
 */

/** Everything an SVG screenshot takes. */
export interface SvgOptions extends ColorOptions, SizeOptions {
  /**
   * The font whose metrics size the cells. An SVG does not draw with it -- the
   * viewer does -- but the grid is laid out to it, so the SVG and the PNG of one
   * frame are the same size. Defaults to the bundled JetBrains Mono.
   */
  font?: FontOption;
  /** The CSS font stack the text is set in. */
  fontFamily?: string;
  /** What resolves the style indices of a grid `canvas.snapshot()` did not make. */
  styles?: StyleLookup;
}

/** The font stack, with the bundled face first so a reader who has it gets it. */
export const DEFAULT_FONT_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

/** The schemes a link may keep, because an SVG opened in a browser runs what it is handed. */
const SAFE_LINK = /^(?:https?|mailto|ftp|file):/i;

/** What a link's target must not hold, beyond what a style already refused. */
const LINK_UNSAFE = /[\s"'<>`]/;

/**
 * Text, escaped for an element's content.
 *
 * `&`, `<` and `>` are the three that change what the document means. A
 * character XML 1.0 cannot hold at all -- a lone surrogate, `U+FFFE` and
 * `U+FFFF`, and the controls a cell should never carry -- is replaced with
 * `U+FFFD`, because one such character makes the whole file unparseable and no
 * escape exists for it.
 */
export function escapeText(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '&') {
      out += '&amp;';
    } else if (char === '<') {
      out += '&lt;';
    } else if (char === '>') {
      out += '&gt;';
    } else if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0xd8_00 && code <= 0xdf_ff) ||
      code === 0xff_fe ||
      code === 0xff_ff
    ) {
      out += '�';
    } else {
      out += char;
    }
  }
  return out;
}

/** Text, escaped for a double-quoted attribute. */
export function escapeAttribute(text: string): string {
  return escapeText(text).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

/**
 * A number for an attribute: three decimals at most, no trailing zeros, and
 * never `-0`, so equal geometry is always the same bytes.
 */
function num(value: number): string {
  const fixed = Number(value.toFixed(3));
  return Object.is(fixed, -0) ? '0' : String(fixed);
}

/** The colours and attributes a run of text is drawn with. */
function textKey(style: Style, fg: Rgb): string {
  const attrs =
    style.attrs &
    (ATTR.bold | ATTR.italic | ATTR.underline | ATTR.strikethrough | ATTR.overline | ATTR.dim);
  return `${toHex(fg)}|${attrs}|${style.link}`;
}

/** A pen that writes `<rect>` and `<path>` elements at a cell's origin. */
class SvgPen implements Pen {
  readonly out: string[] = [];
  #x: number;
  #y: number;

  constructor(x: number, y: number) {
    this.#x = x;
    this.#y = y;
  }

  rect(x0: number, y0: number, x1: number, y1: number, alpha = 1): void {
    if (x1 <= x0 || y1 <= y0) {
      return;
    }
    const opacity = alpha < 1 ? ` fill-opacity="${num(alpha)}"` : '';
    this.out.push(
      `<rect x="${num(this.#x + x0)}" y="${num(this.#y + y0)}" width="${num(x1 - x0)}" height="${num(y1 - y0)}"${opacity}/>`
    );
  }

  path(contours: readonly Contour[]): void {
    const at = (x: number, y: number): string => `${num(this.#x + x)} ${num(this.#y + y)}`;
    let d = '';
    for (const contour of contours) {
      contour.forEach((point, i) => {
        if (point.length === 2) {
          d += `${i === 0 ? 'M' : 'L'}${at(point[0], point[1])}`;
        } else {
          // a contour never opens on a curve here, but say so rather than assume
          d +=
            i === 0
              ? `M${at(point[2], point[3])}`
              : `Q${at(point[0], point[1])} ${at(point[2], point[3])}`;
        }
      });
      d += 'Z';
    }
    this.out.push(`<path d="${d}"/>`);
  }
}

/**
 * Writes a frame as SVG.
 *
 * Deterministic: the same frame and options produce the same string, element
 * for element, which is what lets an SVG be a golden file.
 *
 * @param input - A `canvas.snapshot()`, or a testing `Screen`.
 * @param options - Colours, font and size.
 * @returns The SVG document.
 */
export function renderSvg(input: Shootable, options: SvgOptions = {}): string {
  const shot = readShot(input, options.styles);
  const colors = resolveColors(options);
  const faces = loadFaces(options.font);
  // unscaled: an SVG's coordinates are CSS pixels and `scale` is its size
  const m = cellMetrics(faces.regular, options, 1);
  // and the size it declares is the PNG's, cell for cell, so the two formats of
  // one frame are the same size at any scale -- exactly the 1x size scaled at a
  // whole-number one, and within a rounding of it otherwise
  const device = cellMetrics(faces.regular, options);
  const family = options.fontFamily ?? DEFAULT_FONT_FAMILY;
  if (typeof family !== 'string' || family.trim() === '') {
    throw new TypeError('Invalid fontFamily: expected a CSS font stack');
  }

  const width = shot.width * m.width + m.padding * 2;
  const height = shot.height * m.height + m.padding * 2;
  const cellX = (column: number): number => m.padding + column * m.width;
  const cellY = (row: number): number => m.padding + row * m.height;

  const resolved = (style: Style): { bg: Rgb; fg: Rgb } => cellColors(style, colors);

  const backgrounds: string[] = [];
  const shapes = new Map<string, string[]>();
  const texts: string[] = [];

  for (let row = 0; row < shot.height; row++) {
    const at = (column: number): (typeof shot.cells)[number] =>
      shot.cells[row * shot.width + column];

    // backgrounds, merged into runs of one colour
    let runStart = -1;
    let runColor: Rgb | undefined;
    const flush = (end: number): void => {
      if (runColor && runStart >= 0) {
        backgrounds.push(
          `<rect x="${num(cellX(runStart))}" y="${num(cellY(row))}" width="${num((end - runStart) * m.width)}" height="${num(m.height)}" fill="${toHex(runColor)}"/>`
        );
      }
      runStart = -1;
      runColor = undefined;
    };
    for (let column = 0; column < shot.width; column++) {
      let cell = at(column);
      if (cell.width === 0 && column > 0 && at(column - 1).width === 2) {
        cell = at(column - 1);
      }
      const { bg } = resolved(cell.style);
      if (sameColor(bg, colors.background)) {
        flush(column);
      } else if (!runColor || !sameColor(runColor, bg)) {
        flush(column);
        runStart = column;
        runColor = bg;
      }
    }
    flush(shot.width);

    // text, in runs of one look, and geometry where the font cannot be trusted
    let run: { chars: string; key: string; span: number; start: number; style: Style } | undefined;
    const end = (): void => {
      if (!run) {
        return;
      }
      // a run carrying a line keeps its spaces, since an underline under
      // spaces is still an underline. Any other run sheds the spaces at its
      // ends, which draw nothing -- and a run of nothing but spaces sheds
      // itself. Each space is one cell, so the run's start and span move by
      // exactly what was taken off
      const lines = ATTR.underline | ATTR.strikethrough | ATTR.overline;
      if (!(run.style.attrs & lines)) {
        // ASCII spaces only: `trim()` would also take a U+3000, which is two
        // cells wide and would put the arithmetic a column out
        const lead = run.chars.length - run.chars.replace(/^ +/, '').length;
        const chars = run.chars.replace(/^ +| +$/g, '');
        run = {
          ...run,
          chars,
          span: run.span - (run.chars.length - chars.length),
          start: run.start + lead,
        };
      }
      if (run.chars !== '') {
        texts.push(
          textRun(run, cellX(run.start), cellY(row) + m.baseline, run.span * m.width, colors)
        );
      }
      run = undefined;
    };
    for (let column = 0; column < shot.width; column++) {
      const cell = at(column);
      if (cell.width === 0) {
        continue;
      }
      const { attrs } = cell.style;
      const hidden = (attrs & ATTR.hidden) !== 0;
      const { fg } = resolved(cell.style);
      const base = cell.char.codePointAt(0) ?? 0x20;
      if (!hidden && isGeometry(base)) {
        end();
        const pen = new SvgPen(cellX(column), cellY(row));
        const box: CellBox = { height: m.height, light: m.light, width: m.width * cell.width };
        drawGeometry(base, box, pen);
        const key = `${toHex(fg)}|${attrs & ATTR.dim ? 'dim' : ''}`;
        const list = shapes.get(key) ?? [];
        list.push(...pen.out);
        shapes.set(key, list);
        continue;
      }
      const char = hidden ? ' '.repeat(cell.width) : cell.char;
      const key = hidden ? 'hidden' : textKey(cell.style, fg);
      if (!run || run.key !== key) {
        end();
        run = {
          chars: '',
          key,
          span: 0,
          start: column,
          style: hidden ? { ...cell.style, attrs: 0 } : cell.style,
        };
      }
      run.chars += char;
      run.span += cell.width;
    }
    end();
  }

  const shapeGroups = [...shapes].map(([key, list]) => {
    const [fill, dim] = key.split('|');
    const opacity = dim ? ' fill-opacity="0.5"' : '';
    return `<g fill="${fill}"${opacity}>${list.join('')}</g>`;
  });

  const size = `width="${num(shot.width * device.width + device.padding * 2)}" height="${num(shot.height * device.height + device.padding * 2)}"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${num(width)} ${num(height)}">`,
    // `crispEdges` on rectangles alone: two cells' rectangles meeting at a
    // boundary that does not land on a device pixel are each anti-aliased
    // against the background, and the seam between them shows. Paths keep their
    // smoothing, since an arc drawn crisp is a staircase
    `<style>text{font-family:${escapeText(family)};font-size:${num(m.fontPx)}px;white-space:pre}rect{shape-rendering:crispEdges}</style>`,
    `<rect width="${num(width)}" height="${num(height)}" fill="${toHex(colors.background)}"/>`,
    ...backgrounds,
    ...shapeGroups,
    ...texts,
    '</svg>',
    '',
  ].join('\n');
}

/** One `<text>`, inside an `<a>` when it is a link a browser may follow. */
function textRun(
  run: { chars: string; style: Style },
  x: number,
  y: number,
  length: number,
  colors: ResolvedColors
): string {
  const { style } = run;
  const fg = cellColors(style, colors).fg;
  const attributes = [
    `x="${num(x)}"`,
    `y="${num(y)}"`,
    `textLength="${num(length)}"`,
    `fill="${toHex(fg)}"`,
  ];
  if (style.attrs & ATTR.bold) {
    attributes.push('font-weight="bold"');
  }
  if (style.attrs & ATTR.italic) {
    attributes.push('font-style="italic"');
  }
  if (style.attrs & ATTR.dim) {
    attributes.push('fill-opacity="0.5"');
  }
  const lines = [
    style.attrs & ATTR.underline ? 'underline' : '',
    style.attrs & ATTR.strikethrough ? 'line-through' : '',
    style.attrs & ATTR.overline ? 'overline' : '',
  ].filter(Boolean);
  if (lines.length > 0) {
    attributes.push(`text-decoration="${lines.join(' ')}"`);
  }
  const text = `<text ${attributes.join(' ')} xml:space="preserve">${escapeText(run.chars)}</text>`;
  if (style.link !== '' && SAFE_LINK.test(style.link) && !LINK_UNSAFE.test(style.link)) {
    return `<a href="${escapeAttribute(style.link)}">${text}</a>`;
  }
  return text;
}
