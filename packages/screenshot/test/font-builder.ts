/**
 * A TrueType font built from nothing, for the shapes the bundled font does not
 * have: a composite with a 2x2 matrix, one that names its children hundreds of
 * times, a glyph that runs to the edge of the 16-bit range.
 *
 * Only the tables the reader needs: `cmap` (format 4), `glyf`, `head`, `hhea`,
 * `hmtx`, `loca` (long) and `maxp`. Glyph 0 is an empty `.notdef`.
 */

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];

/** A simple glyph: one contour of on-curve points, in font units. */
export function simpleGlyph(points: readonly (readonly [number, number])[]): number[] {
  const out = [...u16(1), ...Array(8).fill(0), ...u16(points.length - 1), ...u16(0)];
  out.push(...points.map(() => 0x01));
  let x = 0;
  for (const [px] of points) {
    out.push(...u16(px - x));
    x = px;
  }
  let y = 0;
  for (const [, py] of points) {
    out.push(...u16(py - y));
    y = py;
  }
  return out;
}

/** One component of a composite. */
export interface Component {
  dx?: number;
  dy?: number;
  /** Extra flags, beyond ARG_1_AND_2_ARE_WORDS and ARGS_ARE_XY_VALUES. */
  flags?: number;
  glyph: number;
  /** The 2x2 in the order the file stores it: xscale, scale01, scale10, yscale. */
  matrix?: readonly [number, number, number, number];
  /** A uniform scale (WE_HAVE_A_SCALE). */
  scale?: number;
}

/** A composite glyph. */
export function compositeGlyph(components: readonly Component[]): number[] {
  const out = [...u16(0xff_ff), ...Array(8).fill(0)];
  components.forEach((c, i) => {
    let flags = 0x0001 | 0x0002 | (c.flags ?? 0);
    if (i < components.length - 1) {
      flags |= 0x0020;
    }
    if (c.matrix) {
      flags |= 0x0080;
    } else if (c.scale !== undefined) {
      flags |= 0x0008;
    }
    out.push(...u16(flags), ...u16(c.glyph), ...u16(c.dx ?? 0), ...u16(c.dy ?? 0));
    if (c.matrix) {
      for (const v of c.matrix) {
        out.push(...u16(Math.round(v * 16_384)));
      }
    } else if (c.scale !== undefined) {
      out.push(...u16(Math.round(c.scale * 16_384)));
    }
  });
  return out;
}

/**
 * The font.
 *
 * @param glyphs - Glyphs 1 onwards; `.notdef` is added in front.
 * @param map - Code point to glyph index.
 * @param unitsPerEm - The em, which a hostile font may make tiny.
 */
export function buildFont(
  glyphs: readonly number[][],
  map: Readonly<Record<number, number>>,
  unitsPerEm = 1000
): Uint8Array {
  const all = [[], ...glyphs].map((g) => (g.length % 2 ? [...g, 0] : g));
  const glyf = all.flat();
  const loca: number[] = [];
  let offset = 0;
  for (const g of all) {
    loca.push(...u32(offset));
    offset += g.length;
  }
  loca.push(...u32(offset));

  const head = Array(54).fill(0);
  head.splice(18, 2, ...u16(unitsPerEm));
  head.splice(50, 2, ...u16(1));
  const maxp = [0, 0, 0x50, 0, ...u16(all.length)];
  const hhea = Array(36).fill(0);
  hhea.splice(4, 2, ...u16(Math.round(unitsPerEm * 0.8)));
  hhea.splice(6, 2, ...u16(-Math.round(unitsPerEm * 0.2) & 0xff_ff));
  hhea.splice(34, 2, ...u16(1));
  const hmtx = [...u16(Math.round(unitsPerEm * 0.6)), 0, 0];

  // format 4, one segment per mapped code point and the closing 0xFFFF
  const points = Object.keys(map)
    .map(Number)
    .toSorted((a, b) => a - b);
  const ends = [...points, 0xff_ff];
  const segments = ends.length;
  const f4 = [
    ...u16(4),
    0,
    0,
    0,
    0,
    ...u16(segments * 2),
    0,
    0,
    0,
    0,
    0,
    0,
    ...ends.flatMap(u16),
    0,
    0,
    ...ends.flatMap(u16),
    ...[...points.map((p) => (map[p] - p) & 0xff_ff), 1].flatMap(u16),
    ...ends.flatMap(() => u16(0)),
  ];
  f4.splice(2, 2, ...u16(f4.length));
  const cmap = [0, 0, ...u16(1), ...u16(3), ...u16(1), ...u32(12), ...f4];

  const tables: [string, number[]][] = [
    ['cmap', cmap],
    ['glyf', glyf],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['loca', loca],
    ['maxp', maxp],
  ];
  const start = 12 + 16 * tables.length;
  const directory: number[] = [];
  const body: number[] = [];
  for (const [tag, data] of tables) {
    directory.push(...[...tag].map((c) => c.charCodeAt(0)), 0, 0, 0, 0);
    directory.push(...u32(start + body.length), ...u32(data.length));
    body.push(...data);
    while (body.length % 4) {
      body.push(0);
    }
  }
  return new Uint8Array([
    ...u32(0x00_01_00_00),
    ...u16(tables.length),
    0,
    0,
    0,
    0,
    0,
    0,
    ...directory,
    ...body,
  ]);
}
