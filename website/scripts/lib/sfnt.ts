/**
 * Reading glyph outlines out of a TrueType sfnt, for the one place that needs
 * them: outlining the wordmark into paths (`scripts/brand-assets.ts`).
 *
 * Small on purpose. It reads `cmap` (formats 4 and 12), `head`, `hhea`, `hmtx`,
 * `loca` and `glyf`, which is everything needed to turn a string into an SVG
 * path, and nothing that shapes text: no kerning, no ligatures, no GSUB. For a
 * monospaced face and a five-letter word that is not a limitation.
 */

export type Font = {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  glyphIndex: (codePoint: number) => number;
  advance: (glyph: number) => number;
  /**
   * The glyph's outline as an SVG path. In font units with y up unless `map`
   * is given, which is applied to every point and is how a caller scales,
   * flips and places it.
   */
  outline: (glyph: number, map?: Transform) => string;
  /** The glyph's bounding box in font units, `[xMin, yMin, xMax, yMax]`, or `undefined` if blank. */
  box: (glyph: number) => [number, number, number, number] | undefined;
};

export type Transform = (x: number, y: number) => [number, number];

type Point = { x: number; y: number; on: boolean };

/** Table offsets by tag. */
function directory(view: DataView) {
  const tables = new Map<string, { offset: number; length: number }>();
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(
      view.getUint8(at),
      view.getUint8(at + 1),
      view.getUint8(at + 2),
      view.getUint8(at + 3)
    );
    tables.set(tag, { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return tables;
}

/** Looks a code point up through the first Unicode `cmap` subtable that has one. */
function cmapLookup(view: DataView, cmap: number) {
  const subtables: { format: number; offset: number }[] = [];
  const count = view.getUint16(cmap + 2);
  for (let i = 0; i < count; i++) {
    const platform = view.getUint16(cmap + 4 + i * 8);
    const encoding = view.getUint16(cmap + 6 + i * 8);
    const offset = cmap + view.getUint32(cmap + 8 + i * 8);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode) {
      subtables.push({ format: view.getUint16(offset), offset });
    }
  }

  return (cp: number) => {
    for (const { format, offset } of subtables) {
      if (format === 4) {
        const segCount = view.getUint16(offset + 6) / 2;
        const ends = offset + 14;
        const starts = ends + segCount * 2 + 2;
        const deltas = starts + segCount * 2;
        const ranges = deltas + segCount * 2;
        for (let s = 0; s < segCount; s++) {
          if (cp <= view.getUint16(ends + s * 2)) {
            const start = view.getUint16(starts + s * 2);
            if (cp < start) {
              break;
            }
            const range = view.getUint16(ranges + s * 2);
            if (range === 0) {
              return (cp + view.getUint16(deltas + s * 2)) & 0xffff;
            }
            const glyph = view.getUint16(ranges + s * 2 + range + (cp - start) * 2);
            return glyph === 0 ? 0 : (glyph + view.getUint16(deltas + s * 2)) & 0xffff;
          }
        }
      } else if (format === 12) {
        const groups = view.getUint32(offset + 12);
        for (let g = 0; g < groups; g++) {
          const at = offset + 16 + g * 12;
          const start = view.getUint32(at);
          if (cp >= start && cp <= view.getUint32(at + 4)) {
            return view.getUint32(at + 8) + (cp - start);
          }
        }
      }
    }
    return 0;
  };
}

/** The contours of a glyph, composites resolved to their parts' points. */
function contours(
  view: DataView,
  glyf: number,
  location: (glyph: number) => [start: number, end: number],
  glyph: number,
  depth = 0
): Point[][] {
  const [start, end] = location(glyph);
  if (end <= start) {
    return [];
  }
  const at = glyf + start;
  const count = view.getInt16(at);

  if (count < 0) {
    if (depth > 8) {
      throw new Error('sfnt: composite glyphs nested too deep');
    }
    const out: Point[][] = [];
    let p = at + 10;
    let more = true;
    while (more) {
      const flags = view.getUint16(p);
      const part = view.getUint16(p + 2);
      p += 4;
      let dx: number;
      let dy: number;
      if (flags & 0x0001) {
        dx = view.getInt16(p);
        dy = view.getInt16(p + 2);
        p += 4;
      } else {
        dx = view.getInt8(p);
        dy = view.getInt8(p + 1);
        p += 2;
      }
      if (!(flags & 0x0002)) {
        throw new Error('sfnt: composite glyphs placed by point matching are not supported');
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      if (flags & 0x0008) {
        a = d = view.getInt16(p) / 16384;
        p += 2;
      } else if (flags & 0x0040) {
        a = view.getInt16(p) / 16384;
        d = view.getInt16(p + 2) / 16384;
        p += 4;
      } else if (flags & 0x0080) {
        a = view.getInt16(p) / 16384;
        b = view.getInt16(p + 2) / 16384;
        c = view.getInt16(p + 4) / 16384;
        d = view.getInt16(p + 6) / 16384;
        p += 8;
      }
      for (const contour of contours(view, glyf, location, part, depth + 1)) {
        out.push(
          contour.map(({ x, y, on }) => ({ x: a * x + c * y + dx, y: b * x + d * y + dy, on }))
        );
      }
      more = (flags & 0x0020) !== 0;
    }
    return out;
  }

  const ends = Array.from({ length: count }, (_, i) => view.getUint16(at + 10 + i * 2));
  const total = (ends.at(-1) ?? -1) + 1;
  let p = at + 10 + count * 2;
  p += 2 + view.getUint16(p); // instructions

  const flags: number[] = [];
  while (flags.length < total) {
    const flag = view.getUint8(p++);
    flags.push(flag);
    if (flag & 0x08) {
      for (let n = view.getUint8(p++); n > 0; n--) {
        flags.push(flag);
      }
    }
  }

  const axis = (short: number, same: number) => {
    const values: number[] = [];
    let v = 0;
    for (const flag of flags) {
      if (flag & short) {
        const d = view.getUint8(p++);
        v += flag & same ? d : -d;
      } else if (!(flag & same)) {
        v += view.getInt16(p);
        p += 2;
      }
      values.push(v);
    }
    return values;
  };
  const xs = axis(0x02, 0x10);
  const ys = axis(0x04, 0x20);

  let first = 0;
  return ends.map((last) => {
    const points: Point[] = [];
    for (let i = first; i <= last; i++) {
      points.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) !== 0 });
    }
    first = last + 1;
    return points;
  });
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * One closed contour as path commands. Quadratic curves, where two off-curve
 * points in a row imply an on-curve point halfway between them.
 */
function contourPath(points: Point[]): string {
  if (points.length < 2) {
    return '';
  }
  // start on an on-curve point; if there is none, on the midpoint of the first two
  let list = points;
  const firstOn = points.findIndex((p) => p.on);
  if (firstOn > 0) {
    list = [...points.slice(firstOn), ...points.slice(0, firstOn)];
  } else if (firstOn < 0) {
    const [a, b] = points;
    list = [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true }, ...points.slice(1), a];
  }

  let d = `M${n(list[0].x)} ${n(list[0].y)}`;
  let control: Point | undefined;
  for (const p of [...list.slice(1), list[0]]) {
    if (p.on) {
      d += control
        ? `Q${n(control.x)} ${n(control.y)} ${n(p.x)} ${n(p.y)}`
        : `L${n(p.x)} ${n(p.y)}`;
      control = undefined;
    } else {
      if (control) {
        const mx = (control.x + p.x) / 2;
        const my = (control.y + p.y) / 2;
        d += `Q${n(control.x)} ${n(control.y)} ${n(mx)} ${n(my)}`;
      }
      control = p;
    }
  }
  if (control) {
    d += `Q${n(control.x)} ${n(control.y)} ${n(list[0].x)} ${n(list[0].y)}`;
  }
  return `${d}Z`;
}

export function readFont(bytes: Uint8Array): Font {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = directory(view);
  const need = (tag: string) => {
    const table = tables.get(tag);
    if (!table) {
      throw new Error(`sfnt: no ${tag} table`);
    }
    return table.offset;
  };

  const head = need('head');
  const hhea = need('hhea');
  const hmtx = need('hmtx');
  const loca = need('loca');
  const glyf = need('glyf');
  const longLoca = view.getInt16(head + 50) === 1;
  const numHMetrics = view.getUint16(hhea + 34);
  const lookup = cmapLookup(view, need('cmap'));

  const location = (glyph: number): [number, number] =>
    longLoca
      ? [view.getUint32(loca + glyph * 4), view.getUint32(loca + glyph * 4 + 4)]
      : [view.getUint16(loca + glyph * 2) * 2, view.getUint16(loca + glyph * 2 + 2) * 2];

  return {
    unitsPerEm: view.getUint16(head + 18),
    ascender: view.getInt16(hhea + 4),
    descender: view.getInt16(hhea + 6),
    glyphIndex: lookup,
    advance: (glyph) => view.getUint16(hmtx + Math.min(glyph, numHMetrics - 1) * 4),
    outline: (glyph, map = (x, y) => [x, y]) =>
      contours(view, glyf, location, glyph)
        .map((c) =>
          contourPath(
            c.map(({ x, y, on }) => {
              const [mx, my] = map(x, y);
              return { x: mx, y: my, on };
            })
          )
        )
        .join(''),
    box: (glyph) => {
      const [start, end] = location(glyph);
      if (end <= start) {
        return undefined;
      }
      const at = glyf + start;
      return [
        view.getInt16(at + 2),
        view.getInt16(at + 4),
        view.getInt16(at + 6),
        view.getInt16(at + 8),
      ];
    },
  };
}
