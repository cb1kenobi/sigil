import { Accumulator, rasterizeOutline } from '../src/font/raster.js';
import { type CellBox, CoveragePen, drawGeometry, drawTofu, isGeometry } from '../src/geometry.js';
import { describe, expect, it } from 'vitest';

/**
 * The geometry a PNG and an SVG both draw, read as coverage: a cell of bytes
 * where 255 is ink. Asserted on the claims that make geometry worth drawing --
 * that lines reach the edge where a neighbour's line starts, and that blocks
 * split a cell without a gap or an overlap.
 */

const BOX: CellBox = { height: 18, light: 1, width: 8 };

/** A cell drawn through the pen the PNG path uses. */
function cell(char: string, box: CellBox = BOX): Uint8Array {
  const pen = new CoveragePen(box.width, box.height);
  if (char === 'tofu') {
    drawTofu(box, pen);
  } else {
    expect(drawGeometry(char.codePointAt(0) ?? 0, box, pen)).toBe(true);
  }
  return pen.data;
}

const at = (data: Uint8Array, x: number, y: number, box = BOX): number => data[y * box.width + x];
const row = (data: Uint8Array, y: number, box = BOX): number[] =>
  Array.from(data.subarray(y * box.width, (y + 1) * box.width));
const column = (data: Uint8Array, x: number, box = BOX): number[] =>
  Array.from({ length: box.height }, (_, y) => data[y * box.width + x]);
const inked = (data: Uint8Array): number => data.filter((v) => v === 255).length;

const cx = Math.floor(BOX.width / 2);
const cy = Math.floor(BOX.height / 2);

describe('which characters are geometry', () => {
  it('should claim box drawing, blocks and braille and nothing either side', () => {
    expect(isGeometry(0x25_00)).toBe(true);
    expect(isGeometry(0x25_9f)).toBe(true);
    expect(isGeometry(0x28_00)).toBe(true);
    expect(isGeometry(0x28_ff)).toBe(true);
    expect(isGeometry(0x24_ff)).toBe(false);
    expect(isGeometry(0x25_a0)).toBe(false);
    expect(isGeometry(0x29_00)).toBe(false);
    expect(isGeometry(0x41)).toBe(false);
  });
});

describe('box drawing', () => {
  it('should run a horizontal line edge to edge on the centre row', () => {
    const line = cell('─');
    expect(row(line, cy)).toEqual(Array(BOX.width).fill(255));
    expect(inked(line)).toBe(BOX.width);
  });

  it('should run a vertical line edge to edge on the centre column', () => {
    const line = cell('│');
    expect(column(line, cx)).toEqual(Array(BOX.height).fill(255));
    expect(inked(line)).toBe(BOX.height);
  });

  it('should meet a corner without a notch', () => {
    const corner = cell('┌');
    expect(at(corner, cx, cy)).toBe(255);
    expect(at(corner, BOX.width - 1, cy)).toBe(255);
    expect(at(corner, cx, BOX.height - 1)).toBe(255);
    expect(at(corner, 0, cy)).toBe(0);
    expect(at(corner, cx, 0)).toBe(0);
  });

  it('should draw a cross as exactly its two lines', () => {
    expect(inked(cell('┼'))).toBe(BOX.width + BOX.height - 1);
  });

  it('should draw heavy twice as thick as light', () => {
    expect(inked(cell('━'))).toBe(BOX.width * 2);
  });

  it('should draw a double line as two lines with a gap', () => {
    const line = cell('═');
    expect(row(line, cy - 1)).toEqual(Array(BOX.width).fill(255));
    expect(row(line, cy)).toEqual(Array(BOX.width).fill(0));
    expect(row(line, cy + 1)).toEqual(Array(BOX.width).fill(255));
  });

  it('should open a double cross into four corners', () => {
    // the gaps between the lines stay open through the junction
    const cross = cell('╬');
    expect(at(cross, cx, cy)).toBe(0);
    expect(at(cross, cx, 0)).toBe(0);
    expect(at(cross, 0, cy)).toBe(0);
    // and each quadrant's corner is closed
    expect(at(cross, cx + 1, cy - 1)).toBe(255);
    expect(at(cross, cx - 1, cy + 1)).toBe(255);
  });

  it('should turn a double corner on the outside and the inside', () => {
    const corner = cell('╔');
    // the outer line turns at the far side, the inner one at the near side
    expect(at(corner, cx - 1, cy - 1)).toBe(255);
    expect(at(corner, cx + 1, cy + 1)).toBe(255);
    expect(at(corner, cx, cy)).toBe(0);
    // nothing escapes up or left
    expect(at(corner, cx - 1, 0)).toBe(0);
    expect(at(corner, 0, cy - 1)).toBe(0);
  });

  it('should leave the double side of a tee open', () => {
    // `╠`: the right-hand vertical line has its opening where the arm joins
    const tee = cell('╠');
    expect(at(tee, cx - 1, cy)).toBe(255);
    expect(at(tee, cx + 1, cy)).toBe(0);
  });

  it('should meet a single line at the near double line of a tee', () => {
    // `╟`: the single arm touches the right line and does not cross the gap
    const tee = cell('╟');
    expect(at(tee, cx + 2, cy)).toBe(255);
    expect(at(tee, cx, cy)).toBe(0);
  });

  it('should end an arc where a straight line would carry on', () => {
    // `╭` leaves through the bottom on the centre column and through the right
    // edge on the centre row -- exactly where `│` and `─` start
    const arc = cell('╭');
    expect(at(arc, cx, BOX.height - 1)).toBeGreaterThan(200);
    expect(at(arc, BOX.width - 1, cy)).toBeGreaterThan(200);
    expect(at(arc, 0, 0)).toBe(0);
    expect(at(arc, 0, cy)).toBe(0);
  });

  it('should draw a diagonal from corner to corner', () => {
    const slash = cell('╱');
    expect(at(slash, BOX.width - 1, 0)).toBeGreaterThan(0);
    expect(at(slash, 0, BOX.height - 1)).toBeGreaterThan(0);
    expect(at(slash, 0, 0)).toBe(0);
    const cross = cell('╳');
    expect(at(cross, 0, 0)).toBeGreaterThan(0);
    expect(at(cross, BOX.width - 1, 0)).toBeGreaterThan(0);
  });

  it('should dash a dashed line', () => {
    const dashes = row(cell('┄'), cy);
    expect(dashes.filter((v) => v === 255).length).toBeGreaterThan(0);
    expect(dashes.filter((v) => v === 0).length).toBeGreaterThan(0);
  });
});

describe('blocks', () => {
  it('should split a cell between the upper and lower half with no gap or overlap', () => {
    for (const height of [17, 18, 19, 36]) {
      const box = { ...BOX, height };
      const upper = cell('▀', box);
      const lower = cell('▄', box);
      for (let i = 0; i < upper.length; i++) {
        expect(upper[i] + lower[i], `${height}px, pixel ${i}`).toBe(255);
      }
    }
  });

  it('should tile the cell with the quadrants', () => {
    const quads = ['▘', '▝', '▖', '▗'].map((q) => cell(q));
    for (let i = 0; i < BOX.width * BOX.height; i++) {
      expect(quads.reduce((sum, q) => sum + q[i], 0)).toBe(255);
    }
    // and the three-quarter ones are the other three
    const missingLowerRight = cell('▛');
    for (let i = 0; i < missingLowerRight.length; i++) {
      expect(missingLowerRight[i] + quads[3][i]).toBe(255);
    }
  });

  it('should fill the full block completely', () => {
    expect(inked(cell('█'))).toBe(BOX.width * BOX.height);
  });

  it('should grow the eighths in order', () => {
    const lower = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'].map((c) => inked(cell(c)));
    const left = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'].map((c) => inked(cell(c)));
    for (const series of [lower, left]) {
      for (let i = 1; i < series.length; i++) {
        expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]);
      }
    }
  });

  it('should shade at a quarter, a half and three quarters', () => {
    expect(at(cell('░'), 0, 0)).toBe(64);
    expect(at(cell('▒'), 0, 0)).toBe(128);
    expect(at(cell('▓'), 0, 0)).toBe(191);
  });
});

describe('braille', () => {
  it('should draw no dots for the blank pattern and eight for the full one', () => {
    expect(inked(cell('⠀'))).toBe(0);
    const full = cell('⣿');
    const one = cell('⠁');
    expect(inked(full)).toBe(inked(one) * 8);
  });

  it('should put each dot in its own place', () => {
    const seen = new Set<string>();
    for (let bit = 0; bit < 8; bit++) {
      seen.add(cell(String.fromCodePoint(0x28_00 + (1 << bit))).join(','));
    }
    expect(seen.size).toBe(8);
  });

  it('should number the dots as Unicode does', () => {
    // dot 1 is top left and dot 8 bottom right
    const first = cell('⠁');
    const last = cell('⢀');
    expect(first.slice(0, (BOX.height / 4) * BOX.width).some((v) => v > 0)).toBe(true);
    const leftHalf = (data: Uint8Array): boolean =>
      data.some((v, i) => v > 0 && i % BOX.width < BOX.width / 2);
    expect(leftHalf(first)).toBe(true);
    expect(leftHalf(last)).toBe(false);
  });
});

describe('the tofu box', () => {
  it('should be an outline, hollow in the middle', () => {
    const tofu = cell('tofu');
    expect(inked(tofu)).toBeGreaterThan(0);
    expect(at(tofu, cx, cy)).toBe(0);
  });
});

describe('the coverage rasterizer', () => {
  it('should cover a pixel-aligned square exactly', () => {
    const acc = new Accumulator(4, 4);
    for (const [x0, y0, x1, y1] of [
      [1, 1, 3, 1],
      [3, 1, 3, 3],
      [3, 3, 1, 3],
      [1, 3, 1, 1],
    ]) {
      acc.line(x0, y0, x1, y1);
    }
    expect(Array.from(acc.coverage())).toEqual([
      0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0,
    ]);
  });

  it('should cover half a pixel by half', () => {
    const acc = new Accumulator(1, 1);
    acc.line(0, 0, 0.5, 0);
    acc.line(0.5, 0, 0.5, 1);
    acc.line(0.5, 1, 0, 1);
    acc.line(0, 1, 0, 0);
    expect(acc.coverage()[0]).toBe(128);
  });

  it('should read a contour in either direction the same', () => {
    const square = (clockwise: boolean): number[] => {
      const acc = new Accumulator(3, 3);
      const points = [
        [0.5, 0.5],
        [2.5, 0.5],
        [2.5, 2.5],
        [0.5, 2.5],
      ];
      const ordered = clockwise ? points : points.toReversed();
      ordered.forEach((p, i) => {
        const q = ordered[(i + 1) % ordered.length];
        acc.line(p[0], p[1], q[0], q[1]);
      });
      return Array.from(acc.coverage());
    };
    expect(square(true)).toEqual(square(false));
  });

  it('should widen a glyph it emboldens, and lean one it shears', () => {
    const stem = [
      [
        { onCurve: true, x: 0, y: 0 },
        { onCurve: true, x: 100, y: 0 },
        { onCurve: true, x: 100, y: 700 },
        { onCurve: true, x: 0, y: 700 },
      ],
    ];
    const plain = rasterizeOutline(stem, { embolden: 0, scale: 0.02, shear: 0, x: 0 });
    const bold = rasterizeOutline(stem, { embolden: 1, scale: 0.02, shear: 0, x: 0 });
    const italic = rasterizeOutline(stem, { embolden: 0, scale: 0.02, shear: 0.2, x: 0 });
    const sum = (c: typeof plain): number => (c ? c.data.reduce((a, b) => a + b, 0) : 0);
    expect(sum(bold)).toBeGreaterThan(sum(plain));
    expect(italic?.width).toBeGreaterThan(plain?.width ?? 0);
    expect(rasterizeOutline([], { embolden: 0, scale: 1, shear: 0, x: 0 })).toBeUndefined();
  });
});
