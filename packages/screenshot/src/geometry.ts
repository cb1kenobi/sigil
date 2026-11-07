import { Accumulator } from './font/raster.js';

/**
 * Box drawing, block elements and braille, drawn as geometry.
 *
 * Real terminals do not take these from the font, and for a reason a screenshot
 * inherits: a font's box-drawing glyphs are designed to an em and a line height
 * that are not the cell's, so a vertical line leaves a gap between rows and a
 * corner misses the line it is meant to meet. Drawn here, every line lands on
 * whole pixels at the centre of the cell and meets its neighbour exactly, and a
 * half block covers exactly half the rows -- which is what `Pixels` relies on,
 * since its `▀` over a `▄` is meant to be a seamless column of pixels.
 *
 * The drawing goes through a `Pen`, so the same geometry is a coverage bitmap
 * for a PNG and `<rect>` and `<path>` elements for an SVG. Coordinates are
 * pixels relative to the cell's top-left, y down.
 */

/** A closed path: each point a line-to, or a quadratic to its last two numbers. */
export type Contour = readonly (
  | readonly [x: number, y: number]
  | readonly [cx: number, cy: number, x: number, y: number]
)[];

/** Where geometry is drawn. */
export interface Pen {
  /** A rectangle, corners in whole pixels, at an opacity of 0-1. */
  rect(x0: number, y0: number, x1: number, y1: number, alpha?: number): void;
  /** Closed contours, filled non-zero. */
  path(contours: readonly Contour[]): void;
}

/** A cell's size, and how thick a light line is in it. */
export interface CellBox {
  /** Pixels. */
  height: number;
  /** The light line, in whole pixels. Heavy is twice it, and double is two of it. */
  light: number;
  /** Pixels. */
  width: number;
}

/**
 * The arms of each line-drawing character, U+2500 to U+257F.
 *
 * Four digits per character -- up, right, down, left -- with `0` for no arm, `1`
 * light, `2` heavy and `3` double, and `....` for the ones drawn some other way
 * (the dashes, the arcs, the diagonals). Generated once from the Unicode
 * character names, which spell exactly this ("BOX DRAWINGS UP HEAVY AND RIGHT
 * DOWN LIGHT"), and written out so that nothing at run time parses a name.
 */
const ARMS =
  '0101020210102020................' +
  '................0110021001200220' +
  '00110012002100221100120021002200' +
  '10011002200120021110121021101120' +
  '21202210122022201011101220111021' +
  '20212012102220220111011202110212' +
  '01210122022102221101110212011202' +
  '21012102220122021111111212111212' +
  '21111121212121122211112212212212' +
  '1222212222212222................' +
  '03033030031001300330001300310033' +
  '13003100330010033001300313103130' +
  '33301013303130330313013103331303' +
  '31013303131331313333............' +
  '................0001100001000010' +
  '00022000020000200201102001022010';

/** The dashed lines: `[horizontal, heavy, dashes]` by code point. */
const DASHES: Readonly<Record<number, readonly [boolean, boolean, number]>> = {
  0x25_04: [true, false, 3],
  0x25_05: [true, true, 3],
  0x25_06: [false, false, 3],
  0x25_07: [false, true, 3],
  0x25_08: [true, false, 4],
  0x25_09: [true, true, 4],
  0x25_0a: [false, false, 4],
  0x25_0b: [false, true, 4],
  0x25_4c: [true, false, 2],
  0x25_4d: [true, true, 2],
  0x25_4e: [false, false, 2],
  0x25_4f: [false, true, 2],
};

/** √2 - 1, the control-point distance for a 45° quadratic arc on a unit circle. */
const ARC_T = 0.414_213_562_373_095_1;
/** √½, the 45° point on a unit circle. */
const ARC_S = 0.707_106_781_186_547_6;

/**
 * A pen that writes coverage into a bitmap, taking the maximum where two shapes
 * overlap -- so a junction drawn as two overlapping rectangles is one shape, not
 * a darker square where they cross.
 */
export class CoveragePen implements Pen {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
  }

  rect(x0: number, y0: number, x1: number, y1: number, alpha = 1): void {
    const a = Math.round(alpha * 255);
    const left = Math.max(0, x0);
    const right = Math.min(this.width, x1);
    const top = Math.max(0, y0);
    const bottom = Math.min(this.height, y1);
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = y * this.width + x;
        if (this.data[i] < a) {
          this.data[i] = a;
        }
      }
    }
  }

  path(contours: Parameters<Pen['path']>[0]): void {
    const acc = new Accumulator(this.width, this.height);
    for (const contour of contours) {
      let [px, py] = contour[contour.length - 1].slice(-2) as [number, number];
      for (const point of contour) {
        if (point.length === 2) {
          acc.line(px, py, point[0], point[1]);
          [px, py] = point;
        } else {
          acc.quad(px, py, point[0], point[1], point[2], point[3]);
          px = point[2];
          py = point[3];
        }
      }
    }
    const cover = acc.coverage();
    for (let i = 0; i < cover.length; i++) {
      if (this.data[i] < cover[i]) {
        this.data[i] = cover[i];
      }
    }
  }
}

/** Whether a code point is one this module draws. */
export function isGeometry(codePoint: number): boolean {
  return (
    (codePoint >= 0x25_00 && codePoint <= 0x25_9f) || (codePoint >= 0x28_00 && codePoint <= 0x28_ff)
  );
}

/**
 * Draws a character as geometry.
 *
 * @param codePoint - The character.
 * @param box - The cell.
 * @param pen - Where to draw.
 * @returns Whether it was one this module draws.
 */
export function drawGeometry(codePoint: number, box: CellBox, pen: Pen): boolean {
  if (codePoint >= 0x25_00 && codePoint <= 0x25_7f) {
    const dash = DASHES[codePoint];
    if (dash) {
      drawDashes(box, pen, ...dash);
      return true;
    }
    if (codePoint >= 0x25_6d && codePoint <= 0x25_70) {
      drawArc(codePoint, box, pen);
      return true;
    }
    if (codePoint >= 0x25_71 && codePoint <= 0x25_73) {
      drawDiagonal(codePoint, box, pen);
      return true;
    }
    const at = (codePoint - 0x25_00) * 4;
    const arms = Array.from(ARMS.slice(at, at + 4), Number) as [number, number, number, number];
    drawLines(arms, box, pen);
    return true;
  }
  if (codePoint >= 0x25_80 && codePoint <= 0x25_9f) {
    drawBlock(codePoint, box, pen);
    return true;
  }
  if (codePoint >= 0x28_00 && codePoint <= 0x28_ff) {
    drawBraille(codePoint - 0x28_00, box, pen);
    return true;
  }
  return false;
}

/** Where a line of thickness `t` centred on pixel `c` starts. */
const lo = (c: number, t: number): number => c - Math.floor(t / 2);
/** And where it ends, exclusive. */
const hi = (c: number, t: number): number => lo(c, t) + t;

/**
 * The straight lines and their junctions.
 *
 * Each arm is drawn from the cell edge to wherever it meets the arms across it,
 * and the rules for where that is are the whole of the work. A single arm
 * overlaps a single line across it, so a corner is filled. Against a double
 * line across it, an arm passes straight through if its own opposite arm is
 * there too, stops at the near line of a tee, and reaches the far line of a
 * corner. A double arm's two lines are each decided by the arm on their own side:
 * a double there means meet its near line, which is what leaves the openings in
 * `╬` and `╠`, and nothing there means turn the corner at the far side.
 */
function drawLines(arms: readonly [number, number, number, number], box: CellBox, pen: Pen): void {
  const [up, right, down, left] = arms;
  const cx = Math.floor(box.width / 2);
  const cy = Math.floor(box.height / 2);
  const t1 = box.light;
  const d = t1;
  const thick = (weight: number): number => (weight === 2 ? t1 * 2 : t1);

  /**
   * One arm, in axis-relative terms: `main` is the axis the arm runs along, and
   * `crossLow`/`crossHigh` are the arms across it on its low and high side.
   */
  const arm = (
    vertical: boolean,
    dir: number,
    weight: number,
    other: number,
    crossLow: number,
    crossHigh: number
  ): void => {
    if (weight === 0) {
      return;
    }
    const cMain = vertical ? cy : cx;
    const cCross = vertical ? cx : cy;
    const edge = dir > 0 ? (vertical ? box.height : box.width) : 0;
    const fill = (from: number, a: number, b: number): void => {
      const m0 = Math.min(from, edge);
      const m1 = Math.max(from, edge);
      if (vertical) {
        pen.rect(a, m0, b, m1);
      } else {
        pen.rect(m0, a, m1, b);
      }
    };
    // the end of the arm nearest the centre, for a line across of thickness `t`
    // centred at `c`: the arm overlaps it, so a corner has no notch
    const near = (c: number, t: number): number => (dir > 0 ? lo(c, t) : hi(c, t));

    if (weight !== 3) {
      const t = thick(weight);
      let start: number;
      if (crossLow === 3 || crossHigh === 3) {
        if (other !== 0) {
          start = cMain;
        } else if (crossLow !== 0 && crossHigh !== 0) {
          start = near(cMain + dir * d, t1);
        } else {
          start = near(cMain - dir * d, t1);
        }
      } else if (crossLow !== 0 || crossHigh !== 0) {
        start = near(
          cMain,
          Math.max(crossLow ? thick(crossLow) : 0, crossHigh ? thick(crossHigh) : 0)
        );
      } else {
        start = near(cMain, t);
      }
      fill(start, lo(cCross, t), hi(cCross, t));
      return;
    }

    for (const side of [-1, 1]) {
      const same = side < 0 ? crossLow : crossHigh;
      const opposite = side < 0 ? crossHigh : crossLow;
      let start: number;
      if (same === 3) {
        start = near(cMain + dir * d, t1);
      } else if (same !== 0) {
        start = near(cMain, thick(same));
      } else if (opposite === 3) {
        start = near(cMain - dir * d, t1);
      } else if (opposite !== 0) {
        start = near(cMain, thick(opposite));
      } else if (other !== 0) {
        start = cMain;
      } else {
        start = near(cMain, t1);
      }
      const c = cCross + side * d;
      fill(start, lo(c, t1), hi(c, t1));
    }
  };

  arm(false, 1, right, left, up, down);
  arm(false, -1, left, right, up, down);
  arm(true, 1, down, up, left, right);
  arm(true, -1, up, down, left, right);
}

/** Two, three or four dashes along the centre line, centred in equal shares. */
function drawDashes(
  box: CellBox,
  pen: Pen,
  horizontal: boolean,
  heavy: boolean,
  count: number
): void {
  const t = heavy ? box.light * 2 : box.light;
  const length = horizontal ? box.width : box.height;
  const c = Math.floor((horizontal ? box.height : box.width) / 2);
  const share = length / count;
  const dash = Math.max(1, Math.round(share / 2));
  for (let i = 0; i < count; i++) {
    const from = Math.round(i * share + (share - dash) / 2);
    if (horizontal) {
      pen.rect(from, lo(c, t), from + dash, hi(c, t));
    } else {
      pen.rect(lo(c, t), from, hi(c, t), from + dash);
    }
  }
}

/**
 * A rounded corner: a quarter circle joining the centre lines, with straight
 * runs out to the two edges it opens onto.
 *
 * The radius is the largest that fits every one of the four corners in the
 * cell, so `╭╮╰╯` are one size and a rounded box is symmetric. The quarter is
 * two quadratic segments of 45°, whose control points are constants rather than
 * a `Math.cos()` an engine might round differently.
 */
function drawArc(codePoint: number, box: CellBox, pen: Pen): void {
  const t = box.light;
  const half = t / 2;
  // the centre lines, as real numbers, so the arc meets the straight lines
  // drawn by `drawLines()` exactly
  const lx = lo(Math.floor(box.width / 2), t) + half;
  const ly = lo(Math.floor(box.height / 2), t) + half;
  const radius = Math.min(lx, box.width - lx, ly, box.height - ly);
  // which way the arc's own centre is from the junction: ╭ opens down and right
  const sx = codePoint === 0x25_6d || codePoint === 0x25_70 ? 1 : -1;
  const sy = codePoint === 0x25_6d || codePoint === 0x25_6e ? 1 : -1;
  const ox = lx + sx * radius;
  const oy = ly + sy * radius;
  // arc-local coordinates: `a` runs back towards the vertical line, `b` back
  // towards the horizontal one
  const at = (a: number, b: number): [number, number] => [ox - sx * a, oy - sy * b];
  const quad = (a1: number, b1: number, a: number, b: number): [number, number, number, number] => {
    const [cx, cy] = at(a1, b1);
    const [x, y] = at(a, b);
    return [cx, cy, x, y];
  };
  const verticalEdge = sy > 0 ? box.height : 0;
  const horizontalEdge = sx > 0 ? box.width : 0;
  const bEdge = (oy - verticalEdge) / sy;
  const aEdge = (ox - horizontalEdge) / sx;
  const outer = radius + half;
  const inner = radius - half;
  pen.path([
    [
      at(outer, bEdge),
      at(outer, 0),
      quad(outer, outer * ARC_T, outer * ARC_S, outer * ARC_S),
      quad(outer * ARC_T, outer, 0, outer),
      at(aEdge, outer),
      at(aEdge, inner),
      at(0, inner),
      quad(inner * ARC_T, inner, inner * ARC_S, inner * ARC_S),
      quad(inner, inner * ARC_T, inner, 0),
      at(inner, bEdge),
    ],
  ]);
}

/** `╱`, `╲` and `╳`: corner to corner, a light line thick measured across it. */
function drawDiagonal(codePoint: number, box: CellBox, pen: Pen): void {
  const { height: h, width: w } = box;
  const across = (box.light / 2) * (Math.sqrt(w * w + h * h) / h);
  const contours: Contour[] = [];
  if (codePoint !== 0x25_72) {
    contours.push([
      [w - across, 0],
      [w + across, 0],
      [across, h],
      [-across, h],
    ]);
  }
  if (codePoint !== 0x25_71) {
    contours.push([
      [-across, 0],
      [across, 0],
      [w + across, h],
      [w - across, h],
    ]);
  }
  pen.path(contours);
}

/**
 * Block elements: eighths, halves, quadrants and shades.
 *
 * Every split is rounded once, through `rows()` and `columns()`, so `▀` and `▄`
 * meet at the same row and between them cover every row exactly once -- and the
 * same for the quadrants, which tile the cell.
 */
function drawBlock(codePoint: number, box: CellBox, pen: Pen): void {
  const { height: h, width: w } = box;
  const rows = (eighths: number): number => Math.round((h * eighths) / 8);
  const columns = (eighths: number): number => Math.round((w * eighths) / 8);
  const n = codePoint - 0x25_80;
  if (n === 0) {
    pen.rect(0, 0, w, rows(4));
  } else if (n >= 1 && n <= 8) {
    // the lower eighths, `▁` to `█`
    pen.rect(0, rows(8 - n), w, h);
  } else if (n >= 9 && n <= 15) {
    // the left eighths, `▉` (seven) down to `▏` (one)
    pen.rect(0, 0, columns(16 - n), h);
  } else if (n === 0x10) {
    pen.rect(columns(4), 0, w, h);
  } else if (n >= 0x11 && n <= 0x13) {
    // the shades, as an even tone: a pattern would alias against the pixel grid
    pen.rect(0, 0, w, h, (n - 0x10) / 4);
  } else if (n === 0x14) {
    pen.rect(0, 0, w, rows(1));
  } else if (n === 0x15) {
    pen.rect(columns(7), 0, w, h);
  } else {
    // the quadrants, as bits: upper left, upper right, lower left, lower right
    const QUADRANTS = [
      0b0010, 0b0001, 0b1000, 0b1011, 0b1001, 0b1110, 0b1101, 0b0100, 0b0110, 0b0111,
    ];
    const bits = QUADRANTS[n - 0x16];
    const mx = columns(4);
    const my = rows(4);
    if (bits & 0b1000) {
      pen.rect(0, 0, mx, my);
    }
    if (bits & 0b0100) {
      pen.rect(mx, 0, w, my);
    }
    if (bits & 0b0010) {
      pen.rect(0, my, mx, h);
    }
    if (bits & 0b0001) {
      pen.rect(mx, my, w, h);
    }
  }
}

/**
 * Braille: a 2x4 grid of dots, as squares centred in equal shares of the cell.
 *
 * Squares rather than discs, because a dot is a few pixels across at any size
 * a screenshot is taken at and a disc of three pixels is a square with its
 * corners blurred. The dot numbering is Unicode's: 1-2-3 down the left column,
 * 4-5-6 down the right, then 7 and 8 along the bottom.
 */
function drawBraille(pattern: number, box: CellBox, pen: Pen): void {
  const { height: h, width: w } = box;
  const size = Math.max(1, Math.round(Math.min(w / 2, h / 4) * 0.6));
  const DOTS: readonly [column: number, row: number][] = [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 1],
    [1, 2],
    [0, 3],
    [1, 3],
  ];
  for (let bit = 0; bit < 8; bit++) {
    if (!(pattern & (1 << bit))) {
      continue;
    }
    const [column, row] = DOTS[bit];
    const x = Math.round(((column + 0.5) * w) / 2 - size / 2);
    const y = Math.round(((row + 0.5) * h) / 4 - size / 2);
    pen.rect(x, y, x + size, y + size);
  }
}

/**
 * The box drawn for a character no font has: an outline inset from the cell, so
 * a missing glyph is visibly missing rather than silently a space.
 *
 * @param box - The cell, or both cells of a wide character.
 * @param pen - Where to draw.
 */
export function drawTofu(box: CellBox, pen: Pen): void {
  const { height: h, light: t, width: w } = box;
  const mx = Math.max(1, Math.round(w / 8));
  const my = Math.max(1, Math.round(h / 6));
  pen.rect(mx, my, w - mx, my + t);
  pen.rect(mx, h - my - t, w - mx, h - my);
  pen.rect(mx, my, mx + t, h - my);
  pen.rect(w - mx - t, my, w - mx, h - my);
}
