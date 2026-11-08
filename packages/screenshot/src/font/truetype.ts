/**
 * A TrueType reader: enough of `cmap`, `glyf` and the metrics tables to draw a
 * monospace font, and nothing past that.
 *
 * What is read and why:
 *
 * - `head` for the units per em and which `loca` format is in use.
 * - `maxp` for the glyph count, which bounds every glyph index read anywhere.
 * - `hhea` and `hmtx` for the ascender, descender, line gap and advances.
 * - `cmap` formats 4 and 12, which between them are every Unicode mapping a
 *   font made this century carries.
 * - `loca` and `glyf` for the outlines: simple glyphs and composites.
 * - `post` for the underline, and `OS/2` for the strikeout, when present.
 *
 * What is not: hinting (the bytecode is skipped, and an anti-aliased rasterizer
 * at screenshot sizes does not need it), `GSUB` (so no ligatures, which a
 * terminal does not draw either), `kern` and `GPOS` (a grid has no kerning), and
 * CFF outlines, which are refused by name rather than misread.
 *
 * Every read is bounds-checked through one function, and a font that points past
 * its own end throws a `FontError` naming what it was reading. A `DataView` would
 * throw a `RangeError` on its own, and the difference is the message: "offset is
 * outside the bounds of the DataView" says nothing about which table lied.
 */

/** A font that could not be read, with what was being read when it failed. */
export class FontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontError';
  }
}

/** One point of an outline, in font units, y up. */
export interface OutlinePoint {
  onCurve: boolean;
  x: number;
  y: number;
}

/** A glyph's outline: closed contours of on- and off-curve points. */
export type Outline = OutlinePoint[][];

/** The metrics a grid of cells is laid out from, in font units. */
export interface FontMetrics {
  /** Above the baseline, positive. */
  ascender: number;
  /** Below the baseline, negative, as `hhea` stores it. */
  descender: number;
  lineGap: number;
  strikeoutPosition: number;
  strikeoutSize: number;
  underlinePosition: number;
  underlineThickness: number;
  unitsPerEm: number;
}

/** A parsed font. */
export interface Font {
  /** The advance of a glyph, in font units. */
  advance(glyph: number): number;
  /** The glyph a code point maps to, or `0` -- `.notdef` -- for none. */
  glyphFor(codePoint: number): number;
  readonly metrics: FontMetrics;
  /** How many glyphs the font holds. */
  readonly numGlyphs: number;
  /** A glyph's outline, composites resolved, in font units. */
  outline(glyph: number): Outline;
}

/** How deep a composite may nest. Real fonts use one or two levels. */
const MAX_COMPOSITE_DEPTH = 8;

/**
 * The most points one glyph may come to, composites expanded.
 *
 * `maxp` stores the most a composite has as a 16-bit count, so no glyph a font
 * can describe honestly has more. The depth cap alone does not bound this: a
 * composite naming the one below it six times, eight levels deep, is six to the
 * eighth copies of whatever is at the bottom from a font of a few hundred bytes,
 * and every one of them would be allocated before anything was drawn.
 */
const MAX_GLYPH_POINTS = 0xff_ff;

/** `true` and `0x00010000` are TrueType; `OTTO` is CFF, which this does not read. */
const TRUETYPE = new Set([0x00_01_00_00, 0x74_72_75_65]);
const OTTO = 0x4f_54_54_4f;

/**
 * Reads a TrueType font.
 *
 * @param bytes - The font file.
 * @returns The font.
 */
export function parseFont(bytes: Uint8Array): Font {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.byteLength;

  /** Asks that `length` bytes at `offset` exist, naming `what` if they do not. */
  const need = (offset: number, length: number, what: string): void => {
    if (!Number.isInteger(offset) || offset < 0 || offset + length > size) {
      throw new FontError(`Invalid font: ${what} is outside the file`);
    }
  };
  const u8 = (offset: number, what: string): number => {
    need(offset, 1, what);
    return view.getUint8(offset);
  };
  const u16 = (offset: number, what: string): number => {
    need(offset, 2, what);
    return view.getUint16(offset);
  };
  const i16 = (offset: number, what: string): number => {
    need(offset, 2, what);
    return view.getInt16(offset);
  };
  const u32 = (offset: number, what: string): number => {
    need(offset, 4, what);
    return view.getUint32(offset);
  };

  const version = u32(0, 'the header');
  if (version === OTTO) {
    throw new FontError('Unsupported font: CFF outlines (OTTO) are not read, only TrueType glyf');
  }
  if (!TRUETYPE.has(version)) {
    throw new FontError('Invalid font: not a TrueType file');
  }

  const tables = new Map<string, { length: number; offset: number }>();
  const count = u16(4, 'the table directory');
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    need(record, 16, 'the table directory');
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3)
    );
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    need(offset, length, `the ${tag} table`);
    tables.set(tag, { length, offset });
  }

  const table = (tag: string): { length: number; offset: number } => {
    const found = tables.get(tag);
    if (!found) {
      throw new FontError(`Invalid font: no ${tag} table`);
    }
    return found;
  };

  const head = table('head').offset;
  const unitsPerEm = u16(head + 18, 'head');
  if (unitsPerEm < 16 || unitsPerEm > 16_384) {
    throw new FontError(`Invalid font: ${unitsPerEm} units per em`);
  }
  const longLoca = i16(head + 50, 'head') === 1;

  const numGlyphs = u16(table('maxp').offset + 4, 'maxp');

  const hhea = table('hhea').offset;
  const ascender = i16(hhea + 4, 'hhea');
  const descender = i16(hhea + 6, 'hhea');
  const lineGap = i16(hhea + 8, 'hhea');
  const numberOfHMetrics = u16(hhea + 34, 'hhea');
  if (numberOfHMetrics === 0) {
    throw new FontError('Invalid font: no horizontal metrics');
  }
  const hmtx = table('hmtx').offset;

  // the decorations: `post` and `OS/2` are both optional to this reader, and a
  // font that lacks them gets the positions a terminal would guess
  let underlinePosition = -Math.round(unitsPerEm / 10);
  let underlineThickness = Math.max(1, Math.round(unitsPerEm / 20));
  const post = tables.get('post');
  if (post && post.length >= 12) {
    underlinePosition = i16(post.offset + 8, 'post');
    underlineThickness = Math.max(1, i16(post.offset + 10, 'post'));
  }
  let strikeoutPosition = Math.round(unitsPerEm * 0.25);
  let strikeoutSize = underlineThickness;
  const os2 = tables.get('OS/2');
  if (os2 && os2.length >= 30) {
    strikeoutSize = Math.max(1, i16(os2.offset + 26, 'OS/2'));
    strikeoutPosition = i16(os2.offset + 28, 'OS/2');
  }

  const loca = table('loca').offset;
  const glyf = table('glyf');

  /** Where a glyph's data starts and ends inside `glyf`. */
  const glyphRange = (glyph: number): [number, number] => {
    const start = longLoca ? u32(loca + glyph * 4, 'loca') : u16(loca + glyph * 2, 'loca') * 2;
    const end = longLoca
      ? u32(loca + (glyph + 1) * 4, 'loca')
      : u16(loca + (glyph + 1) * 2, 'loca') * 2;
    if (end < start || end > glyf.length) {
      throw new FontError(`Invalid font: glyph ${glyph} runs outside glyf`);
    }
    return [glyf.offset + start, glyf.offset + end];
  };

  const cmap = readCmap(table('cmap').offset, u16, u32, numGlyphs);

  const outlines = new Map<number, Outline>();

  const outlineAt = (glyph: number, depth: number): Outline => {
    if (!Number.isInteger(glyph) || glyph < 0 || glyph >= numGlyphs) {
      throw new FontError(`Invalid font: glyph ${glyph} does not exist`);
    }
    const cached = outlines.get(glyph);
    if (cached) {
      return cached;
    }
    const [start, end] = glyphRange(glyph);
    // an empty range is a glyph with no outline -- a space -- and is legal
    if (start === end) {
      outlines.set(glyph, []);
      return [];
    }
    const contours = i16(start, 'a glyph header');
    const result =
      contours >= 0
        ? simpleGlyph(start, end, contours)
        : compositeGlyph(start + 10, end, glyph, depth);
    outlines.set(glyph, result);
    return result;
  };

  const simpleGlyph = (start: number, end: number, contours: number): Outline => {
    const ends: number[] = [];
    let at = start + 10;
    for (let i = 0; i < contours; i++) {
      ends.push(u16(at, 'contour ends'));
      at += 2;
    }
    const points = contours === 0 ? 0 : ends[contours - 1] + 1;
    for (let i = 1; i < ends.length; i++) {
      if (ends[i] < ends[i - 1]) {
        throw new FontError('Invalid font: contour ends are out of order');
      }
    }
    // the instructions, skipped: hinting is not read
    const instructions = u16(at, 'instructions');
    at += 2 + instructions;

    const flags = new Uint8Array(points);
    for (let i = 0; i < points;) {
      const flag = u8(at++, 'glyph flags');
      flags[i++] = flag;
      if (flag & 0x08) {
        let repeat = u8(at++, 'glyph flags');
        while (repeat-- > 0 && i < points) {
          flags[i++] = flag;
        }
      }
    }

    const xs = new Int32Array(points);
    let x = 0;
    for (let i = 0; i < points; i++) {
      const flag = flags[i];
      if (flag & 0x02) {
        const dx = u8(at++, 'glyph x');
        x += flag & 0x10 ? dx : -dx;
      } else if (!(flag & 0x10)) {
        x += i16(at, 'glyph x');
        at += 2;
      }
      xs[i] = x;
    }
    const ys = new Int32Array(points);
    let y = 0;
    for (let i = 0; i < points; i++) {
      const flag = flags[i];
      if (flag & 0x04) {
        const dy = u8(at++, 'glyph y');
        y += flag & 0x20 ? dy : -dy;
      } else if (!(flag & 0x20)) {
        y += i16(at, 'glyph y');
        at += 2;
      }
      ys[i] = y;
    }
    if (at > end) {
      throw new FontError('Invalid font: a glyph runs past its own end');
    }

    const outline: Outline = [];
    let first = 0;
    for (const last of ends) {
      const contour: OutlinePoint[] = [];
      for (let i = first; i <= last; i++) {
        contour.push({ onCurve: (flags[i] & 0x01) !== 0, x: xs[i], y: ys[i] });
      }
      if (contour.length > 0) {
        outline.push(contour);
      }
      first = last + 1;
    }
    return outline;
  };

  const compositeGlyph = (start: number, end: number, self: number, depth: number): Outline => {
    if (depth >= MAX_COMPOSITE_DEPTH) {
      throw new FontError(`Invalid font: glyph ${self} nests composites too deeply`);
    }
    const outline: Outline = [];
    let points = 0;
    let at = start;
    let more = true;
    while (more) {
      const flags = u16(at, 'a composite');
      const component = u16(at + 2, 'a composite');
      at += 4;
      let dx: number;
      let dy: number;
      if (flags & 0x0001) {
        dx = i16(at, 'a composite');
        dy = i16(at + 2, 'a composite');
        at += 4;
      } else {
        dx = (u8(at, 'a composite') << 24) >> 24;
        dy = (u8(at + 1, 'a composite') << 24) >> 24;
        at += 2;
      }
      // the 2x2, in F2Dot14
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & 0x0008) {
        a = d = i16(at, 'a composite') / 16_384;
        at += 2;
      } else if (flags & 0x0040) {
        a = i16(at, 'a composite') / 16_384;
        d = i16(at + 2, 'a composite') / 16_384;
        at += 4;
      } else if (flags & 0x0080) {
        a = i16(at, 'a composite') / 16_384;
        b = i16(at + 2, 'a composite') / 16_384;
        c = i16(at + 4, 'a composite') / 16_384;
        d = i16(at + 6, 'a composite') / 16_384;
        at += 8;
      }
      if (at > end) {
        throw new FontError('Invalid font: a composite runs past its own end');
      }
      // point-matched placement (ARGS_ARE_XY_VALUES clear) is rare enough in a
      // modern font that it is placed at the origin rather than guessed at
      if (!(flags & 0x0002)) {
        dx = 0;
        dy = 0;
      }
      // SCALED_COMPONENT_OFFSET without UNSCALED_COMPONENT_OFFSET: the offset is
      // in the component's own space and goes through the matrix too. Neither
      // set is unscaled, which is what every TrueType rasterizer defaults to
      if (flags & 0x0800 && !(flags & 0x1000)) {
        [dx, dy] = [a * dx + c * dy, b * dx + d * dy];
      }
      if (component === self) {
        throw new FontError(`Invalid font: glyph ${self} contains itself`);
      }
      const parts = outlineAt(component, depth + 1);
      points += parts.reduce((sum, contour) => sum + contour.length, 0);
      if (points > MAX_GLYPH_POINTS) {
        throw new FontError(
          `Invalid font: glyph ${self} expands to more than ${MAX_GLYPH_POINTS} points`
        );
      }
      // the 2x2 is applied as x' = a*x + c*y, y' = b*x + d*y, with a b c d in
      // the order the file stores them -- Apple's TrueType reference and
      // FreeType both, and the opposite of how the matrix reads at a glance
      for (const contour of parts) {
        outline.push(
          contour.map((p) => ({
            onCurve: p.onCurve,
            x: a * p.x + c * p.y + dx,
            y: b * p.x + d * p.y + dy,
          }))
        );
      }
      more = (flags & 0x0020) !== 0;
    }
    return outline;
  };

  return {
    advance(glyph: number): number {
      if (glyph >= numGlyphs || glyph < 0) {
        return 0;
      }
      const index = Math.min(glyph, numberOfHMetrics - 1);
      return u16(hmtx + index * 4, 'hmtx');
    },
    glyphFor(codePoint: number): number {
      return cmap(codePoint);
    },
    metrics: Object.freeze({
      ascender,
      descender,
      lineGap,
      strikeoutPosition,
      strikeoutSize,
      underlinePosition,
      underlineThickness,
      unitsPerEm,
    }),
    numGlyphs,
    outline(glyph: number): Outline {
      return outlineAt(glyph, 0);
    },
  };
}

/**
 * Picks a Unicode subtable out of `cmap` and returns a lookup over it.
 *
 * Format 12 is preferred where there is one, since it covers the astral planes;
 * format 4 is the BMP-only table nearly every font also carries. A glyph index
 * past the font's own count is read as `.notdef`, because drawing one would be
 * reading somebody else's glyph.
 */
function readCmap(
  cmap: number,
  u16: (offset: number, what: string) => number,
  u32: (offset: number, what: string) => number,
  numGlyphs: number
): (codePoint: number) => number {
  const count = u16(cmap + 2, 'cmap');
  let format4: number | undefined;
  let format12: number | undefined;
  for (let i = 0; i < count; i++) {
    const record = cmap + 4 + i * 8;
    const platform = u16(record, 'cmap');
    const encoding = u16(record + 2, 'cmap');
    const offset = cmap + u32(record + 4, 'cmap');
    // Unicode platform, any encoding, or Windows with the BMP or full repertoire
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) {
      continue;
    }
    const format = u16(offset, 'cmap');
    if (format === 12 && format12 === undefined) {
      format12 = offset;
    } else if (format === 4 && format4 === undefined) {
      format4 = offset;
    }
  }

  const valid = (glyph: number): number => (glyph < numGlyphs ? glyph : 0);

  if (format12 !== undefined) {
    const at = format12;
    const groups = u32(at + 12, 'cmap format 12');
    return (codePoint) => {
      // binary search over the sorted groups
      let lo = 0;
      let hi = groups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const group = at + 16 + mid * 12;
        const start = u32(group, 'cmap format 12');
        const end = u32(group + 4, 'cmap format 12');
        if (codePoint < start) {
          hi = mid - 1;
        } else if (codePoint > end) {
          lo = mid + 1;
        } else {
          return valid(u32(group + 8, 'cmap format 12') + codePoint - start);
        }
      }
      return 0;
    };
  }

  if (format4 !== undefined) {
    const at = format4;
    const segments = u16(at + 6, 'cmap format 4') / 2;
    const ends = at + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    return (codePoint) => {
      if (codePoint > 0xff_ff) {
        return 0;
      }
      let lo = 0;
      let hi = segments - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const end = u16(ends + mid * 2, 'cmap format 4');
        const start = u16(starts + mid * 2, 'cmap format 4');
        if (codePoint > end) {
          lo = mid + 1;
        } else if (codePoint < start) {
          hi = mid - 1;
        } else {
          const delta = u16(deltas + mid * 2, 'cmap format 4');
          const range = u16(ranges + mid * 2, 'cmap format 4');
          if (range === 0) {
            return valid((codePoint + delta) & 0xff_ff);
          }
          const glyph = u16(ranges + mid * 2 + range + (codePoint - start) * 2, 'cmap format 4');
          return glyph === 0 ? 0 : valid((glyph + delta) & 0xff_ff);
        }
      }
      return 0;
    };
  }

  throw new FontError('Invalid font: no Unicode cmap');
}
