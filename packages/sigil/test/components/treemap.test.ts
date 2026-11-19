import { createCanvas, DEFAULT_COLOR, palette, rgb, type Style } from '../../src/canvas/index.js';
import {
  inside,
  layoutTreemap,
  paintTreemap,
  squarify,
  Treemap,
  type TreemapBox,
  treemapColors,
  type TreemapLayout,
  type TreemapProps,
  type TreemapReader,
  treemapCellTile,
  treemapMark,
  treemapTileAt,
  treemapTileColors,
} from '../../src/components/treemap.js';
import { runApp } from '../../src/renderer/app.js';
import { Computed, State } from '../../src/signals/index.js';
import { quantizeColor } from '../../src/style/index.js';
import { createTestTerminal, frame } from '../../src/testing/index.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The treemap: the layout and the mark over trees built by hand, what reaches the
 * cells, and the element mounted on a test terminal. The layout's tests came with
 * it from the disk usage example (SIG-474), over a tree of named sizes rather than
 * files, keyed by a path spelled with `/` -- which is a key here, never a path on
 * any disk.
 */

/** A node of the tree these tests draw. */
interface Node {
  readonly children?: readonly Node[];
  readonly kind: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

/** An item of `size` under `dir`. */
function leaf(dir: string, name: string, size: number, kind = 'a'): Node {
  return { kind, name, path: `${dir}/${name}`, size };
}

/** An item over its children, largest first, as a scan builds one. */
function branch(path: string, children: readonly Node[]): Node {
  const sorted = children.toSorted((a, b) => b.size - a.size);
  return {
    children: sorted,
    kind: sorted[0]?.kind ?? 'a',
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    size: sorted.reduce((n, c) => n + c.size, 0),
  };
}

const ROOT = '/root';

const READ: TreemapReader<Node, string> = {
  children: (node) => node.children,
  key: (node) => node.path,
  size: (node) => node.size,
};

/** The parent of a key, which is what lets the mark walk up. */
function parentOf(path: string): string | undefined {
  const at = path.lastIndexOf('/');
  return at <= 0 ? undefined : path.slice(0, at);
}

const UP = { ...READ, parent: parentOf };

function layout(root: Node, w: number, h: number): TreemapLayout<Node, string> {
  return layoutTreemap(root, w, h, READ);
}

/** Whether two boxes share a pixel. */
function overlap(a: TreemapBox, b: TreemapBox): boolean {
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

describe('layoutTreemap()', () => {
  it('should size each item by its size and never overlap two', () => {
    const root = branch(ROOT, [leaf(ROOT, 'big', 3000), leaf(ROOT, 'small', 1000)]);
    const map = layout(root, 12, 6);
    expect(map.tiles.map((t) => [t.item.name, t.w * t.h])).toStrictEqual([
      ['big', 54],
      ['small', 18],
    ]);
    expect(overlap(map.tiles[0] as TreemapBox, map.tiles[1] as TreemapBox)).toBe(false);
  });

  it('should keep tiles inside the map, apart, whatever the tree', () => {
    const sub = `${ROOT}/sub`;
    const deep = `${sub}/deep`;
    const root = branch(ROOT, [
      branch(sub, [
        branch(
          deep,
          Array.from({ length: 30 }, (_, i) => leaf(deep, `f${i}`, 100 + i * 37))
        ),
        leaf(sub, 'one', 4000),
      ]),
      ...Array.from({ length: 12 }, (_, i) => leaf(ROOT, `r${i}`, 500 * (i + 1))),
    ]);
    for (const [w, h] of [
      [40, 30],
      [17, 9],
      [3, 3],
      [120, 70],
    ] as const) {
      const map = layout(root, w, h);
      for (const [i, tile] of map.tiles.entries()) {
        expect(tile.w).toBeGreaterThan(0);
        expect(tile.h).toBeGreaterThan(0);
        expect(tile.x + tile.w).toBeLessThanOrEqual(w);
        expect(tile.y + tile.h).toBeLessThanOrEqual(h);
        for (const other of map.tiles.slice(i + 1)) {
          expect(overlap(tile, other)).toBe(false);
        }
      }
    }
  });

  it('should gather the items too small to draw into one rest, largest first', () => {
    const small = Array.from({ length: 50 }, (_, i) => leaf(ROOT, `tiny${i}`, 1 + i));
    const root = branch(ROOT, [leaf(ROOT, 'huge', 100_000), ...small]);
    const map = layout(root, 40, 40);
    const rest = map.gathered.get(`${ROOT}/tiny0`);
    expect(rest?.kind).toBe('rest');
    expect(rest?.item).toBe(root);
    expect(rest?.rest).toHaveLength(50);
    expect(rest?.rest?.[0]?.name).toBe('tiny49');
    // every one of them is gathered into that tile, and none has a tile of its own
    for (const item of small) {
      expect(map.gathered.get(item.path)).toBe(rest);
      expect(map.byKey.has(item.path)).toBe(false);
    }
    expect(map.byKey.get(`${ROOT}/huge`)?.kind).toBe('leaf');
  });

  it('should outline nothing for an item laid as a sliver that rounds to nothing', () => {
    // nine pixels is room enough on paper, but squarify lays the nine-unit item
    // as a column 0.45 wide, which rounds to no column at all
    const root = branch(ROOT, [leaf(ROOT, 'big', 391), leaf(ROOT, 'sliver', 9)]);
    const map = layout(root, 20, 20);
    expect(map.byKey.has(`${ROOT}/sliver`)).toBe(false);
    for (const tile of map.tiles) {
      expect(tile.w * tile.h).toBeGreaterThan(0);
    }
    // it is not drawn, so nothing is outlined for it -- not the whole root's
    // box, which outlined the entire map
    expect(treemapMark(map, `${ROOT}/sliver`, UP)).toBeUndefined();
    expect(treemapMark(map, `${ROOT}/sliver`, READ)).toBeUndefined();
  });

  it('should draw an item in one piece where none of its children has room', () => {
    const sub = `${ROOT}/sub`;
    // the item gets about 3% of 400 pixels, room for a tile of its own, and a
    // tenth of that for each child, which is room for none
    const many = branch(
      sub,
      Array.from({ length: 10 }, (_, i) => leaf(sub, `${i}`, 30))
    );
    const map = layout(branch(ROOT, [leaf(ROOT, 'big', 10_000), many]), 20, 20);
    expect(map.byKey.get(sub)?.kind).toBe('whole');
    expect(map.divided.has(sub)).toBe(false);
    // and with room, it is divided
    const roomy = layout(branch(ROOT, [many]), 20, 20);
    expect(roomy.divided.has(sub)).toBe(true);
    expect(roomy.byKey.get(`${sub}/0`)?.kind).toBe('leaf');
  });

  it('should give nothing of no size any room', () => {
    const root: Node = {
      children: [
        leaf(ROOT, 'a', 100),
        leaf(ROOT, 'empty', 0),
        leaf(ROOT, 'nan', Number.NaN),
        leaf(ROOT, 'negative', -50),
      ],
      kind: 'a',
      name: 'root',
      path: ROOT,
      size: 100,
    };
    const map = layout(root, 10, 10);
    expect(map.tiles.map((t) => t.item.name)).toStrictEqual(['a']);
    expect(layout(branch(ROOT, [leaf(ROOT, 'z', 0)]), 10, 10).tiles).toHaveLength(0);
  });

  it('should hold back a column and a row inside an item directly under the root', () => {
    // which item the space went to is the map's first division, and the edge is
    // what shows it at every colour level
    const a = `${ROOT}/a`;
    const b = `${ROOT}/b`;
    const root = branch(ROOT, [
      branch(a, [leaf(a, '1', 50), leaf(a, '2', 50)]),
      branch(b, [leaf(b, '3', 50), leaf(b, '4', 50)]),
    ]);
    const map = layout(root, 20, 20);
    const box = map.divided.get(a) as TreemapBox;
    const inA = map.tiles.filter((t) => t.item.path.startsWith(`${a}/`));
    expect(inA).toHaveLength(2);
    for (const tile of inA) {
      expect(tile.x + tile.w).toBeLessThanOrEqual(box.x + box.w - 1);
      expect(tile.y + tile.h).toBeLessThanOrEqual(box.y + box.h - 1);
    }
  });

  it('should lay children out largest first whatever order they are handed in', () => {
    const items = [leaf(ROOT, 'small', 100), leaf(ROOT, 'big', 900), leaf(ROOT, 'mid', 400)];
    const unsorted: Node = { children: items, kind: 'a', name: 'root', path: ROOT, size: 1400 };
    const sorted = branch(ROOT, items);
    const boxes = (map: TreemapLayout<Node, string>): unknown[] =>
      map.tiles.map(({ h, item, w, x, y }) => [item.name, x, y, w, h]);
    expect(boxes(layout(unsorted, 20, 10))).toStrictEqual(boxes(layout(sorted, 20, 10)));
    // and the array handed in is left as it was
    expect(items.map((n) => n.name)).toStrictEqual(['small', 'big', 'mid']);
  });

  it('should divide an item among its children by theirs, whatever its own size says', () => {
    // a parent that counts something of its own beside its children: the
    // children fill its box, and their share of it is theirs over their sum
    const items = [leaf(ROOT, 'a', 300), leaf(ROOT, 'b', 100)];
    const heavy: Node = { children: items, kind: 'a', name: 'root', path: ROOT, size: 1_000_000 };
    const map = layout(heavy, 8, 8);
    expect(map.tiles.map((t) => [t.item.name, t.w * t.h])).toStrictEqual([
      ['a', 48],
      ['b', 16],
    ]);
  });

  it('should draw a root with no children as one tile', () => {
    const map = layout(leaf('', 'alone', 10), 6, 4);
    expect(map.tiles).toHaveLength(1);
    expect(map.tiles[0]).toMatchObject({ h: 4, kind: 'leaf', w: 6, x: 0, y: 0 });
  });
});

describe('treemapMark()', () => {
  const sub = `${ROOT}/sub`;
  const tiny = `${ROOT}/tinydir`;
  const deepBox = `${ROOT}/deepbox`;
  const root = branch(ROOT, [
    leaf(ROOT, 'huge', 100_000),
    branch(sub, [leaf(sub, 'a', 20_000), leaf(sub, 'b', 20_000)]),
    branch(tiny, [leaf(tiny, 'x', 30), leaf(tiny, 'y', 20)]),
    // a little over a pixel's worth of children each: drawn in one piece
    branch(
      deepBox,
      Array.from({ length: 40 }, (_, i) => leaf(deepBox, `d${i}`, 200))
    ),
    ...Array.from({ length: 30 }, (_, i) => leaf(ROOT, `small${i}`, 10 + i)),
  ]);
  const map = layout(root, 30, 30);

  it("should mark an item's own tile, and a divided item's whole box", () => {
    expect(treemapMark(map, `${ROOT}/huge`, READ)).toBe(map.byKey.get(`${ROOT}/huge`));
    expect(treemapMark(map, `${sub}/a`, READ)).toBe(map.byKey.get(`${sub}/a`));
    expect(treemapMark(map, sub, READ)).toBe(map.divided.get(sub));
  });

  it('should mark what an item too small to draw was gathered into', () => {
    // a small item is in the root's rest, with or without `parent`, and so is
    // what is under a small item, which only `parent` can find
    const rest = map.gathered.get(`${ROOT}/small0`);
    expect(rest?.kind).toBe('rest');
    expect(treemapMark(map, `${ROOT}/small0`, READ)).toBe(rest);
    expect(treemapMark(map, `${ROOT}/small0`, UP)).toBe(rest);
    expect(treemapMark(map, `${tiny}/x`, UP)).toBe(rest);
    expect(treemapMark(map, `${tiny}/x`, READ)).toBeUndefined();
  });

  it('should mark the tile of an ancestor drawn in one piece, given the way up', () => {
    const whole = map.byKey.get(deepBox);
    expect(whole?.kind).toBe('whole');
    expect(treemapMark(map, `${deepBox}/d3`, UP)).toBe(whole);
    expect(treemapMark(map, `${deepBox}/d3`, READ)).toBeUndefined();
  });

  it('should mark nothing for an item the map does not hold', () => {
    expect(treemapMark(map, '/elsewhere/a', UP)).toBeUndefined();
    // nor above the map's root
    const zoomed = layout(root.children?.[1] as Node, 30, 30);
    expect(treemapMark(zoomed, `${ROOT}/huge`, UP)).toBeUndefined();
  });

  it('should give up on a parent that leads back to itself', () => {
    const loop = (key: string): string => (key === '/a' ? '/b' : '/a');
    expect(treemapMark(map, '/a', { ...READ, parent: loop })).toBeUndefined();
  });
});

describe('treemapTileAt()', () => {
  it('should find the tile under a pixel, and nothing off the map', () => {
    const root = branch(ROOT, [leaf(ROOT, 'left', 500), leaf(ROOT, 'right', 500)]);
    const map = layout(root, 10, 4);
    expect(treemapTileAt(map, 0, 0)?.item.name).toBe('left');
    expect(treemapTileAt(map, 9, 3)?.item.name).toBe('right');
    expect(treemapTileAt(map, 10, 0)).toBeUndefined();
  });
});

describe('treemapColors()', () => {
  it('should leave a colour of the sixteen alone at 16, with its bright twin second', () => {
    expect(treemapColors(palette(4), 1)).toStrictEqual([palette(4), palette(12)]);
    expect(treemapColors(palette(12), 1)).toStrictEqual([palette(12), palette(4)]);
    // grey's twin is the light grey, not black, which a dark terminal would lose
    expect(treemapColors(palette(8), 1)).toStrictEqual([palette(8), palette(7)]);
  });

  it('should degrade an RGB to the sixteen and to 256, and darken its second', () => {
    const blue = rgb(78, 128, 226);
    const [sixteen, twin] = treemapColors(blue, 1);
    expect(sixteen).toBeLessThan(16);
    expect(twin).toBe(sixteen < 8 ? sixteen + 8 : sixteen === 8 ? 7 : sixteen - 8);
    const [fill, alt] = treemapColors(blue, 2);
    expect(fill).toBe(quantizeColor(blue, 2));
    expect(alt).not.toBe(fill);
    expect(treemapColors(blue, 3)).toStrictEqual([blue, rgb(58, 95, 167)]);
  });
});

describe('treemapCellTile()', () => {
  it('should give a cell to the tile whose colour it shows, not the one whose edge it holds', () => {
    // two bands five pixels tall: `top` is rows 0-4 and `bottom` 5-9, and row 4
    // is `top`'s edge -- so the third cell is `top`'s edge over `bottom`'s colour
    const root = branch(ROOT, [leaf(ROOT, 'top', 1), leaf(ROOT, 'bottom', 1)]);
    const map = layout(root, 8, 10);
    expect(treemapTileAt(map, 0, 4)?.item.name).toBe('top');
    expect(paint(map, 0).rows[2]).toMatch(/^▄+ $/u);
    expect(treemapCellTile(map, 0, 2, 3)?.item.name).toBe('bottom');
    // a cell coloured in both halves is the upper's, and the edge column between
    // two tiles side by side is still the box it is in
    expect(treemapCellTile(map, 0, 1, 3)?.item.name).toBe('top');
    expect(treemapCellTile(map, 7, 1, 3)?.item.name).toBe('top');
    expect(treemapCellTile(map, 8, 1, 3)).toBeUndefined();
  });

  it("should give a cell to the tile below where a texture's square above is not drawn", () => {
    // a tile of many things one pixel tall over a leaf: at level 0 the checker's
    // second squares are the terminal's own, so those cells show the leaf
    const many: TreemapLayout<Node, string> = {
      byKey: new Map(),
      divided: new Map(),
      gathered: new Map(),
      height: 4,
      rests: new Map(),
      tiles: [
        { cushion: [0, 0, 0, 0], depth: 1, h: 1, item: PAIR, kind: 'whole', w: 4, x: 0, y: 0 },
        { cushion: [0, 0, 0, 0], depth: 1, h: 3, item: LONE, kind: 'leaf', w: 4, x: 0, y: 1 },
      ],
      width: 4,
    };
    expect(paint(many, 0).rows[0]).toBe('█▄█ ');
    expect(treemapCellTile(many, 0, 0, 0)?.item).toBe(PAIR);
    expect(treemapCellTile(many, 1, 0, 0)?.item).toBe(LONE);
    // with colour, the second square is drawn, in the second shade
    expect(treemapCellTile(many, 1, 0, 1)?.item).toBe(PAIR);
  });
});

describe('treemapTileColors()', () => {
  it('should colour a tile of gathered items by what covers the most of them', () => {
    // twenty small items of one kind outweigh ten larger ones of another, and
    // the largest gathered item is one of the ten
    const blues = Array.from({ length: 20 }, (_, i) => leaf(ROOT, `blue${i}`, 30, 'blue'));
    const reds = Array.from({ length: 10 }, (_, i) => leaf(ROOT, `red${i}`, 40, 'red'));
    const root = branch(ROOT, [leaf(ROOT, 'huge', 20_000, 'red'), ...blues, ...reds]);
    const map = layout(root, 30, 30);
    const colors = treemapTileColors(map, READ, (node) =>
      node.kind === 'blue' ? palette(4) : palette(1)
    );
    const rest = map.tiles.findIndex((tile) => tile.kind === 'rest');
    expect(map.tiles[rest]?.rest?.[0]?.kind).toBe('red');
    expect(colors[rest]).toBe(palette(4));
    expect(colors[map.tiles.findIndex((tile) => tile.item.name === 'huge')]).toBe(palette(1));
  });

  it("should take a tile of gathered items' colour from the app where it gives one", () => {
    const small = Array.from({ length: 30 }, (_, i) => leaf(ROOT, `s${i}`, 30));
    const map = layout(branch(ROOT, [leaf(ROOT, 'huge', 20_000), ...small]), 30, 30);
    const handed: number[] = [];
    const colors = treemapTileColors(
      map,
      READ,
      () => palette(1),
      (items) => {
        handed.push(items.length);
        return palette(6);
      }
    );
    expect(handed).toStrictEqual([30]);
    expect(colors[map.tiles.findIndex((tile) => tile.kind === 'rest')]).toBe(palette(6));
  });
});

/** Paints a layout into a canvas the map's size and reads the cells back. */
function paint(
  map: TreemapLayout<Node, string>,
  level: 0 | 1 | 2 | 3,
  mark?: TreemapBox,
  colors?: readonly number[]
): { rows: string[]; style: (x: number, y: number) => Style | undefined } {
  const height = Math.ceil(map.height / 2);
  const canvas = createCanvas({ height, width: map.width });
  canvas.paint((painter) =>
    paintTreemap(painter, 0, 0, map, {
      colors,
      label: (tile) => (tile.kind === 'rest' ? '' : tile.item.name),
      level,
      mark,
    })
  );
  // the frame as presented knows its styles, which the grid being painted does not
  canvas.present();
  const frame = canvas.snapshot();
  const rows = Array.from({ length: height }, (_, y) =>
    Array.from({ length: map.width }, (_, x) => frame.charAt(x, y)).join('')
  );
  return { rows, style: (x, y) => frame.cellStyle(x, y) };
}

describe('paintTreemap()', () => {
  it('should keep two tiles of one colour apart by an edge at every level', () => {
    const root = branch(ROOT, [leaf(ROOT, 'a', 500), leaf(ROOT, 'b', 500)]);
    const map = layout(root, 10, 4);
    for (const level of [0, 1, 2, 3] as const) {
      const { rows, style } = paint(map, level);
      // `a` is the left five columns; its last column is the edge
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

  it('should draw a tile of many items with a texture, and one item solid', () => {
    const sub = `${ROOT}/sub`;
    const root = branch(ROOT, [
      leaf(ROOT, 'one', 10_000),
      branch(
        sub,
        Array.from({ length: 20 }, (_, i) => leaf(sub, `${i}`, 100))
      ),
    ]);
    const map = layout(root, 40, 20);
    const whole = map.byKey.get(sub);
    expect(whole?.kind).toBe('whole');
    const { rows } = paint(map, 0);
    const solid = inside(map.byKey.get(`${ROOT}/one`) as TreemapBox);
    // a solid tile's cells away from its edges and its name are full blocks
    expect(rows[Math.ceil(solid.y / 2) + 2]?.[solid.x + 1]).toBe('█');
    const at = inside(whole as TreemapBox);
    const cells = rows
      .slice(Math.ceil(at.y / 2) + 1, Math.floor((at.y + at.h) / 2))
      .map((row) => row.slice(at.x, at.x + at.w))
      .join('');
    expect(cells).toMatch(/[▀▄]/);
    expect(cells).not.toContain('█');
  });

  it('should outline the mark, and at level 0 draw a marked tile hollow', () => {
    const root = branch(ROOT, [leaf(ROOT, 'a', 500), leaf(ROOT, 'b', 500)]);
    const map = layout(root, 20, 12);
    const tile = map.byKey.get(`${ROOT}/a`) as TreemapBox;
    const plain = paint(map, 0).rows;
    const marked = paint(map, 0, tile).rows;
    // the middle of the tile is a block until it is marked
    const y = Math.floor((tile.y + tile.h / 2) / 2);
    const x = tile.x + Math.floor(tile.w / 2);
    expect(plain[y]?.[x]).toBe('█');
    expect(marked[y]?.[x]).toBe(' ');
    // and its left edge is still drawn
    expect(marked[y]?.[tile.x]).toBe('█');

    // at truecolor the outline is white, and bright white at 16
    expect([paint(map, 3, tile).style(tile.x, y)?.fg]).toContain(rgb(255, 255, 255));
    expect([paint(map, 1, tile).style(tile.x, y)?.fg]).toContain(palette(15));
  });

  // the map sets a lit pixel to a colour at level 0 too, and only `Pixels` being
  // told the level keeps that colour off the screen
  it('should paint no colour at level 0', () => {
    const root = branch(ROOT, [leaf(ROOT, 'a', 500), leaf(ROOT, 'b', 300)]);
    const map = layout(root, 20, 12);
    const { rows, style } = paint(map, 0, map.byKey.get(`${ROOT}/a`), [rgb(200, 0, 0)]);
    expect(rows.join('')).toMatch(/[▀▄█]/);
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < map.width; x++) {
        expect([style(x, y)?.fg, style(x, y)?.bg], `${x},${y}`).toEqual([
          DEFAULT_COLOR,
          DEFAULT_COLOR,
        ]);
      }
    }
  });

  it('should paint each tile the colour it was given, degraded to the level', () => {
    const root = branch(ROOT, [leaf(ROOT, 'a', 500), leaf(ROOT, 'b', 500)]);
    const map = layout(root, 10, 4);
    const red = rgb(214, 86, 78);
    const colors = [red, palette(2)];
    // the second tile is a palette colour, which every level with colour keeps
    // on the second row, under the names
    expect(paint(map, 1, undefined, colors).style(0, 1)?.fg).toBe(quantizeColor(red, 1));
    expect(paint(map, 1, undefined, colors).style(5, 1)?.fg).toBe(palette(2));
    expect(paint(map, 2, undefined, colors).style(0, 1)?.fg).toBe(quantizeColor(red, 2));
    expect(paint(map, 2, undefined, colors).style(5, 1)?.fg).toBe(palette(2));
  });

  it('should write a name on a tile wide enough, and keep it off the outline', () => {
    const root = branch(ROOT, [leaf(ROOT, 'alpha', 600), leaf(ROOT, 'beta', 400)]);
    const map = layout(root, 30, 12);
    expect(paint(map, 0).rows.join('\n')).toMatch(/alpha/);
    const tile = map.byKey.get(`${ROOT}/alpha`) as TreemapBox;
    const rows = paint(map, 0, tile).rows;
    const row = rows.findIndex((line) => line.includes('alpha'));
    expect(row).toBeGreaterThan(0);
    // the name starts inside the outline's left edge, not on it
    expect(rows[row]?.indexOf('alpha')).toBeGreaterThan(tile.x);
  });

  // a name that started on the band inside the outline was drawn on the
  // terminal's own colour, so each letter kept whichever colour the half block
  // under it had put in its background; and a name over the band covers what
  // stands the outline off the tiles beside it
  it('should keep a name off the band inside a mark, and give every letter a colour', () => {
    const lib = `${ROOT}/lib`;
    const root = branch(ROOT, [
      branch(lib, [leaf(lib, 'component-options', 700), leaf(lib, 'styled-screen', 500)]),
      leaf(ROOT, 'turbo-build', 900),
    ]);
    const map = layout(root, 60, 30);
    for (const level of [1, 2, 3] as const) {
      for (const marked of [lib, `${ROOT}/turbo-build`]) {
        // what the element outlines: an item divided into tiles has no box of its own
        const mark = treemapMark(map, marked, UP);
        expect(mark, marked).toBeDefined();
        const { rows, style } = paint(map, level, mark);
        const ring = inside(mark as TreemapBox);
        const right = ring.x + ring.w - 1;
        const bottom = ring.y + ring.h - 1;
        const band = (x: number, y: number): boolean =>
          x >= ring.x &&
          x <= right &&
          y >= ring.y &&
          y <= bottom &&
          (x <= ring.x + 1 || x >= right - 1 || y <= ring.y + 1 || y >= bottom - 1);
        let names = 0;
        for (const name of ['component-options', 'styled-screen', 'turbo-build']) {
          const y = rows.findIndex((line) => line.includes(name.slice(0, 6)));
          if (y < 0) {
            continue;
          }
          names++;
          const x = rows[y]?.indexOf(name.slice(0, 6)) ?? -1;
          for (let i = 0; i < 6; i++) {
            const at = `${name} [${i}] at ${level}, ${marked}`;
            expect(band(x + i, y * 2) || band(x + i, y * 2 + 1), at).toBe(false);
            expect(style(x + i, y)?.bg, at).not.toBe(DEFAULT_COLOR);
          }
        }
        expect(names, `names drawn at ${level}, ${marked}`).toBeGreaterThan(1);
      }
    }
  });

  // the ink was black or white for whichever read on the pixel under a name's
  // first cell, which the cushion shades, so names of one colour came out some
  // black and some white; it is chosen once, on the flat colour, by contrast
  it('should write every name of a colour in one ink, on that flat colour', () => {
    // the disk usage example's seven, on each of which black has the contrast
    const kinds = [
      rgb(92, 178, 96),
      rgb(206, 170, 64),
      rgb(78, 128, 226),
      rgb(190, 96, 200),
      rgb(214, 86, 78),
      rgb(134, 136, 146),
      rgb(64, 182, 192),
    ];
    const items = kinds.map((_, i) => leaf(ROOT, `kind${i}-file`, 900 - i * 60));
    const map = layout(branch(ROOT, items), 80, 40);
    const colors = map.tiles.map((tile) => kinds[items.indexOf(tile.item)] ?? DEFAULT_COLOR);
    for (const level of [1, 2, 3] as const) {
      const { rows, style } = paint(map, level, undefined, colors);
      const inks = new Set<unknown>();
      for (const [i, item] of items.entries()) {
        const y = rows.findIndex((line) => line.includes(item.name.slice(0, 5)));
        expect(y, `${item.name} at ${level}`).toBeGreaterThanOrEqual(0);
        const x = rows[y]?.indexOf(item.name.slice(0, 5)) ?? -1;
        for (let c = 0; c < 5; c++) {
          inks.add(style(x + c, y)?.fg);
          expect(style(x + c, y)?.bg, `${item.name} [${c}] at ${level}`).toBe(
            treemapColors(kinds[i] as number, level)[0]
          );
        }
      }
      expect([...inks], `level ${level}`).toEqual([
        level === 1 ? palette(0) : quantizeColor(rgb(16, 16, 20), level),
      ]);
    }
    // and white where it is white that reads: a dark tile
    const dark = paint(
      map,
      3,
      undefined,
      map.tiles.map(() => rgb(20, 30, 60))
    );
    const y = dark.rows.findIndex((line) => line.includes('kind0'));
    expect(dark.style(dark.rows[y]?.indexOf('kind0') ?? -1, y)?.fg).toBe(rgb(250, 250, 250));
  });
});

// -- the element --------------------------------------------------------------

const apps: { exit(code: number): void }[] = [];
afterEach(() => {
  for (const app of apps.splice(0)) {
    app.exit(0);
  }
});

/** Mounts a treemap over a test terminal of its own, and nothing else. */
async function mount<T, K>(
  props: TreemapProps<T, K>,
  opts: { colorLevel?: 0 | 1 | 2 | 3; columns?: number; rows?: number } = {}
) {
  const term = createTestTerminal({
    colorLevel: opts.colorLevel ?? 0,
    columns: opts.columns ?? 20,
    rows: opts.rows ?? 6,
  });
  const app = runApp(
    () =>
      Treemap({
        ...props,
        props: { 'flex-grow': 1, ...props.props },
      }),
    { detect: false, mouse: true, terminal: term.terminal }
  );
  apps.push(app);
  await frame(app);
  return {
    app,
    /** A left click on a cell, as a terminal reports one. */
    click: async (x: number, y: number) => {
      // SGR reports count from one
      await term.press(`\u001b[<0;${x + 1};${y + 1}M`, `\u001b[<0;${x + 1};${y + 1}m`);
      await frame(app);
    },
    screen: () => term.viewport.join('\n'),
    term,
  };
}

/** Two items of one size, side by side: `a` on the left half, `b` on the right. */
const PAIR = branch(ROOT, [leaf(ROOT, 'a', 500), leaf(ROOT, 'b', 500)]);

/** One item on its own. */
const LONE = leaf(ROOT, 'lone', 1);

const PAIR_PROPS = {
  children: (node: Node) => node.children,
  key: (node: Node) => node.path,
  label: (node: Node) => node.name,
  size: (node: Node) => node.size,
};

describe('Treemap', () => {
  it('should fill the box it is given and write the names', async () => {
    const m = await mount({ ...PAIR_PROPS, root: PAIR });
    const rows = m.term.viewport;
    expect(rows[0]).toMatch(/^a█+ b█+/u);
    expect(m.screen()).toMatch(/█/);
    // the last row is drawn too: the map took the whole height
    expect(rows.at(-1)).toMatch(/[█▀]/);
  });

  it('should repaint when only the current item has moved', async () => {
    const current = new State<string | undefined>(`${ROOT}/a`);
    const m = await mount({ ...PAIR_PROPS, current, root: PAIR });
    const before = m.screen();

    current.set(`${ROOT}/b`);
    await frame(m.app);
    expect(m.screen()).not.toBe(before);
    // and back: the outline is where the current item is, not where it has been
    current.set(`${ROOT}/a`);
    await frame(m.app);
    expect(m.screen()).toBe(before);
  });

  it('should repaint when only the message it shows has changed', async () => {
    const message = new State('Scanning...');
    const m = await mount({ ...PAIR_PROPS, empty: () => message.get(), root: undefined });
    expect(m.screen()).toContain('Scanning...');
    message.set('Nothing here');
    await frame(m.app);
    expect(m.screen()).toContain('Nothing here');
    expect(m.screen()).not.toContain('Scanning');
  });

  it('should say there is nothing to show for a root of no size', async () => {
    const m = await mount({ ...PAIR_PROPS, root: branch(ROOT, []) });
    expect(m.screen()).toContain('Nothing to show');
  });

  it('should take a State or a Computed of a root that is never undefined', async () => {
    // typed `State<Node>`, not `State<Node | undefined>`: what an app writes
    const state = new State(PAIR);
    const computed = new Computed(() => PAIR);
    expect((await mount({ ...PAIR_PROPS, root: state })).term.viewport[0]).toMatch(/^a█+ b█+/u);
    expect((await mount({ ...PAIR_PROPS, root: computed })).term.viewport[0]).toMatch(/^a█+ b█+/u);
  });

  it('should draw a new root handed through a State', async () => {
    const root = new State<Node | undefined>(PAIR);
    const m = await mount({ ...PAIR_PROPS, root });
    expect(m.screen()).toMatch(/\ba\b/);
    root.set(branch(ROOT, [leaf(ROOT, 'other', 1)]));
    await frame(m.app);
    expect(m.screen()).toContain('other');
    expect(m.screen()).not.toMatch(/\ba\b/);
  });

  it('should draw a root that has a get method of its own as the root', async () => {
    const node = {
      ...PAIR,
      get(name: string): Node | undefined {
        return PAIR.children?.find((child) => child.name === name);
      },
    };
    const m = await mount({ ...PAIR_PROPS, root: node });
    expect(m.term.viewport[0]).toMatch(/^a█+ b█+/u);
  });

  it('should move the current item to a tile clicked, and say so', async () => {
    const current = new State<string | undefined>(undefined);
    const picks: unknown[] = [];
    const m = await mount({
      ...PAIR_PROPS,
      current,
      onPick: (key, item, gathered) => picks.push([key, item.name, gathered]),
      root: PAIR,
    });
    await m.click(15, 3);
    expect(current.get()).toBe(`${ROOT}/b`);
    expect(picks).toStrictEqual([[`${ROOT}/b`, 'b', undefined]]);
  });

  it('should pick the largest of a tile of gathered items, and hand over all of them', async () => {
    const small = Array.from({ length: 30 }, (_, i) => leaf(ROOT, `s${i}`, 10 + i));
    const root = branch(ROOT, [leaf(ROOT, 'huge', 5000), ...small]);
    const picks: [string, string, readonly Node[] | undefined][] = [];
    const m = await mount(
      {
        ...PAIR_PROPS,
        onPick: (key, item, gathered) => picks.push([key, item.name, gathered]),
        root,
      },
      { columns: 40, rows: 12 }
    );
    const map = layoutTreemap(root, 40, 24, READ);
    const rest = map.tiles.find((tile) => tile.kind === 'rest') as TreemapBox;
    // it is named for how many it holds
    expect(m.screen()).toMatch(/\+30|30 more/);
    await m.click(rest.x, Math.floor(rest.y / 2));
    expect(picks[0]?.[0]).toBe(`${ROOT}/s29`);
    expect(picks[0]?.[2]).toHaveLength(30);
  });

  it("should name a tile of gathered items with the app's words", async () => {
    const small = Array.from({ length: 30 }, (_, i) => leaf(ROOT, `s${i}`, 10 + i));
    const root = branch(ROOT, [leaf(ROOT, 'huge', 5000), ...small]);
    const m = await mount(
      { ...PAIR_PROPS, moreLabel: (items) => `…${items.length}`, root },
      { columns: 40, rows: 12 }
    );
    expect(m.screen()).toContain('…30');
  });

  it('should outline an item deep inside a tile drawn in one piece, given its parent', async () => {
    const box = `${ROOT}/box`;
    const root = branch(ROOT, [
      leaf(ROOT, 'big', 9000),
      branch(
        box,
        Array.from({ length: 40 }, (_, i) => leaf(box, `${i}`, 25))
      ),
    ]);
    const plain = await mount({ ...PAIR_PROPS, root }, { columns: 30, rows: 8 });
    const marked = await mount(
      { ...PAIR_PROPS, current: `${box}/3`, parent: parentOf, root },
      { columns: 30, rows: 8 }
    );
    const unmarked = await mount(
      { ...PAIR_PROPS, current: `${box}/3`, root },
      { columns: 30, rows: 8 }
    );
    // the outline is the one the tile it is drawn in gets
    const whole = await mount({ ...PAIR_PROPS, current: box, root }, { columns: 30, rows: 8 });
    expect(whole.screen()).not.toBe(plain.screen());
    expect(marked.screen()).toBe(whole.screen());
    expect(unmarked.screen()).toBe(plain.screen());
  });

  it('should not outline the root, which is the whole map', async () => {
    const plain = await mount({ ...PAIR_PROPS, root: PAIR });
    const marked = await mount({ ...PAIR_PROPS, current: ROOT, root: PAIR });
    expect(marked.screen()).toBe(plain.screen());
  });

  it('should ask the colour of each item at the level it draws at, and not at level 0', async () => {
    const asked: number[] = [];
    const color = (node: Node, level: number): number => {
      asked.push(level);
      return node.name === 'a' ? palette(1) : palette(2);
    };
    const m = await mount({ ...PAIR_PROPS, color, root: PAIR }, { colorLevel: 1 });
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toStrictEqual(new Set([1]));
    // red and green reached the terminal, as the sixteen's own: an SGR that
    // sets 31 or 32, read past the escape that opens it
    expect(m.term.output).toMatch(/\[(?:[0-9;]*;)?31[;m]/);
    expect(m.term.output).toMatch(/\[(?:[0-9;]*;)?32[;m]/);
    asked.length = 0;
    await mount({ ...PAIR_PROPS, color, root: PAIR }, { colorLevel: 0 });
    expect(asked).toStrictEqual([]);
  });

  it('should refuse an onMouse in its props, which it sets itself', () => {
    expect(() =>
      Treemap({ ...PAIR_PROPS, props: { onMouse: () => {} } as never, root: PAIR })
    ).toThrow(/Treemap sets onMouse itself/);
  });
});
