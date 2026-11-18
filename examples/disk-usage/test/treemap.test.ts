import { CATEGORIES } from '../src/disk.ts';
import type { DiskNode } from '../src/scan.ts';
import {
  type Box,
  categoryColor,
  inside,
  layoutMap,
  markFor,
  paintMap,
  squarify,
  tileAt,
} from '../src/treemap.ts';
import { createCanvas, DEFAULT_COLOR, palette, rgb, type Style } from '@ttylabs/sigil/canvas';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The layout and the paint, over trees built by hand: what goes where at a size,
 * and what reaches the cells. The tree's paths are spelled with `join()`, so the
 * lookups by path mean the same on every platform.
 */

const ROOT = join(sep, 'root');

/** A file of `bytes` under `dir`. */
function file(dir: string, name: string, bytes: number): DiskNode {
  return {
    bytes,
    category: name.endsWith('.ts') ? 'code' : name.endsWith('.png') ? 'image' : 'other',
    files: 1,
    kind: 'file',
    name,
    path: join(dir, name),
    size: bytes,
  };
}

/** A directory over its contents, largest first, as the scan builds one. */
function dir(path: string, children: readonly DiskNode[]): DiskNode {
  const sorted = children.toSorted((a, b) => b.bytes - a.bytes);
  const mix = CATEGORIES.map((category) =>
    sorted.filter((c) => c.category === category).reduce((n, c) => n + c.bytes, 0)
  );
  return {
    bytes: sorted.reduce((n, c) => n + c.bytes, 0),
    category: CATEGORIES[mix.indexOf(Math.max(...mix))] ?? 'other',
    children: sorted,
    files: sorted.reduce((n, c) => n + c.files, 0),
    kind: 'directory',
    mix,
    name: path.slice(path.lastIndexOf(sep) + 1),
    path,
    size: 0,
  };
}

/** Whether two boxes share a pixel. */
function overlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('squarify()', () => {
  it('should give each value its share of the box, inside it, with no two overlapping', () => {
    // the paper's own example
    const values = [6, 6, 4, 3, 2, 2, 1];
    const rects = squarify(values, { h: 4, w: 6, x: 0, y: 0 });
    expect(rects).toHaveLength(values.length);
    for (const [i, r] of rects.entries()) {
      expect(r.w * r.h).toBeCloseTo(values[i] as number, 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(6 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(4 + 1e-9);
      for (const other of rects.slice(i + 1)) {
        const shrunk = { h: r.h - 1e-6, w: r.w - 1e-6, x: r.x, y: r.y };
        expect(overlap(shrunk, other)).toBe(false);
      }
    }
    // and keeps them near square, which is the point of it: the worst here is
    // the last one's 25/9, where a strip of the same seven runs to 24
    const worst = Math.max(...rects.map((r) => Math.max(r.w / r.h, r.h / r.w)));
    expect(worst).toBeCloseTo(25 / 9, 6);
  });

  it('should give a value of nothing no room, and an empty box nothing', () => {
    const [full, none] = squarify([5, 0], { h: 2, w: 5, x: 0, y: 0 }).map((r) => r.w * r.h);
    expect(full).toBeCloseTo(10, 6);
    expect(none).toBe(0);
    expect(squarify([1, 2], { h: 0, w: 5, x: 0, y: 0 }).every((r) => r.w * r.h === 0)).toBe(true);
  });
});

describe('layoutMap()', () => {
  it('should size each file by its bytes and never overlap two', () => {
    const root = dir(ROOT, [file(ROOT, 'big.ts', 3000), file(ROOT, 'small.png', 1000)]);
    const layout = layoutMap(root, 12, 6);
    expect(layout.tiles.map((t) => [t.node.name, t.w * t.h])).toStrictEqual([
      ['big.ts', 54],
      ['small.png', 18],
    ]);
    expect(overlap(layout.tiles[0] as Box, layout.tiles[1] as Box)).toBe(false);
  });

  it('should keep tiles inside the map, apart, whatever the tree', () => {
    const sub = join(ROOT, 'sub');
    const deep = join(sub, 'deep');
    const root = dir(ROOT, [
      dir(sub, [
        dir(
          deep,
          Array.from({ length: 30 }, (_, i) => file(deep, `f${i}.ts`, 100 + i * 37))
        ),
        file(sub, 'one.png', 4000),
      ]),
      ...Array.from({ length: 12 }, (_, i) => file(ROOT, `r${i}.ts`, 500 * (i + 1))),
    ]);
    for (const [w, h] of [
      [40, 30],
      [17, 9],
      [3, 3],
      [120, 70],
    ] as const) {
      const layout = layoutMap(root, w, h);
      for (const [i, tile] of layout.tiles.entries()) {
        expect(tile.w).toBeGreaterThan(0);
        expect(tile.h).toBeGreaterThan(0);
        expect(tile.x + tile.w).toBeLessThanOrEqual(w);
        expect(tile.y + tile.h).toBeLessThanOrEqual(h);
        for (const other of layout.tiles.slice(i + 1)) {
          expect(overlap(tile, other)).toBe(false);
        }
      }
    }
  });

  it('should gather the items too small to draw into one rest, largest first', () => {
    const small = Array.from({ length: 50 }, (_, i) => file(ROOT, `tiny${i}.ts`, 1 + i));
    const root = dir(ROOT, [file(ROOT, 'huge.png', 100_000), ...small]);
    const layout = layoutMap(root, 40, 40);
    const rest = layout.rests.get(ROOT);
    expect(rest?.kind).toBe('rest');
    expect(rest?.rest).toHaveLength(50);
    expect(rest?.rest?.[0]?.name).toBe('tiny49.ts');
    // and nothing gathered has a tile of its own
    expect(layout.byPath.has(join(ROOT, 'tiny0.ts'))).toBe(false);
    expect(layout.byPath.get(join(ROOT, 'huge.png'))?.kind).toBe('file');
  });

  it('should outline nothing for an item laid as a sliver that rounds to nothing', () => {
    // nine pixels is room enough on paper, but squarify lays the nine-byte file
    // as a column 0.45 wide, which rounds to no column at all
    const root = dir(ROOT, [file(ROOT, 'big.ts', 391), file(ROOT, 'sliver.ts', 9)]);
    const layout = layoutMap(root, 20, 20);
    expect(layout.byPath.has(join(ROOT, 'sliver.ts'))).toBe(false);
    for (const tile of layout.tiles) {
      expect(tile.w * tile.h).toBeGreaterThan(0);
    }
    // it is not drawn, so nothing is outlined for it -- not the whole
    // directory's box, which outlined the entire map
    expect(markFor(layout, join(ROOT, 'sliver.ts'), ROOT)).toBeUndefined();
  });

  it('should draw a directory in one piece where none of its items has room', () => {
    const sub = join(ROOT, 'sub');
    // the directory gets about 3% of 400 pixels, room for a tile of its own, and
    // a tenth of that for each file in it, which is room for none
    const many = dir(
      sub,
      Array.from({ length: 10 }, (_, i) => file(sub, `${i}.ts`, 30))
    );
    const layout = layoutMap(dir(ROOT, [file(ROOT, 'big.ts', 10_000), many]), 20, 20);
    expect(layout.byPath.get(sub)?.kind).toBe('whole');
    expect(layout.dirs.has(sub)).toBe(false);
    // and with room, it is divided
    const roomy = layoutMap(dir(ROOT, [many]), 20, 20);
    expect(roomy.dirs.has(sub)).toBe(true);
    expect(roomy.byPath.get(join(sub, '0.ts'))?.kind).toBe('file');
  });

  it('should give nothing that counts for nothing any room', () => {
    const root = dir(ROOT, [file(ROOT, 'a.ts', 100), file(ROOT, 'empty.ts', 0)]);
    const layout = layoutMap(root, 10, 10);
    expect(layout.tiles.map((t) => t.node.name)).toStrictEqual(['a.ts']);
    expect(layoutMap(dir(ROOT, [file(ROOT, 'z', 0)]), 10, 10).tiles).toHaveLength(0);
  });

  it('should hold back a column and a row inside a directory directly under the root', () => {
    // which directory the space went to is the map's first division, and the
    // edge is what shows it at every colour level
    const a = join(ROOT, 'a');
    const b = join(ROOT, 'b');
    const root = dir(ROOT, [
      dir(a, [file(a, '1.ts', 50), file(a, '2.ts', 50)]),
      dir(b, [file(b, '3.ts', 50), file(b, '4.ts', 50)]),
    ]);
    const layout = layoutMap(root, 20, 20);
    const box = layout.dirs.get(a) as Box;
    const inA = layout.tiles.filter((t) => t.node.path.startsWith(a + sep));
    expect(inA).toHaveLength(2);
    for (const tile of inA) {
      expect(tile.x + tile.w).toBeLessThanOrEqual(box.x + box.w - 1);
      expect(tile.y + tile.h).toBeLessThanOrEqual(box.y + box.h - 1);
    }
  });
});

describe('markFor()', () => {
  const sub = join(ROOT, 'sub');
  const tiny = join(ROOT, 'tinydir');
  const root = dir(ROOT, [
    file(ROOT, 'huge.png', 100_000),
    dir(sub, [file(sub, 'a.ts', 20_000), file(sub, 'b.ts', 20_000)]),
    dir(tiny, [file(tiny, 'x.ts', 30), file(tiny, 'y.ts', 20)]),
    ...Array.from({ length: 30 }, (_, i) => file(ROOT, `small${i}.ts`, 10 + i)),
  ]);
  const layout = layoutMap(root, 30, 30);

  it("should mark a file's own tile, and a divided directory's whole box", () => {
    expect(markFor(layout, join(ROOT, 'huge.png'), ROOT)).toBe(
      layout.byPath.get(join(ROOT, 'huge.png'))
    );
    expect(markFor(layout, join(sub, 'a.ts'), ROOT)).toBe(layout.byPath.get(join(sub, 'a.ts')));
    expect(markFor(layout, sub, ROOT)).toBe(layout.dirs.get(sub));
  });

  it('should mark what an item too small to draw was gathered into', () => {
    // a small file is in the root's rest, and so is a small directory and what
    // is in it
    const rest = layout.rests.get(ROOT);
    expect(rest).toBeDefined();
    expect(markFor(layout, join(ROOT, 'small0.ts'), ROOT)).toBe(rest);
    expect(markFor(layout, join(tiny, 'x.ts'), ROOT)).toBe(rest);
  });

  it('should mark nothing for a path the map does not hold', () => {
    expect(markFor(layout, join(sep, 'elsewhere', 'a.ts'), ROOT)).toBeUndefined();
    // nor above the map's root
    expect(markFor(layout, join(ROOT, 'huge.png'), sub)).toBeUndefined();
  });
});

describe('tileAt()', () => {
  it('should find the tile under a pixel, and nothing off the map', () => {
    const root = dir(ROOT, [file(ROOT, 'left.ts', 500), file(ROOT, 'right.png', 500)]);
    const layout = layoutMap(root, 10, 4);
    expect(tileAt(layout, 0, 0)?.node.name).toBe('left.ts');
    expect(tileAt(layout, 9, 3)?.node.name).toBe('right.png');
    expect(tileAt(layout, 10, 0)).toBeUndefined();
  });
});

describe('categoryColor()', () => {
  it('should give each category a colour of its own at every level with colour', () => {
    for (const level of [1, 2, 3]) {
      const colours = CATEGORIES.map((category) => categoryColor(category, level));
      expect(new Set(colours).size, `level ${level}`).toBe(CATEGORIES.length);
      // the selection is bright white, which no category is at 16 colours
      if (level === 1) {
        expect(colours).not.toContain(palette(15));
      }
    }
  });

  it("should be the terminal's own at level 0", () => {
    expect(categoryColor('code', 0)).toBe(DEFAULT_COLOR);
  });
});

/** Paints a layout into a canvas the map's size and reads the cells back. */
function paint(
  layout: ReturnType<typeof layoutMap>,
  level: number,
  mark?: Box
): { rows: string[]; style: (x: number, y: number) => Style | undefined } {
  const height = Math.ceil(layout.height / 2);
  const canvas = createCanvas({ height, width: layout.width });
  canvas.paint((painter) => paintMap(painter, 0, 0, layout, { level, mark }));
  // the frame as presented knows its styles, which the grid being painted does not
  canvas.present();
  const frame = canvas.snapshot();
  const rows = Array.from({ length: height }, (_, y) =>
    Array.from({ length: layout.width }, (_, x) => frame.charAt(x, y)).join('')
  );
  return { rows, style: (x, y) => frame.cellStyle(x, y) };
}

describe('paintMap()', () => {
  it('should keep two tiles of one colour apart by an edge at every level', () => {
    const root = dir(ROOT, [file(ROOT, 'a.ts', 500), file(ROOT, 'b.ts', 500)]);
    const layout = layoutMap(root, 10, 4);
    for (const level of [0, 1, 2, 3]) {
      const { rows, style } = paint(layout, level);
      // `a.ts` is the left five columns; its last column is the edge
      expect(rows[0]?.[4], `level ${level}`).toBe(' ');
      expect(rows[0]?.[0], `level ${level}`).not.toBe(' ');
      expect(rows[0]?.[5], `level ${level}`).not.toBe(' ');
      if (level > 0) {
        // and the edge is the terminal's own, not a colour that might match
        expect(style(4, 1)?.bg).toBe(DEFAULT_COLOR);
        expect(style(4, 1)?.fg).toBe(DEFAULT_COLOR);
        expect(style(0, 1)?.fg).not.toBe(DEFAULT_COLOR);
      }
    }
  });

  it('should draw a tile of many files with a texture, and one file solid', () => {
    const sub = join(ROOT, 'sub');
    const root = dir(ROOT, [
      file(ROOT, 'one.ts', 10_000),
      dir(
        sub,
        Array.from({ length: 20 }, (_, i) => file(sub, `${i}.ts`, 100))
      ),
    ]);
    const layout = layoutMap(root, 40, 20);
    const whole = layout.byPath.get(sub);
    expect(whole?.kind).toBe('whole');
    const { rows } = paint(layout, 0);
    const solid = inside(layout.byPath.get(join(ROOT, 'one.ts')) as Box);
    // a solid tile's cells away from its edges and its name are full blocks
    expect(rows[Math.ceil(solid.y / 2) + 2]?.[solid.x + 1]).toBe('█');
    const at = inside(whole as Box);
    const cells = rows
      .slice(Math.ceil(at.y / 2) + 1, Math.floor((at.y + at.h) / 2))
      .map((row) => row.slice(at.x, at.x + at.w))
      .join('');
    expect(cells).toMatch(/[▀▄]/);
    expect(cells).not.toContain('█');
  });

  it('should outline the selection, and at level 0 draw a selected tile hollow', () => {
    const root = dir(ROOT, [file(ROOT, 'a.ts', 500), file(ROOT, 'b.ts', 500)]);
    const layout = layoutMap(root, 20, 12);
    const tile = layout.byPath.get(join(ROOT, 'a.ts')) as Box;
    const plain = paint(layout, 0).rows;
    const marked = paint(layout, 0, tile).rows;
    // the middle of the tile is a block until it is selected
    const y = Math.floor((tile.y + tile.h / 2) / 2);
    const x = tile.x + Math.floor(tile.w / 2);
    expect(plain[y]?.[x]).toBe('█');
    expect(marked[y]?.[x]).toBe(' ');
    // and its left edge is still drawn
    expect(marked[y]?.[tile.x]).toBe('█');

    // at truecolor the outline is white
    const lit = paint(layout, 3, tile).style(tile.x, y);
    expect([lit?.fg, lit?.bg]).toContain(rgb(255, 255, 255));
  });

  it('should write a name on a tile wide enough, and keep it off the outline', () => {
    const root = dir(ROOT, [file(ROOT, 'alpha.ts', 600), file(ROOT, 'beta.png', 400)]);
    const layout = layoutMap(root, 30, 12);
    expect(paint(layout, 0).rows.join('\n')).toMatch(/alpha\.ts/);
    const tile = layout.byPath.get(join(ROOT, 'alpha.ts')) as Box;
    const rows = paint(layout, 0, tile).rows;
    const row = rows.findIndex((line) => line.includes('alpha'));
    expect(row).toBeGreaterThan(0);
    // the name starts inside the outline's left edge, not on it
    expect(rows[row]?.indexOf('alpha')).toBeGreaterThan(tile.x);
  });
});
