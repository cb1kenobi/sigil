/**
 * The treemap: a squarified layout of a tree into rectangles, and how it is
 * painted in half blocks.
 *
 * Everything here is in **pixels**, which is what `Pixels` calls a half block: a
 * cell wide and half a cell tall, so about square on a terminal whose cells are
 * twice as tall as they are wide. That is what lets a squarified layout mean
 * square on the screen, and what lets one cell hold the edge between two
 * rectangles stacked one above the other, in two colours.
 *
 * The layout and the hit test are plain functions over a tree and a size, so the
 * tests ask them directly; the paint is the only part that needs a painter.
 */

import { type Category, CATEGORIES, isInside } from './disk.ts';
import type { DiskNode } from './scan.ts';
import {
  type Color,
  DEFAULT_COLOR,
  type Painter,
  palette,
  Pixels,
  rgb,
  rgbChannels,
} from '@ttylabs/sigil/canvas';
import { printable } from '@ttylabs/sigil/element';
import { quantizeColor } from '@ttylabs/sigil/style';
import { stringWidth } from '@ttylabs/sigil/width';
import { truncate } from '@ttylabs/sigil/wrap';
import { dirname } from 'node:path';

/** A rectangle, in whole pixels. */
export interface Box {
  readonly h: number;
  readonly w: number;
  readonly x: number;
  readonly y: number;
}

/**
 * One rectangle drawn on the map: a file, a directory drawn in one piece because
 * there is no room to draw what is in it, or the smaller items of a directory
 * gathered into one because none of them has room of its own.
 */
export interface Tile extends Box {
  readonly category: Category;
  /** How deep it is under the map's root: the root's children are `1`. */
  readonly depth: number;
  /**
   * The cushion's surface, `[s1x, s2x, s1y, s2y]`: a ridge per level of nesting,
   * which is what shades a tile so that its parent's outline shows through.
   */
  readonly cushion: readonly [number, number, number, number];
  /** `file` is one name; `whole` and `rest` are many, and are drawn with a texture. */
  readonly kind: 'file' | 'rest' | 'whole';
  /** The file or the directory; for `rest`, the directory the items are in. */
  readonly node: DiskNode;
  /** For `rest`: the items gathered, largest first. */
  readonly rest?: readonly DiskNode[];
}

/** What a tree came to at one size. */
export interface MapLayout {
  /** Each directory that was divided into its contents, by path, with where it is. */
  readonly dirs: ReadonlyMap<string, Box>;
  readonly height: number;
  /** Each `rest` tile, by the path of the directory whose items it gathers. */
  readonly rests: ReadonlyMap<string, Tile>;
  /** Every tile, painted in this order: no two overlap. */
  readonly tiles: readonly Tile[];
  /** Each `file` and `whole` tile, by its node's path. */
  readonly byPath: ReadonlyMap<string, Tile>;
  readonly width: number;
}

/**
 * The fewest pixels an item has to be given to be drawn on its own: a tile of
 * three by three shows two by two of colour inside its edge, and less than that
 * is an edge with nothing in it. An item under this is gathered into its
 * directory's `rest`.
 */
export const MIN_AREA = 9;

/**
 * How big a directory has to be drawn to be divided into what is in it rather
 * than drawn in one piece: room for at least one tile with colour inside its edge.
 */
const MIN_SIDE = 3;

/** How high the cushion's first ridge is, and how much lower each level's is than its parent's. */
const RIDGE = 0.5;
const RIDGE_FALL = 0.75;

/**
 * Lays rectangles of the given areas into a box, squarified: each row is grown
 * while that makes its worst aspect ratio better, then laid along the box's
 * shorter side. Bruls, Huizing and van Wijk's algorithm, which keeps rectangles
 * close to square -- on a grid of cells, a long thin sliver is a rectangle that
 * cannot be drawn at all.
 *
 * @param values - The sizes, largest first. Any scale: they are fitted to the box.
 * @param box - Where, in any units.
 * @returns A rectangle per value, in the same order, in the box's units.
 */
export function squarify(
  values: readonly number[],
  box: { h: number; w: number; x: number; y: number }
): { h: number; w: number; x: number; y: number }[] {
  const total = values.reduce((sum, n) => sum + n, 0);
  const out: { h: number; w: number; x: number; y: number }[] = [];
  if (total <= 0 || box.w <= 0 || box.h <= 0) {
    return values.map(() => ({ h: 0, w: 0, x: box.x, y: box.y }));
  }
  const scale = (box.w * box.h) / total;
  const areas = values.map((n) => n * scale);
  let { h, w, x, y } = box;
  let i = 0;

  /** The worst ratio of a row of areas laid along a side, as the paper defines it. */
  const worst = (sum: number, min: number, max: number, side: number): number => {
    const s2 = sum * sum;
    const l2 = side * side;
    return Math.max((l2 * max) / s2, s2 / (l2 * min));
  };

  while (i < areas.length) {
    const side = Math.min(w, h);
    let sum = areas[i] as number;
    let min = sum;
    let max = sum;
    let j = i + 1;
    while (j < areas.length) {
      const a = areas[j] as number;
      if (a <= 0) {
        break;
      }
      const next = sum + a;
      if (
        worst(next, Math.min(min, a), Math.max(max, a), side) > worst(sum, min, max, side) ||
        side <= 0
      ) {
        break;
      }
      sum = next;
      min = Math.min(min, a);
      max = Math.max(max, a);
      j++;
    }
    // the row is a column down the left of a box wider than tall, and a band
    // across the top of one taller than wide
    if (w >= h) {
      const across = h > 0 ? sum / h : 0;
      let at = y;
      for (let k = i; k < j; k++) {
        const down = across > 0 ? (areas[k] as number) / across : 0;
        out.push({ h: down, w: across, x, y: at });
        at += down;
      }
      x += across;
      w = Math.max(0, w - across);
    } else {
      const down = w > 0 ? sum / w : 0;
      let at = x;
      for (let k = i; k < j; k++) {
        const across = down > 0 ? (areas[k] as number) / down : 0;
        out.push({ h: down, w: across, x: at, y });
        at += across;
      }
      y += down;
      h = Math.max(0, h - down);
    }
    i = j;
  }
  // zero-sized values never made a row of their own
  while (out.length < values.length) {
    out.push({ h: 0, w: 0, x, y });
  }
  return out;
}

/** Adds the ridge one level of nesting puts on a surface, along one axis. */
function ridge(s1: number, s2: number, from: number, to: number, height: number): [number, number] {
  const span = to - from;
  return span > 0 ? [s1 + (4 * height * (to + from)) / span, s2 - (4 * height) / span] : [s1, s2];
}

/**
 * Lays a tree out at a size.
 *
 * Each directory is divided into its contents by {@link squarify}, as deep as
 * there is room: a directory drawn smaller than three pixels a side is one tile,
 * and the items of a directory that would get fewer than {@link MIN_AREA} pixels
 * each are gathered into one `rest` tile. So the depth limit is the cell rather
 * than a number, and a deep tree on a big screen is drawn deep. Items that count
 * for nothing -- empty files, links, a directory of them -- take no room at all.
 *
 * @param root - What to draw.
 * @param width - Pixels across, which is cells across.
 * @param height - Pixels down, which is twice the rows.
 * @returns Where everything went.
 */
export function layoutMap(root: DiskNode, width: number, height: number): MapLayout {
  const tiles: Tile[] = [];
  const dirs = new Map<string, Box>();
  const rests = new Map<string, Tile>();
  const byPath = new Map<string, Tile>();

  const place = (
    node: DiskNode,
    box: Box,
    depth: number,
    cushion: readonly [number, number, number, number]
  ): void => {
    const height = RIDGE * RIDGE_FALL ** depth;
    const [s1x, s2x] = ridge(cushion[0], cushion[1], box.x, box.x + box.w, height);
    const [s1y, s2y] = ridge(cushion[2], cushion[3], box.y, box.y + box.h, height);
    const surface = [s1x, s2x, s1y, s2y] as const;

    // divided only where at least its largest item has room of its own: a
    // directory whose every item would be gathered into its rest is drawn in one
    // piece, under its own name
    const largest = node.children?.[0]?.bytes ?? 0;
    const divisible =
      node.children !== undefined &&
      node.bytes > 0 &&
      box.w >= MIN_SIDE &&
      box.h >= MIN_SIDE &&
      (largest / node.bytes) * box.w * box.h >= MIN_AREA;
    if (!divisible) {
      const tile: Tile = {
        ...box,
        category: node.category,
        cushion: surface,
        depth,
        kind: node.children === undefined ? 'file' : 'whole',
        node,
      };
      tiles.push(tile);
      byPath.set(node.path, tile);
      return;
    }

    dirs.set(node.path, box);
    // a directory directly under the map's root keeps an edge of its own, so the
    // map's first division -- which directory the space went to -- reads at a
    // glance, at every colour level, where deeper ones are left to the cushion
    const edged = depth === 1 && box.w > MIN_SIDE * 2 && box.h > MIN_SIDE * 2 ? inside(box) : box;
    divide(node, edged, depth, surface);
  };

  const divide = (
    node: DiskNode,
    box: Box,
    depth: number,
    cushion: readonly [number, number, number, number]
  ): void => {
    const area = box.w * box.h;
    const counted = (node.children ?? []).filter((child) => child.bytes > 0);
    // the contents are largest first, so once one is too small the rest are
    let count = counted.findIndex((child) => (child.bytes / node.bytes) * area < MIN_AREA);
    if (count === -1) {
      count = counted.length;
    }
    const rest = counted.slice(count);
    const restBytes = rest.reduce((sum, child) => sum + child.bytes, 0);
    const items: { bytes: number; node?: DiskNode }[] = counted
      .slice(0, count)
      .map((child) => ({ bytes: child.bytes, node: child }));
    if (restBytes > 0) {
      items.push({ bytes: restBytes });
      // the rest can outweigh the smallest items shown, and squarify wants the
      // largest first
      items.sort((a, b) => b.bytes - a.bytes);
    }
    // edges rounded, never sizes, so two neighbours round their shared edge the
    // same way and the tiles meet with no gap and no overlap
    const rects: Box[] = squarify(
      items.map((item) => item.bytes),
      box
    ).map((r) => {
      const x0 = Math.round(r.x);
      const y0 = Math.round(r.y);
      return { h: Math.round(r.y + r.h) - y0, w: Math.round(r.x + r.w) - x0, x: x0, y: y0 };
    });
    for (const [i, item] of items.entries()) {
      const at = rects[i] as Box;
      // an item with room enough on paper can still be laid as a sliver under
      // half a pixel, which rounds to nothing: it is too small to draw, and
      // `markFor()` outlines nothing for it
      if (at.w <= 0 || at.h <= 0) {
        continue;
      }
      if (item.node === undefined) {
        const height = RIDGE * RIDGE_FALL ** (depth + 1);
        const [s1x, s2x] = ridge(cushion[0], cushion[1], at.x, at.x + at.w, height);
        const [s1y, s2y] = ridge(cushion[2], cushion[3], at.y, at.y + at.h, height);
        const tile: Tile = {
          ...at,
          category: dominant(rest),
          cushion: [s1x, s2x, s1y, s2y],
          depth: depth + 1,
          kind: 'rest',
          node,
          rest,
        };
        tiles.push(tile);
        rests.set(node.path, tile);
      } else {
        place(item.node, at, depth + 1, cushion);
      }
    }
  };

  const whole: Box = { h: height, w: width, x: 0, y: 0 };
  if (root.bytes > 0 && width > 0 && height > 0) {
    if (root.children === undefined) {
      place(root, whole, 0, [0, 0, 0, 0]);
    } else {
      dirs.set(root.path, whole);
      divide(root, whole, 0, [0, 0, 0, 0]);
    }
  }
  return { byPath, dirs, height, rests, tiles, width };
}

/** The category with the most bytes among some nodes. */
function dominant(nodes: readonly DiskNode[]): Category {
  const sums = CATEGORIES.map(() => 0);
  for (const node of nodes) {
    if (node.mix === undefined) {
      sums[CATEGORIES.indexOf(node.category)] += node.bytes;
    } else {
      for (const [i, n] of node.mix.entries()) {
        sums[i] += n;
      }
    }
  }
  let most = CATEGORIES.length - 1;
  for (const [i, n] of sums.entries()) {
    if (n > (sums[most] as number)) {
      most = i;
    }
  }
  return CATEGORIES[most] as Category;
}

/**
 * Where on the map a path is marked: its own tile; or, for an item too small to
 * have one, the `rest` of the directory it was gathered into, or the tile of the
 * directory drawn in one piece that it is inside; or, for a directory divided into
 * its contents, the whole of its box.
 *
 * @param layout - The map.
 * @param path - What is selected: absolute.
 * @param top - The map's root, above which nothing is looked for.
 * @returns The box to mark, or `undefined` where the path is not on this map.
 */
export function markFor(layout: MapLayout, path: string, top: string): Box | undefined {
  if (!isInside(path, top)) {
    return undefined;
  }
  let at = path;
  let below: string | undefined;
  for (;;) {
    const tile = layout.byPath.get(at);
    if (tile !== undefined) {
      return tile;
    }
    const dir = layout.dirs.get(at);
    if (dir !== undefined) {
      // a directory divided into its contents, and the child on the way down
      // to the path was not one of them: it is in the rest, or it rounded away
      // to nothing and is not drawn at all
      if (below === undefined) {
        return dir;
      }
      const rest = layout.rests.get(at);
      return rest?.rest?.some((item) => item.path === below) ? rest : undefined;
    }
    if (at === top) {
      return undefined;
    }
    const up = dirname(at);
    if (up === at) {
      return undefined;
    }
    below = at;
    at = up;
  }
}

/**
 * The tile under a pixel.
 *
 * @param layout - The map.
 * @param x - Pixel column.
 * @param y - Pixel row.
 * @returns The tile, or `undefined` over nothing.
 */
export function tileAt(layout: MapLayout, x: number, y: number): Tile | undefined {
  return layout.tiles.find(
    (tile) => x >= tile.x && x < tile.x + tile.w && y >= tile.y && y < tile.y + tile.h
  );
}

/**
 * The part of a box that is coloured: all of it but its last column and its last
 * row, which are left in the terminal's own background so that two tiles side by
 * side never run together, whatever their colours and at every colour level. A box
 * too thin for that is coloured whole.
 *
 * @param box - The box.
 * @returns The coloured part.
 */
export function inside(box: Box): Box {
  return {
    h: box.h > 1 ? box.h - 1 : box.h,
    w: box.w > 1 ? box.w - 1 : box.w,
    x: box.x,
    y: box.y,
  };
}

// -- colour -------------------------------------------------------------------

/**
 * Each category's colour: an RGB for 256 colours and up, and a pair of the
 * sixteen for 16 -- the hue, and its bright twin for the texture of a tile that
 * holds many files. The six hues are the six the sixteen have, so at 16 colours
 * no two categories share one, and the selection is bright white, which none of
 * them is.
 */
const COLOURS: Readonly<Record<Category, { ansi: readonly [number, number]; rgb: number }>> = {
  archive: { ansi: [2, 10], rgb: rgb(92, 178, 96) },
  binary: { ansi: [3, 11], rgb: rgb(206, 170, 64) },
  code: { ansi: [4, 12], rgb: rgb(78, 128, 226) },
  image: { ansi: [5, 13], rgb: rgb(190, 96, 200) },
  media: { ansi: [1, 9], rgb: rgb(214, 86, 78) },
  other: { ansi: [8, 7], rgb: rgb(134, 136, 146) },
  text: { ansi: [6, 14], rgb: rgb(64, 182, 192) },
};

/** The colour the selection is outlined in, as RGB. */
const MARK = rgb(255, 255, 255);

/** A colour scaled towards black, `1` leaving it as it is. */
function shade(color: Color, by: number): Color {
  const channels = rgbChannels(color);
  if (channels === undefined) {
    return color;
  }
  const [r, g, b] = channels;
  const f = Math.max(0, Math.min(1.25, by));
  return rgb(
    Math.min(255, Math.round(r * f)),
    Math.min(255, Math.round(g * f)),
    Math.min(255, Math.round(b * f))
  );
}

/**
 * A category's colour at a colour level: the RGB at 256 colours and up, the hue
 * of the sixteen at 16, and the terminal's own at 0, where nothing is coloured.
 *
 * @param category - What kind of file.
 * @param level - The colour level.
 * @param alt - The texture's second colour: darker, or the bright twin at 16.
 * @returns The colour.
 */
export function categoryColor(category: Category, level: number, alt = false): Color {
  const { ansi, rgb: base } = COLOURS[category];
  if (level <= 0) {
    return DEFAULT_COLOR;
  }
  if (level === 1) {
    return palette(alt ? ansi[1] : ansi[0]);
  }
  const color = alt ? shade(base, 0.74) : base;
  return level >= 3 ? color : quantizeColor(color, 2);
}

/** Where the light comes from: up and to the left, and mostly from in front. */
const LIGHT = (() => {
  const [x, y, z] = [-1, -2, 10];
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n] as const;
})();

/**
 * How lit a pixel of a tile is, from its cushion: van Wijk and van de Wetering's
 * shading, where every level of nesting adds a ridge, so a tile is brightest near
 * its middle and its parent's edges show as a darker crease.
 */
function lightAt(tile: Tile, x: number, y: number): number {
  const [s1x, s2x, s1y, s2y] = tile.cushion;
  const nx = -(2 * s2x * (x + 0.5) + s1x);
  const ny = -(2 * s2y * (y + 0.5) + s1y);
  const cos = (nx * LIGHT[0] + ny * LIGHT[1] + LIGHT[2]) / Math.sqrt(nx * nx + ny * ny + 1);
  return 0.42 + 0.68 * Math.max(0, cos);
}

/**
 * The ink every name is written in: black, at every level, on its kind's flat
 * colour. It was black or white for whichever read on the pixel under the
 * name's first cell, and a pixel of a cushion is its kind's colour shaded from
 * 0.42 to 1.25 times -- while every kind's colour sits near the middle of the
 * range, so the answer flipped from one name to the next within a kind. Black on
 * the flat colour reads at 4.8:1 or better on all seven, white on it at no better
 * than 3.8:1, and the sixteen colours already wrote every name in black.
 */
function ink(level: number): Color {
  if (level === 1) {
    return palette(0);
  }
  const black = rgb(16, 16, 20);
  return level >= 3 ? black : quantizeColor(black, 2);
}

/** What {@link paintMap} is told. */
export interface PaintOptions {
  /** The colour level: at `0` the map is drawn in the terminal's own colour, and shows its shapes. */
  readonly level: number;
  /** The box the selection is outlined around, from {@link markFor}. */
  readonly mark?: Box;
}

/**
 * Paints a map into a box of cells.
 *
 * A tile that is one file is solid; a tile that is many -- a directory drawn in one
 * piece, or a directory's smaller items -- is a checker of two shades of its
 * colour, so "this is a lot of little things" reads at every colour level. At
 * truecolor each tile is shaded as a cushion. A tile wide enough has its name on
 * its first whole row.
 *
 * @param painter - Where.
 * @param left - The box's first column.
 * @param top - The box's first row.
 * @param layout - The map, laid out at this box's size in pixels.
 * @param opts - The colour level, and what to mark.
 */
export function paintMap(
  painter: Painter,
  left: number,
  top: number,
  layout: MapLayout,
  opts: PaintOptions
): void {
  const { level } = opts;
  const pixels = new Pixels(layout.width, Math.ceil(layout.height / 2));
  // at level 0 there is no colour to tell anything apart with, so a pixel is on
  // or off and the edges between tiles are what show; any colour stands for on
  const on = (color: Color): Color => (level <= 0 ? palette(7) : color);

  for (const tile of layout.tiles) {
    const fill = inside(tile);
    const base = categoryColor(tile.category, level);
    const alt = categoryColor(tile.category, level, true);
    const textured = tile.kind !== 'file';
    for (let y = fill.y; y < fill.y + fill.h; y++) {
      for (let x = fill.x; x < fill.x + fill.w; x++) {
        const second = textured && (x + y) % 2 === 1;
        let color: Color;
        if (level <= 0) {
          color = second ? DEFAULT_COLOR : on(base);
        } else if (level >= 3) {
          color = shade(second ? alt : base, lightAt(tile, x, y));
        } else {
          color = second ? alt : base;
        }
        pixels.set(x, y, color);
      }
    }
  }

  if (opts.mark !== undefined) {
    const ring = inside(opts.mark);
    const mark = level >= 3 ? MARK : level === 2 ? quantizeColor(MARK, 2) : palette(15);
    // at level 0 the outline is the same "on" as everything else, so a selected
    // tile is hollow: its outline and nothing inside it
    const hollow = level <= 0 && layout.tiles.includes(opts.mark as Tile);
    for (let y = ring.y; y < ring.y + ring.h; y++) {
      for (let x = ring.x; x < ring.x + ring.w; x++) {
        const edge =
          x === ring.x || y === ring.y || x === ring.x + ring.w - 1 || y === ring.y + ring.h - 1;
        // inside the outline, a band of the terminal's own background, so it
        // stands off whatever it is drawn over
        const band =
          x === ring.x + 1 ||
          y === ring.y + 1 ||
          x === ring.x + ring.w - 2 ||
          y === ring.y + ring.h - 2;
        if (edge) {
          pixels.set(x, y, on(mark));
        } else if (band || hollow) {
          pixels.set(x, y, DEFAULT_COLOR);
        }
      }
    }
  }

  // at level 0 `Pixels` draws which pixels are on, with no colour of their own
  pixels.blit(painter, left, top, { colorLevel: level });

  // a name on each tile wide enough to hold one, on its first whole row, and
  // never over the outline or the band inside it: a label is moved off them, or
  // cut short of them. The band is what stands the outline off whatever is under
  // it, so a name over it would join the selection to the tile next to it
  const ring = opts.mark === undefined ? undefined : inside(opts.mark);
  // whether pixel (x, y) is the outline or its band; `across` asks only about
  // the two runs along the top and the bottom
  const onRing = (x: number, y: number, across = false): boolean => {
    if (ring === undefined) {
      return false;
    }
    const right = ring.x + ring.w - 1;
    const bottom = ring.y + ring.h - 1;
    if (x < ring.x || x > right || y < ring.y || y > bottom) {
      return false;
    }
    const top = y <= ring.y + 1 || y >= bottom - 1;
    return across ? top : top || x <= ring.x + 1 || x >= right - 1;
  };
  // a cell is two pixels, one above the other
  const offCell = (x: number, row: number, across = false): boolean =>
    onRing(x, row * 2, across) || onRing(x, row * 2 + 1, across);
  for (const tile of layout.tiles) {
    const fill = inside(tile);
    let row = Math.ceil(fill.y / 2);
    // a row the outline runs along is given up for the one under it
    while (offCell(fill.x + 1, row, true)) {
      row++;
    }
    if (row * 2 + 1 > fill.y + fill.h - 1) {
      continue;
    }
    const limit = fill.x + fill.w - 1;
    let start = fill.x;
    while (start < limit && offCell(start, row)) {
      start++;
    }
    let end = start;
    while (end < limit && !offCell(end, row)) {
      end++;
    }
    if (end - start < 3) {
      continue;
    }
    const name =
      tile.kind === 'rest'
        ? end - start >= `${tile.rest?.length ?? 0} more`.length
          ? `${tile.rest?.length ?? 0} more`
          : `+${tile.rest?.length ?? 0}`
        : printable(tile.node.name) + (tile.kind === 'whole' ? '/' : '');
    const label = truncate(name, end - start);
    if (stringWidth(label) === 0) {
      continue;
    }
    if (level <= 0) {
      painter.text(left + start, top + row, label);
    } else {
      // the flat colour rather than the pixel under the name, which the cushion
      // shades: one ink only reads on every name when every name is on one colour
      painter.text(left + start, top + row, label, {
        bg: categoryColor(tile.category, level),
        fg: ink(level),
      });
    }
  }
}
