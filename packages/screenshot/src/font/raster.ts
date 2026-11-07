import type { Outline } from './truetype.js';

/**
 * Coverage rasterizing: a path in, a bitmap of how much of each pixel it covers
 * out.
 *
 * The signed-area accumulation that `font-rs` popularized, written out again
 * here because the package takes no dependencies. Each line segment deposits, in
 * every pixel row it crosses, the area it leaves to its right and the change in
 * winding it carries past that pixel; a running sum along each row then turns
 * those deposits into exact coverage for a non-zero fill of non-overlapping
 * contours. It is analytic rather than supersampled, so an edge is anti-aliased
 * by the area it actually cuts and there is no sampling pattern to see.
 *
 * Deterministic by construction: addition, multiplication, division and
 * `Math.sqrt()` are all correctly rounded in IEEE 754, nothing here reads a
 * transcendental function whose last bit an engine may choose, and the curve is
 * flattened into a number of segments that depends only on its own points. Two
 * runs of the same input produce the same bytes, which is what a golden file
 * needs.
 */

/** A coverage bitmap: one byte per pixel, 0 for none and 255 for all. */
export interface Coverage {
  data: Uint8Array;
  height: number;
  /** Where the bitmap's top-left pixel sits, relative to the origin it was drawn at. */
  left: number;
  top: number;
  width: number;
}

/** How a glyph's outline is placed onto pixels. */
export interface Placement {
  /**
   * How far a synthesized bold is smeared to the right, in pixels. `0` for none.
   *
   * The outline is drawn a second time that far along, into the same buffer, and
   * the winding of the two copies sums where they overlap -- which the clamp to
   * one turns into their union. Cheaper than offsetting the outline, and the
   * stroke widens on one side only, which is what a terminal's synthetic bold
   * does as well.
   */
  embolden: number;
  /** Pixels per font unit. */
  scale: number;
  /** Horizontal shear per unit of height, for a synthesized italic. `0` for none. */
  shear: number;
  /** Where the glyph origin lands, relative to the bitmap origin, in pixels. */
  x: number;
}

/**
 * Accumulates segments into a buffer and resolves them to coverage.
 *
 * The buffer is one column wider than the bitmap, because a segment's area is
 * split between the pixel it ends in and the one after it, and the last column's
 * "after" has to exist for the sum to close.
 */
export class Accumulator {
  readonly width: number;
  readonly height: number;
  #acc: Float64Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.#acc = new Float64Array((width + 2) * height);
  }

  /**
   * Adds a straight edge, in pixel coordinates with y down.
   *
   * A horizontal edge carries no winding and is skipped; every other one is
   * clipped to the rows of the bitmap. Columns are clamped rather than clipped,
   * which keeps the winding right for anything that strays past an edge -- a
   * caller sizes the bitmap to the outline, so that is a rounding error's worth.
   */
  line(x0: number, y0: number, x1: number, y1: number): void {
    if (y0 === y1) {
      return;
    }
    const width = this.width;
    const stride = width + 2;
    const acc = this.#acc;
    let dir = 1;
    if (y0 > y1) {
      dir = -1;
      [x0, y0, x1, y1] = [x1, y1, x0, y0];
    }
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0;
    if (y0 < 0) {
      x -= y0 * dxdy;
    }
    const top = Math.max(0, Math.floor(y0));
    const bottom = Math.min(this.height, Math.ceil(y1));
    for (let y = top; y < bottom; y++) {
      const row = y * stride;
      const dy = Math.min(y + 1, y1) - Math.max(y, y0);
      const xnext = x + dxdy * dy;
      const d = dy * dir;
      const xa = clamp(x < xnext ? x : xnext, width);
      const xb = clamp(x < xnext ? xnext : x, width);
      const xaFloor = Math.floor(xa);
      const xbCeil = Math.ceil(xb);
      if (xbCeil <= xaFloor + 1) {
        // the whole crossing is inside one pixel: split by where its middle is
        const mid = 0.5 * (xa + xb) - xaFloor;
        acc[row + xaFloor] += d - d * mid;
        acc[row + xaFloor + 1] += d * mid;
      } else {
        const s = 1 / (xb - xa);
        const xaFrac = xa - xaFloor;
        const a0 = 0.5 * s * (1 - xaFrac) * (1 - xaFrac);
        const xbFrac = xb - xbCeil + 1;
        const am = 0.5 * s * xbFrac * xbFrac;
        acc[row + xaFloor] += d * a0;
        if (xbCeil === xaFloor + 2) {
          acc[row + xaFloor + 1] += d * (1 - a0 - am);
        } else {
          const a1 = s * (1.5 - xaFrac);
          acc[row + xaFloor + 1] += d * (a1 - a0);
          for (let xi = xaFloor + 2; xi < xbCeil - 1; xi++) {
            acc[row + xi] += d * s;
          }
          const a2 = a1 + (xbCeil - xaFloor - 3) * s;
          acc[row + xbCeil - 1] += d * (1 - a2 - am);
        }
        acc[row + xbCeil] += d * am;
      }
      x = xnext;
    }
  }

  /**
   * Adds a quadratic Bezier, flattened into lines.
   *
   * The segment count is from the curve's own deviation -- the distance between
   * its control point and the chord's midpoint, roughly -- so a flat curve costs
   * one line and a tight one enough that no chord strays a tenth of a pixel. It
   * depends on the points alone, which is what keeps the output deterministic.
   */
  quad(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): void {
    const ddx = x0 - 2 * cx + x1;
    const ddy = y0 - 2 * cy + y1;
    const deviation = ddx * ddx + ddy * ddy;
    if (deviation < 0.333) {
      this.line(x0, y0, x1, y1);
      return;
    }
    const segments = 1 + Math.floor(Math.sqrt(Math.sqrt(3 * deviation)));
    let px = x0;
    let py = y0;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const u = 1 - t;
      const nx = u * u * x0 + 2 * u * t * cx + t * t * x1;
      const ny = u * u * y0 + 2 * u * t * cy + t * t * y1;
      this.line(px, py, nx, ny);
      px = nx;
      py = ny;
    }
  }

  /**
   * The coverage, as bytes.
   *
   * A running sum per row, its magnitude clamped to one: non-zero winding for
   * contours that do not overlap themselves, and an approximation of it where
   * they do, which a font whose overlaps were removed at build time never meets.
   */
  coverage(): Uint8Array {
    const width = this.width;
    const stride = width + 2;
    const out = new Uint8Array(width * this.height);
    for (let y = 0; y < this.height; y++) {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        sum += this.#acc[y * stride + x];
        const a = Math.abs(sum);
        out[y * width + x] = a >= 1 ? 255 : Math.round(a * 255);
      }
    }
    return out;
  }
}

function clamp(x: number, width: number): number {
  return x < 0 ? 0 : x > width ? width : x;
}

/**
 * Rasterizes a glyph outline.
 *
 * The bitmap is sized to the outline's bounds after placement, with a pixel of
 * slack on every side so that an edge landing exactly on a pixel boundary is not
 * clamped. `top` is the bitmap's first row relative to the baseline, so a caller
 * positions it at `baseline + top`.
 *
 * @param outline - The glyph, in font units with y up.
 * @param place - How it lands on pixels.
 * @returns The coverage, or `undefined` for a glyph with nothing to draw.
 */
export function rasterizeOutline(outline: Outline, place: Placement): Coverage | undefined {
  if (outline.length === 0) {
    return undefined;
  }
  const { scale, shear } = place;
  // to pixel space: x right, y down from the baseline
  const px = (x: number, y: number): number => place.x + (x + shear * y) * scale;
  const py = (y: number): number => -y * scale;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of outline) {
    for (const p of contour) {
      const x = px(p.x, p.y);
      const y = py(p.y);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) {
    return undefined;
  }
  const left = Math.floor(minX) - 1;
  const top = Math.floor(minY) - 1;
  const width = Math.ceil(maxX + place.embolden) + 1 - left;
  const height = Math.ceil(maxY) + 1 - top;
  const acc = new Accumulator(width, height);

  const copies = place.embolden > 0 ? [0, place.embolden] : [0];
  for (const shift of copies) {
    for (const contour of outline) {
      tracePath(contour, (x, y) => [px(x, y) - left + shift, py(y) - top], acc);
    }
  }

  return { data: acc.coverage(), height, left, top, width };
}

/**
 * Walks one TrueType contour into an accumulator.
 *
 * Two consecutive off-curve points imply an on-curve point between them, and a
 * contour may start off the curve -- in which case it starts at the first
 * on-curve point, or at the midpoint of the first two if there is none.
 */
function tracePath(
  contour: readonly { onCurve: boolean; x: number; y: number }[],
  to: (x: number, y: number) => [number, number],
  acc: Accumulator
): void {
  const n = contour.length;
  if (n < 2) {
    return;
  }
  const points = contour.map((p) => {
    const [x, y] = to(p.x, p.y);
    return { on: p.onCurve, x, y };
  });

  let startIndex = points.findIndex((p) => p.on);
  let start: { x: number; y: number };
  if (startIndex < 0) {
    start = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    startIndex = 0;
  } else {
    start = points[startIndex];
  }

  let cur = start;
  let control: { x: number; y: number } | undefined;
  for (let k = 1; k <= n; k++) {
    const p = points[(startIndex + k) % n];
    if (p.on) {
      if (control) {
        acc.quad(cur.x, cur.y, control.x, control.y, p.x, p.y);
        control = undefined;
      } else {
        acc.line(cur.x, cur.y, p.x, p.y);
      }
      cur = p;
    } else if (control) {
      const mid = { x: (control.x + p.x) / 2, y: (control.y + p.y) / 2 };
      acc.quad(cur.x, cur.y, control.x, control.y, mid.x, mid.y);
      cur = mid;
      control = p;
    } else {
      control = p;
    }
  }
  // closing back to where the walk started, through any pending control point
  if (control) {
    acc.quad(cur.x, cur.y, control.x, control.y, start.x, start.y);
  } else if (cur.x !== start.x || cur.y !== start.y) {
    acc.line(cur.x, cur.y, start.x, start.y);
  }
}
