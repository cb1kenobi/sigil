/**
 * A treemap: a tree of sized items as nested rectangles, squarified and painted
 * in half blocks.
 *
 * Any data with sizes in a hierarchy -- disk use, a bundle's modules, memory by
 * owner -- reads as a treemap: each item a rectangle as big as its share, inside
 * its parent's. This is the one the disk usage example drew by hand (SIG-474),
 * with nothing about files left in it (SIG-480).
 *
 * ```js
 * import { Treemap } from '@ttylabs/sigil/components/treemap';
 *
 * const map = Treemap({
 *   root: tree,
 *   size: (node) => node.bytes,
 *   children: (node) => node.children,
 *   key: (node) => node.path,
 *   label: (node) => node.name,
 *   props: { 'flex-grow': 1 },
 * });
 * ```
 *
 * Everything is laid out in **pixels**, which is what `Pixels` calls a half
 * block: a cell wide and half a cell tall, so about square on a terminal whose
 * cells are twice as tall as they are wide. That is what lets a squarified layout
 * mean square on the screen, and what lets one cell hold the edge between two
 * rectangles stacked one above the other, in two colours. The layout, the mark
 * and the hit test are plain functions over a tree and a size, so the tests ask
 * them directly; the paint is the only part that needs a painter. `AGENTS.md`
 * has the reasons under "A treemap".
 */

import type { ColorLevel } from '../ansi/index.js';
import {
  type Color,
  DEFAULT_COLOR,
  type Painter,
  palette,
  Pixels,
  rgb,
  rgbChannels,
} from '../canvas/index.js';
import { type Element, type ElementPropsWithout, toDisplayLine } from '../element/index.js';
import { __, __n } from '../i18n/index.js';
import type { DescribeOptions, KeyEvent, MouseEvent } from '../input/index.js';
import { trackedRaw } from '../renderer/index.js';
import { Computed, State, untrack } from '../signals/index.js';
import { colorRgb, quantizeColor } from '../style/index.js';
import { stringWidth } from '../width/index.js';
import { truncate } from '../wrap/index.js';
import { type DescribeListViewOptions, describedHosts } from './list-view.js';
import { refuseOwnedHooks } from './owned-hooks.js';

export interface TreemapProps<T, K = T> {
  /**
   * An item's children, or `undefined` for an item that has none. Defaults to
   * none, which draws the root as one tile.
   *
   * Read when the map is laid out -- once per tree and size, not per frame -- and
   * only as deep as there is room to draw, so a tree of a hundred thousand items
   * costs what is on screen. An item's children are taken to be fixed: a tree
   * that changed is a new `root`. Largest first is cheapest, and any order is
   * sorted.
   */
  children?: (item: T) => readonly T[] | undefined;
  /**
   * The colour of an item's tile, at the colour level the frame is drawn at. An
   * RGB is degraded to the level by the library's quantizer; a palette index the
   * level can show is left as it is, which is how an app keeps sixteen hues of
   * its own choosing apart at 16 colours. Not called at level 0, where the map is
   * drawn as shapes in the terminal's own colours.
   *
   * A tile of many items -- an item drawn in one piece, or the small items of one
   * gathered together -- is a checker of this colour and a second, which is it
   * darkened, or at 16 colours its bright twin. A gathered tile is the colour that
   * covers the most size among what it gathers, unless `moreColor` says. The
   * outline of the current item is bright white, so no item should be.
   *
   * Called as the map paints, so a signal it reads repaints it. Defaults to one
   * blue for everything.
   */
  color?: (item: T, level: ColorLevel) => Color;
  /**
   * The item marked with an outline, as its key, or the state that holds it -- the
   * shape `ListView`'s `current` has. A click writes it. An item with no tile of
   * its own outlines what it was drawn in: the tile it was gathered into, or the
   * tile of an ancestor drawn in one piece -- which takes `parent` to find. The
   * root is the whole map and is not outlined.
   */
  current?: K | State<K | undefined>;
  /**
   * What to say where there is no map: no root, or a root of no size. A function
   * is called as the map paints, so a signal it reads -- a scan's progress -- is
   * followed. Lines are centred. Defaults to "Nothing to show".
   */
  empty?: string | (() => string);
  /**
   * What identifies an item, which `current` holds. Defaults to the item itself.
   */
  key?: (item: T) => K;
  /**
   * The name written on an item's tile, on its first whole row where the tile is
   * wide enough. Defaults to the item itself for a string or a number, and no
   * name otherwise. Drawn as a text draws it, without control characters.
   */
  label?: (item: T) => string;
  /**
   * The colour of a tile of gathered items, given them, largest first, and the
   * level -- for an app that knows better than adding up `color` over them, as one
   * whose items each carry a mix of kinds does. Degraded and drawn as `color`'s
   * answer is, and called when it would be.
   */
  moreColor?: (items: readonly T[], level: ColorLevel) => Color;
  /**
   * The name written on a tile of gathered items, given them, largest first, and
   * the columns there are for it. Defaults to `37 more`, or `+37` where that does
   * not fit.
   */
  moreLabel?: (items: readonly T[], room: number) => string;
  /**
   * Called on Enter, with the map focused, with the key `current` holds -- while
   * the map outlines something for it, so not for the root or a key the map does
   * not hold. What it does is the app's: the disk usage example maps that
   * directory, which is writing a new `root`. Without it, Enter is not the map's,
   * and reaches what is around it.
   */
  onActivate?: (key: K) => void;
  /**
   * Called when a tile is picked -- a left click on it, or an arrow key moving onto
   * it -- after `current` has moved to it, with the item's key and the item. A
   * tile of gathered items picks the largest of them, and hands over the whole
   * list as `gathered`.
   */
  onPick?: (key: K, item: T, gathered?: readonly T[]) => void;
  /**
   * The key of an item's parent, or `undefined` at the top. Lets an item that has
   * no tile of its own -- one deep inside a tile drawn in one piece -- outline the
   * tile it is in; without it, only an item with a tile, or one gathered straight
   * into a tile of gathered items, is outlined.
   */
  parent?: (key: K) => K | undefined;
  /**
   * The element's own props: a size, a class, `flex-grow`. The map is focusable,
   * which `focusable: false` here takes back, along with its keys.
   */
  props?: ElementPropsWithout<'onKey' | 'onMouse'>;
  /**
   * The tree: its root item, or a `State`, a `Computed` or a function that gives
   * it. `undefined` is nothing to draw. A new root is laid out again; the same
   * root at the same size is not. A signal is told apart by being one, not by
   * having a `get()`, so a node with a `get` method of its own is a node.
   */
  root:
    | T
    | undefined
    | State<T>
    | State<T | undefined>
    | Computed<T>
    | Computed<T | undefined>
    | (() => T | undefined);
  /**
   * An item's size, in any unit. Nothing above `0` takes no room at all. An item
   * with children is divided among them by theirs, so its own size only decides
   * its share beside its siblings.
   */
  size: (item: T) => number;
}

/** A rectangle, in whole pixels. */
export interface TreemapBox {
  readonly h: number;
  readonly w: number;
  readonly x: number;
  readonly y: number;
}

/**
 * One rectangle drawn on the map: an item, an item with children drawn in one
 * piece because there is no room to draw what is in it, or the smaller items of
 * one gathered into one because none of them has room of its own.
 */
export interface TreemapTile<T> extends TreemapBox {
  /**
   * The cushion's surface, `[s1x, s2x, s1y, s2y]`: a ridge per level of nesting,
   * which is what shades a tile so that its parent's outline shows through.
   */
  readonly cushion: readonly [number, number, number, number];
  /** How deep it is under the map's root: the root's children are `1`. */
  readonly depth: number;
  /** The item; for `rest`, the item whose children it gathers. */
  readonly item: T;
  /** `leaf` is one item; `whole` and `rest` are many, and are drawn with a texture. */
  readonly kind: 'leaf' | 'rest' | 'whole';
  /** For `rest`: the items gathered, largest first. */
  readonly rest?: readonly T[];
}

/** What a tree came to at one size. */
export interface TreemapLayout<T, K> {
  /** Each `leaf` and `whole` tile, by its item's key. */
  readonly byKey: ReadonlyMap<K, TreemapTile<T>>;
  /** Each item that was divided into its children, by key, with where it is. */
  readonly divided: ReadonlyMap<K, TreemapBox>;
  readonly height: number;
  /** Each item gathered into a `rest`, by its key, with that tile: worked out when first read. */
  readonly gathered: ReadonlyMap<K, TreemapTile<T>>;
  /** Each `rest` tile, by the key of the item whose children it gathers. */
  readonly rests: ReadonlyMap<K, TreemapTile<T>>;
  /** Every tile, painted in this order: no two overlap. */
  readonly tiles: readonly TreemapTile<T>[];
  readonly width: number;
}

/** How a layout reads the tree. */
export interface TreemapReader<T, K> {
  children(item: T): readonly T[] | undefined;
  key(item: T): K;
  size(item: T): number;
}

/**
 * The fewest pixels an item has to be given to be drawn on its own: a tile of
 * three by three shows two by two of colour inside its edge, and less than that
 * is an edge with nothing in it. An item under this is gathered into its
 * parent's `rest`.
 */
export const TREEMAP_MIN_AREA = 9;

/**
 * How big an item has to be drawn to be divided into its children rather than
 * drawn in one piece: room for at least one tile with colour inside its edge.
 */
const MIN_SIDE = 3;

/** How high the cushion's first ridge is, and how much lower each level's is than its parent's. */
const RIDGE = 0.5;
const RIDGE_FALL = 0.75;

/** How far up a `parent` chain the mark looks before giving up on a cycle. */
const MAX_HOPS = 10_000;

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

/** An item's children that take room, largest first, and their sizes, read once. */
interface Sized<T> {
  readonly items: readonly T[];
  readonly sizes: readonly number[];
  readonly total: number;
}

/**
 * An item's children that take room, largest first, with the sum of them; or
 * `undefined` for an item with no children. Sorted only where they are not in
 * order already, which a tree built largest first never pays for. Two arrays
 * rather than an object per child, because a directory of twenty thousand small
 * files is read whole to learn that it is to be gathered.
 */
function sizedChildren<T, K>(item: T, read: TreemapReader<T, K>): Sized<T> | undefined {
  const children = read.children(item);
  if (children === undefined) {
    return undefined;
  }
  let items: T[] = [];
  let sizes: number[] = [];
  let total = 0;
  let sorted = true;
  for (const child of children) {
    const size = read.size(child);
    // `!(size > 0)` and not `size <= 0`, so a NaN takes no room either
    if (!(size > 0) || size === Infinity) {
      continue;
    }
    if (sizes.length > 0 && size > (sizes.at(-1) as number)) {
      sorted = false;
    }
    items.push(child);
    sizes.push(size);
    total += size;
  }
  if (!sorted) {
    const order = sizes
      .map((_, i) => i)
      .sort((x, y) => (sizes[y] as number) - (sizes[x] as number));
    items = order.map((i) => items[i] as T);
    sizes = order.map((i) => sizes[i] as number);
  }
  return { items, sizes, total };
}

/**
 * Lays a tree out at a size.
 *
 * Each item is divided into its children by {@link squarify}, as deep as there is
 * room: an item drawn smaller than three pixels a side is one tile, and the
 * children of an item that would get fewer than {@link TREEMAP_MIN_AREA} pixels
 * each are gathered into one `rest` tile. So the depth limit is the cell rather
 * than a number, and a deep tree on a big screen is drawn deep. Items of no size
 * take no room at all.
 *
 * @param root - What to draw.
 * @param width - Pixels across, which is cells across.
 * @param height - Pixels down, which is twice the rows.
 * @param read - How the tree is read.
 * @returns Where everything went.
 */
export function layoutTreemap<T, K>(
  root: T,
  width: number,
  height: number,
  read: TreemapReader<T, K>
): TreemapLayout<T, K> {
  const tiles: TreemapTile<T>[] = [];
  const divided = new Map<K, TreemapBox>();
  const rests = new Map<K, TreemapTile<T>>();
  const byKey = new Map<K, TreemapTile<T>>();

  const place = (
    item: T,
    box: TreemapBox,
    depth: number,
    cushion: readonly [number, number, number, number]
  ): void => {
    const height = RIDGE * RIDGE_FALL ** depth;
    const [s1x, s2x] = ridge(cushion[0], cushion[1], box.x, box.x + box.w, height);
    const [s1y, s2y] = ridge(cushion[2], cushion[3], box.y, box.y + box.h, height);
    const surface = [s1x, s2x, s1y, s2y] as const;

    // divided only where at least its largest child has room of its own: an
    // item whose every child would be gathered into its rest is drawn in one
    // piece, under its own name
    const sized = sizedChildren(item, read);
    const largest = sized?.sizes[0] ?? 0;
    const divisible =
      sized !== undefined &&
      sized.total > 0 &&
      box.w >= MIN_SIDE &&
      box.h >= MIN_SIDE &&
      (largest / sized.total) * box.w * box.h >= TREEMAP_MIN_AREA;
    if (!divisible) {
      const tile: TreemapTile<T> = {
        ...box,
        cushion: surface,
        depth,
        item,
        kind: sized === undefined ? 'leaf' : 'whole',
      };
      tiles.push(tile);
      byKey.set(read.key(item), tile);
      return;
    }

    divided.set(read.key(item), box);
    // an item directly under the map's root keeps an edge of its own, so the
    // map's first division -- which item the space went to -- reads at a glance,
    // at every colour level, where deeper ones are left to the cushion
    const edged = depth === 1 && box.w > MIN_SIDE * 2 && box.h > MIN_SIDE * 2 ? inside(box) : box;
    divide(item, sized, edged, depth, surface);
  };

  const divide = (
    item: T,
    sized: Sized<T>,
    box: TreemapBox,
    depth: number,
    cushion: readonly [number, number, number, number]
  ): void => {
    const area = box.w * box.h;
    const { items, sizes, total } = sized;
    // the children are largest first, so once one is too small the rest are
    let count = sizes.findIndex((size) => (size / total) * area < TREEMAP_MIN_AREA);
    if (count === -1) {
      count = sizes.length;
    }
    let restSize = 0;
    for (let i = count; i < sizes.length; i++) {
      restSize += sizes[i] as number;
    }
    // each by its place among the children, and the rest as -1
    const entries: { index: number; size: number }[] = [];
    for (let i = 0; i < count; i++) {
      entries.push({ index: i, size: sizes[i] as number });
    }
    if (restSize > 0) {
      entries.push({ index: -1, size: restSize });
      // the rest can outweigh the smallest items shown, and squarify wants the
      // largest first
      entries.sort((a, b) => b.size - a.size);
    }
    // edges rounded, never sizes, so two neighbours round their shared edge the
    // same way and the tiles meet with no gap and no overlap
    const rects: TreemapBox[] = squarify(
      entries.map((entry) => entry.size),
      box
    ).map((r) => {
      const x0 = Math.round(r.x);
      const y0 = Math.round(r.y);
      return { h: Math.round(r.y + r.h) - y0, w: Math.round(r.x + r.w) - x0, x: x0, y: y0 };
    });
    for (const [i, entry] of entries.entries()) {
      const at = rects[i] as TreemapBox;
      // an item with room enough on paper can still be laid as a sliver under
      // half a pixel, which rounds to nothing: it is too small to draw, and
      // `treemapMark()` outlines nothing for it
      if (at.w <= 0 || at.h <= 0) {
        continue;
      }
      if (entry.index === -1) {
        const height = RIDGE * RIDGE_FALL ** (depth + 1);
        const [s1x, s2x] = ridge(cushion[0], cushion[1], at.x, at.x + at.w, height);
        const [s1y, s2y] = ridge(cushion[2], cushion[3], at.y, at.y + at.h, height);
        const tile: TreemapTile<T> = {
          ...at,
          cushion: [s1x, s2x, s1y, s2y],
          depth: depth + 1,
          item,
          kind: 'rest',
          rest: items.slice(count),
        };
        tiles.push(tile);
        rests.set(read.key(item), tile);
      } else {
        place(items[entry.index] as T, at, depth + 1, cushion);
      }
    }
  };

  const whole: TreemapBox = { h: height, w: width, x: 0, y: 0 };
  const size = read.size(root);
  if (size > 0 && width > 0 && height > 0) {
    const sized = sizedChildren(root, read);
    if (sized === undefined || sized.total <= 0) {
      place(root, whole, 0, [0, 0, 0, 0]);
    } else {
      divided.set(read.key(root), whole);
      divide(root, sized, whole, 0, [0, 0, 0, 0]);
    }
  }
  // which tile each gathered item went into is asked only to mark one, and a
  // directory of thousands of small files is thousands of keys: so it is worked
  // out the first time it is asked, and once per layout
  let gathered: Map<K, TreemapTile<T>> | undefined;
  return {
    byKey,
    divided,
    get gathered(): ReadonlyMap<K, TreemapTile<T>> {
      if (gathered === undefined) {
        gathered = new Map();
        for (const tile of rests.values()) {
          for (const item of tile.rest ?? []) {
            gathered.set(read.key(item), tile);
          }
        }
      }
      return gathered;
    },
    height,
    rests,
    tiles,
    width,
  };
}

/**
 * Where on the map an item is marked: its own tile; or, for an item too small to
 * have one, the `rest` it was gathered into, or the tile of an ancestor drawn in
 * one piece that it is inside; or, for an item divided into its children, the
 * whole of its box.
 *
 * @param layout - The map.
 * @param key - The item's key.
 * @param read - How an item's key is read, and the key of an item's parent, to
 *   walk up from an item with no tile of its own. Without `parent`, only the item
 *   itself is looked for.
 * @returns The box to mark, or `undefined` where the item is not on this map.
 */
export function treemapMark<T, K>(
  layout: TreemapLayout<T, K>,
  key: K,
  read: Pick<TreemapReader<T, K>, 'key'> & { parent?: (key: K) => K | undefined }
): TreemapBox | undefined {
  const { parent } = read;
  if (parent === undefined) {
    return layout.byKey.get(key) ?? layout.gathered.get(key) ?? layout.divided.get(key);
  }
  let at = key;
  let below: K | undefined;
  for (let hops = 0; hops < MAX_HOPS; hops++) {
    const tile = layout.byKey.get(at);
    if (tile !== undefined) {
      return tile;
    }
    const box = layout.divided.get(at);
    if (box !== undefined) {
      if (below === undefined) {
        return box;
      }
      // an item divided into its children, and the one on the way down to the
      // item asked about was not one of them: it is in the rest, or it rounded
      // away to nothing and is not drawn at all. Asked of the one rest rather
      // than of every gathered item, which a new layout would build a map of
      const rest = layout.rests.get(at);
      const step = below;
      return rest?.rest?.some((item) => read.key(item) === step) ? rest : undefined;
    }
    const up = parent(at);
    if (up === undefined || up === at) {
      return undefined;
    }
    below = at;
    at = up;
  }
  return undefined;
}

/**
 * The tile under a pixel.
 *
 * @param layout - The map.
 * @param x - Pixel column.
 * @param y - Pixel row.
 * @returns The tile, or `undefined` over nothing.
 */
export function treemapTileAt<T, K>(
  layout: TreemapLayout<T, K>,
  x: number,
  y: number
): TreemapTile<T> | undefined {
  return layout.tiles.find(
    (tile) => x >= tile.x && x < tile.x + tile.w && y >= tile.y && y < tile.y + tile.h
  );
}

/**
 * The tile a cell shows, which is what a click on it means.
 *
 * A cell is two pixels, and where one tile ends above another the cell can hold
 * the upper tile's uncoloured edge over the lower tile's colour -- a `▄` in the
 * lower tile's colour, with the upper tile's box still reaching into it. So a
 * half that is drawn wins over one that is not, the upper first; a cell drawn
 * in neither half goes to whatever box it is in, the upper first. At level 0 a
 * textured tile's second square is not drawn either -- it is the terminal's own,
 * as an edge is -- which a tile one pixel tall leaves showing the tile below.
 *
 * @param layout - The map.
 * @param x - Cell column.
 * @param y - Cell row.
 * @param level - The colour level it was drawn at, which decides whether a
 *   texture's second square is drawn.
 * @returns The tile, or `undefined` over nothing.
 */
export function treemapCellTile<T, K>(
  layout: TreemapLayout<T, K>,
  x: number,
  y: number,
  level: ColorLevel
): TreemapTile<T> | undefined {
  const upper = treemapTileAt(layout, x, y * 2);
  const lower = treemapTileAt(layout, x, y * 2 + 1);
  const coloured = (tile: TreemapTile<T> | undefined, py: number): boolean => {
    if (tile === undefined) {
      return false;
    }
    const fill = inside(tile);
    if (x >= fill.x + fill.w || py >= fill.y + fill.h) {
      return false;
    }
    // the paint's checker, read the same way
    return !(level <= 0 && tile.kind !== 'leaf' && (x + py) % 2 === 1);
  };
  if (coloured(upper, y * 2)) {
    return upper;
  }
  if (coloured(lower, y * 2 + 1)) {
    return lower;
  }
  return upper ?? lower;
}

/** A way an arrow key moves on the map. */
export type TreemapDirection = 'down' | 'left' | 'right' | 'up';

/**
 * The tile an arrow key moves to from a box: of the tiles wholly past the box's
 * edge on that side, the one nearest that edge, then the one sharing the most of
 * it, then the one whose center is nearest the box's along it, then the first laid.
 *
 * So the move is to the tile next to the box, never over it to a bigger one
 * further on, and between two next to it it is to the one more in line. A tile
 * that shares none of the edge is taken only where none does, nearest first --
 * which is a box that ends beside the one-pixel row a directory directly under the
 * root keeps, where the tiles in line with it start a pixel along. From nothing
 * marked, every arrow goes to the first tile laid, which is in the top left
 * corner. Past the edge of the map there is nothing, and the answer is `undefined`.
 *
 * @param layout - The map.
 * @param from - The box moved from, as {@link treemapMark} gives it, or nothing.
 * @param direction - Which arrow.
 * @returns The tile, or `undefined` where there is none that way.
 */
export function treemapNeighbor<T, K>(
  layout: Pick<TreemapLayout<T, K>, 'tiles'>,
  from: TreemapBox | undefined,
  direction: TreemapDirection
): TreemapTile<T> | undefined {
  if (from === undefined) {
    return layout.tiles[0];
  }
  const across = direction === 'left' || direction === 'right';
  let best: TreemapTile<T> | undefined;
  let bestRank: readonly number[] = [];
  for (const tile of layout.tiles) {
    // how far past the box's edge on that side the tile starts
    const gap =
      direction === 'right'
        ? tile.x - (from.x + from.w)
        : direction === 'left'
          ? from.x - (tile.x + tile.w)
          : direction === 'down'
            ? tile.y - (from.y + from.h)
            : from.y - (tile.y + tile.h);
    if (gap < 0) {
      continue;
    }
    // the two spans along that edge: how much they share, and how far apart
    // their centers are -- doubled, which orders them the same
    const [a0, a1, b0, b1] = across
      ? [from.y, from.y + from.h, tile.y, tile.y + tile.h]
      : [from.x, from.x + from.w, tile.x, tile.x + tile.w];
    const shared = Math.min(a1, b1) - Math.max(a0, b0);
    const off = Math.abs(a0 + a1 - b0 - b1);
    // a negative `shared` is how far apart the spans are
    const rank = shared > 0 ? [0, gap, -shared, off] : [1, -shared, gap, off];
    if (best === undefined || before(rank, bestRank)) {
      best = tile;
      bestRank = rank;
    }
  }
  return best;
}

/** Whether one rank comes before another, read left to right; a tie does not. */
function before(a: readonly number[], b: readonly number[]): boolean {
  for (const [i, n] of a.entries()) {
    const m = b[i] as number;
    if (n !== m) {
      return n < m;
    }
  }
  return false;
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
export function inside(box: TreemapBox): TreemapBox {
  return {
    h: box.h > 1 ? box.h - 1 : box.h,
    w: box.w > 1 ? box.w - 1 : box.w,
    x: box.x,
    y: box.y,
  };
}

// -- colour -------------------------------------------------------------------

/** The colour every tile is when the app names none. */
const DEFAULT_TILE = rgb(78, 128, 226);

/** The colour the current item is outlined in, as RGB. */
const MARK = rgb(255, 255, 255);

/** A 24-bit colour scaled towards black, `1` leaving it as it is; anything else as it is. */
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
 * A tile's colour and its texture's second colour, at a level above 0.
 *
 * The second is the first darkened, or at 16 colours -- where darker is not a
 * colour there is -- its bright twin: `n` and `n + 8`, and grey's twin is the
 * light grey rather than black, which on a dark terminal would leave a checker of
 * grey and nothing.
 *
 * @param color - What the app named.
 * @param level - The colour level, 1 to 3.
 * @returns The fill and the texture's second colour, both at the level.
 */
export function treemapColors(color: Color, level: ColorLevel): [Color, Color] {
  const base = quantizeColor(color, level);
  if (base === DEFAULT_COLOR) {
    return [base, base];
  }
  if (base < 16) {
    return [base, palette(base < 8 ? base + 8 : base === 8 ? 7 : base - 8)];
  }
  // a palette colour past the sixteen has channels the cube says it has
  const rgbBase = rgbChannels(color) === undefined ? rgb(...colorRgb(color)) : color;
  return [base, quantizeColor(shade(rgbBase, 0.74), level)];
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
function lightAt(tile: TreemapTile<unknown>, x: number, y: number): number {
  const [s1x, s2x, s1y, s2y] = tile.cushion;
  const nx = -(2 * s2x * (x + 0.5) + s1x);
  const ny = -(2 * s2y * (y + 0.5) + s1y);
  const cos = (nx * LIGHT[0] + ny * LIGHT[1] + LIGHT[2]) / Math.sqrt(nx * nx + ny * ny + 1);
  return 0.42 + 0.68 * Math.max(0, cos);
}

/** WCAG's relative luminance of a colour's channels, 0 to 1. */
function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const linear = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** The two inks a name can be written in. */
const BLACK_INK = rgb(16, 16, 20);
const WHITE_INK = rgb(250, 250, 250);

/**
 * The ink a tile's name is written in: black or white, whichever has the higher
 * contrast on the tile's flat colour.
 *
 * Asked of the flat colour rather than of the pixel under the name, which the
 * cushion shades from 0.42 to 1.25 times: a colour near the middle of the range
 * gave black on one name and white on the next, within one colour. And contrast
 * rather than a cut-off in brightness, because the cut-off sits where neither ink
 * reads well -- on every colour the disk usage example uses, black reads at 4.8:1
 * or better and white at 3.8:1 at most, so contrast writes all of them in black,
 * where the cut-off split them three to four. Black at 16 colours, as it was.
 */
function inkOn(color: Color, level: ColorLevel): Color {
  if (level === 1) {
    return palette(0);
  }
  if (color === DEFAULT_COLOR) {
    return DEFAULT_COLOR;
  }
  const lit = relativeLuminance(colorRgb(color)) + 0.05;
  const black = lit / (relativeLuminance(colorRgb(BLACK_INK)) + 0.05);
  const white = (relativeLuminance(colorRgb(WHITE_INK)) + 0.05) / lit;
  return quantizeColor(black >= white ? BLACK_INK : WHITE_INK, level);
}

/** What {@link paintTreemap} is told. */
export interface TreemapPaint<T> {
  /**
   * Each tile's colour as the app names it, in `tiles` order. Not read at level 0.
   */
  readonly colors?: readonly Color[];
  /** A tile's name in the room there is, or `''` for none. */
  readonly label: (tile: TreemapTile<T>, room: number) => string;
  /** The colour level: at `0` the map is drawn in the terminal's own colour, and shows its shapes. */
  readonly level: ColorLevel;
  /** The box the current item is outlined around, from {@link treemapMark}. */
  readonly mark?: TreemapBox;
}

/**
 * Paints a map into a box of cells.
 *
 * A tile that is one item is solid; a tile that is many -- an item drawn in one
 * piece, or an item's smaller children -- is a checker of two shades of its
 * colour, so "this is a lot of little things" reads at every colour level. At
 * truecolor each tile is shaded as a cushion. A tile wide enough has its name on
 * its first whole row.
 *
 * @param painter - Where.
 * @param left - The box's first column.
 * @param top - The box's first row.
 * @param layout - The map, laid out at this box's size in pixels.
 * @param opts - The colours, the names, the level, and what to mark.
 */
export function paintTreemap<T, K>(
  painter: Painter,
  left: number,
  top: number,
  layout: TreemapLayout<T, K>,
  opts: TreemapPaint<T>
): void {
  const { level } = opts;
  const pixels = new Pixels(layout.width, Math.ceil(layout.height / 2));
  // at level 0 there is no colour to tell anything apart with, so a pixel is on
  // or off and the edges between tiles are what show; any colour stands for on
  const on = palette(7);

  for (const [i, tile] of layout.tiles.entries()) {
    const fill = inside(tile);
    const [base, alt] =
      level <= 0 ? [on, DEFAULT_COLOR] : treemapColors(opts.colors?.[i] ?? DEFAULT_TILE, level);
    const textured = tile.kind !== 'leaf';
    for (let y = fill.y; y < fill.y + fill.h; y++) {
      for (let x = fill.x; x < fill.x + fill.w; x++) {
        const second = textured && (x + y) % 2 === 1;
        const color = second ? alt : base;
        pixels.set(x, y, level >= 3 ? shade(color, lightAt(tile, x, y)) : color);
      }
    }
  }

  if (opts.mark !== undefined) {
    const ring = inside(opts.mark);
    const mark = level <= 0 ? on : level === 1 ? palette(15) : quantizeColor(MARK, level);
    // at level 0 the outline is the same "on" as everything else, so a marked
    // tile is hollow: its outline and nothing inside it
    const hollow = level <= 0 && layout.tiles.includes(opts.mark as TreemapTile<T>);
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
          pixels.set(x, y, mark);
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
  // it, so a name over it would join the mark to the tile next to it
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
    const edge = y <= ring.y + 1 || y >= bottom - 1;
    return across ? edge : edge || x <= ring.x + 1 || x >= right - 1;
  };
  // a cell is two pixels, one above the other
  const offCell = (x: number, row: number, across = false): boolean =>
    onRing(x, row * 2, across) || onRing(x, row * 2 + 1, across);
  for (const [i, tile] of layout.tiles.entries()) {
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
    const label = truncate(toDisplayLine(opts.label(tile, end - start)), end - start);
    if (stringWidth(label) === 0) {
      continue;
    }
    if (level <= 0) {
      painter.text(left + start, top + row, label);
    } else {
      // the tile's flat colour rather than the pixel under the name, which the
      // cushion shades: one ink only reads on every name of a colour when every
      // name of it is on one colour
      const [flat] = treemapColors(opts.colors?.[i] ?? DEFAULT_TILE, level);
      painter.text(left + start, top + row, label, { bg: flat, fg: inkOn(flat, level) });
    }
  }
}

/**
 * Each tile's colour as the app names it, in `tiles` order: an item's own, and
 * for a tile of gathered items the colour covering the most size among them, the
 * first of them winning a tie -- which, largest first, is the largest item's.
 *
 * @param layout - The map.
 * @param read - How the tree is read, for the sizes.
 * @param color - The app's colour for an item, already at the level.
 * @param more - The app's colour for a tile of gathered items, where it has one.
 * @returns A colour per tile.
 */
export function treemapTileColors<T, K>(
  layout: TreemapLayout<T, K>,
  read: Pick<TreemapReader<T, K>, 'size'>,
  color: (item: T) => Color,
  more?: (items: readonly T[]) => Color
): Color[] {
  return layout.tiles.map((tile) => {
    if (tile.kind !== 'rest') {
      return color(tile.item);
    }
    if (more !== undefined) {
      return more(tile.rest ?? []);
    }
    const sums = new Map<Color, number>();
    let best: Color = DEFAULT_TILE;
    let most = -1;
    for (const item of tile.rest ?? []) {
      const c = color(item);
      const sum = (sums.get(c) ?? 0) + untrack(() => read.size(item));
      sums.set(c, sum);
      if (sum > most) {
        most = sum;
        best = c;
      }
    }
    return best;
  });
}

/** The default name of a tile of gathered items: `37 more`, or `+37` in less room. */
function moreWords(count: number, room: number): string {
  const words = __n(count, '{0} more', '{0} more');
  return stringWidth(words) <= room ? words : `+${count}`;
}

/**
 * A treemap of a tree, filling the box the layout gives it.
 *
 * A `raw` element built with `trackedRaw()`, so what its paint reads -- the root,
 * `current`, `empty`, the colours and the names -- is what it repaints for. The
 * layout is kept for as long as the root and the size are the same, so moving
 * `current` repaints over the same rectangles. It asks for 40 columns by 12 rows
 * and takes whatever the layout gives it, down to nothing; `flex-grow: 1` is how
 * to have it fill a panel.
 *
 * It is focusable. With the focus, the arrow keys move `current` to the tile next
 * to it that way ({@link treemapNeighbor}), as a click on that tile would, and
 * Enter calls `onActivate`; `describeTreemap()` lists them for a footer.
 *
 * @param props - The tree, how it is read, and what is marked.
 * @returns The element: `.sigil-treemap`.
 */
export function Treemap<T, K = T>(props: TreemapProps<T, K>): Element {
  refuseOwnedHooks('Treemap', props.props, ['onKey', 'onMouse']);
  if (typeof props.size !== 'function') {
    throw new TypeError(__`Expected treemap size to be a function`);
  }
  const keyOf = props.key ?? ((item: T) => item as unknown as K);
  const read: TreemapReader<T, K> = {
    children: props.children ?? (() => undefined),
    key: keyOf,
    size: props.size,
  };
  const labelOf =
    props.label ??
    ((item: T): string =>
      typeof item === 'string' || typeof item === 'number' ? String(item) : '');
  const current =
    props.current instanceof State
      ? props.current
      : new State<K | undefined>(props.current as K | undefined);
  const source = props.root;
  // a signal by what it is rather than by having a `get`, because the root is
  // the app's own node and a node may well have a `get` of its own
  const rootOf = (): T | undefined =>
    typeof source === 'function'
      ? (source as () => T | undefined)()
      : source instanceof State || source instanceof Computed
        ? (source.get() as T | undefined)
        : (source as T | undefined);

  let laid: { layout: TreemapLayout<T, K>; root: T } | undefined;
  /** The level the last paint drew at, which decides what a click on a cell hit. */
  let drawnAt: ColorLevel = 3;
  /** Where the last paint put the map, for a click to be read against. */
  let at = { x: 0, y: 0 };

  const layoutFor = (root: T, width: number, height: number): TreemapLayout<T, K> => {
    if (
      laid === undefined ||
      laid.root !== root ||
      laid.layout.width !== width ||
      laid.layout.height !== height
    ) {
      // the tree's shape is taken as fixed for a root, so what the accessors
      // read is not what the map repaints for: a new tree is a new root
      laid = { layout: untrack(() => layoutTreemap(root, width, height, read)), root };
    }
    return laid.layout;
  };

  const paintEmpty = (
    painter: Painter,
    box: { height: number; width: number; x: number; y: number }
  ): void => {
    const message =
      typeof props.empty === 'function' ? props.empty() : (props.empty ?? __`Nothing to show`);
    const lines = message.split('\n');
    const top = box.y + Math.max(0, Math.floor((box.height - lines.length) / 2));
    for (const [i, line] of lines.entries()) {
      if (i >= box.height) {
        break;
      }
      const cut = truncate(toDisplayLine(line), Math.max(0, box.width - 2));
      const left = box.x + Math.max(1, Math.floor((box.width - stringWidth(cut)) / 2));
      painter.text(left, top + i, cut, { fg: DEFAULT_COLOR });
    }
  };

  const element = trackedRaw(
    {
      measure: (available) => ({
        height: 12,
        minHeight: 0,
        minWidth: 0,
        width: Math.max(0, Math.min(40, available)),
      }),
      paint: (painter, box, self) => {
        at = { x: box.x, y: box.y };
        if (box.width <= 0 || box.height <= 0) {
          // nothing drawn, so nothing for a key or a click to be read against
          laid = undefined;
          return;
        }
        const root = rootOf();
        if (root === undefined || !(untrack(() => read.size(root)) > 0)) {
          laid = undefined;
          paintEmpty(painter, box);
          return;
        }
        const layout = layoutFor(root, box.width, box.height * 2);
        const level = self.colorLevel;
        drawnAt = level;
        const marked = current.get();
        const { color, moreColor } = props;
        const colors =
          level > 0 && (color !== undefined || moreColor !== undefined)
            ? treemapTileColors(
                layout,
                read,
                color === undefined ? () => DEFAULT_TILE : (item) => color(item, level),
                moreColor === undefined ? undefined : (items) => moreColor(items, level)
              )
            : undefined;
        paintTreemap(painter, box.x, box.y, layout, {
          colors,
          label: (tile, room) =>
            tile.kind === 'rest'
              ? (props.moreLabel ?? ((items, n) => moreWords(items.length, n)))(
                  tile.rest ?? [],
                  room
                )
              : labelOf(tile.item),
          level,
          // the map's own root is the whole map, which an outline says nothing about
          mark:
            marked === undefined || marked === untrack(() => keyOf(root))
              ? undefined
              : treemapMark(layout, marked, { key: keyOf, parent: props.parent }),
        });
      },
    },
    { focusable: true, ...props.props }
  );
  element.addClass('sigil-treemap');

  /** Moves `current` to a tile and says so: what a click and an arrow key both do. */
  const pick = (tile: TreemapTile<T>): void => {
    const item = tile.kind === 'rest' ? (tile.rest?.[0] ?? tile.item) : tile.item;
    const key = keyOf(item);
    current.set(key);
    props.onPick?.(key, item, tile.kind === 'rest' ? tile.rest : undefined);
  };

  element.onMouse = (event: MouseEvent): void => {
    if (event.kind !== 'click' || event.button !== 'left' || laid === undefined) {
      return;
    }
    const tile = treemapCellTile(laid.layout, event.x - at.x, event.y - at.y, drawnAt);
    if (tile === undefined) {
      return;
    }
    event.stop();
    pick(tile);
  };

  element.onKey = (event: KeyEvent): void => {
    const k = event.key;
    // Ctrl or Alt is left for what is around the map, as a list leaves it; and
    // with nothing drawn, no key is the map's
    if (event.paste || k.ctrl || k.meta || laid === undefined) {
      return;
    }
    // the root as it is now, which a key can reach before the frame that draws
    // it: Enter that zoomed, then an arrow in the same read. Laid out at the size
    // last drawn, which is the layout that frame will keep
    const root = untrack(rootOf);
    if (root === undefined || !(untrack(() => read.size(root)) > 0)) {
      return;
    }
    const layout = layoutFor(root, laid.layout.width, laid.layout.height);
    const key = untrack(() => current.get());
    // where `current` is drawn, which the paint outlines: nothing for the root
    const from = untrack(() =>
      key === undefined || key === keyOf(root)
        ? undefined
        : treemapMark(layout, key, { key: keyOf, parent: props.parent })
    );
    if (k.name === 'enter') {
      if (props.onActivate !== undefined && key !== undefined && from !== undefined) {
        event.stop();
        props.onActivate(key);
      }
      return;
    }
    const direction = ARROWS.get(k.name);
    // Shift with an arrow is a range, which a list leaves alone too
    if (direction === undefined || k.shift) {
      return;
    }
    // claimed even where it goes nowhere: Right at the map's right edge is still
    // the map's key, a list's rule for Down on its last row
    event.stop();
    const tile = treemapNeighbor(layout, from, direction);
    if (tile !== undefined) {
      pick(tile);
    }
  };

  MAPS.set(element, { activate: props.onActivate !== undefined });
  return element;
}

/** The arrow keys, by name. A `Map`, so a key name is never looked up on `Object.prototype`. */
const ARROWS = new Map<string, TreemapDirection>([
  ['down', 'down'],
  ['left', 'left'],
  ['right', 'right'],
  ['up', 'up'],
]);

/** Each map `Treemap()` built, with whether it claims Enter: what the describer reads. */
const MAPS = new WeakMap<Element, { readonly activate: boolean }>();

/** Where a treemap's keys are described, which is the whole of what is asked of a router. */
export interface TreemapDescriber {
  describe(keys: string, opts: DescribeOptions): () => void;
}

/**
 * Describes a treemap's keys to a router, for a key-help footer.
 *
 * Scoped to the map, which is the element whose focus makes the keys apply: the
 * four arrows, and Enter where the map has an `onActivate`. Enter is `open` unless
 * the options after the maps say what it does, as `describeListView()`'s are
 * given: `describeTreemap(input, map, { activate: 'map it' })`.
 *
 * @param router - What to describe the keys to.
 * @param maps - Hosts that `Treemap()` returned, optionally followed by the
 *   options, which apply to every one of them.
 * @returns Takes every description back off.
 */
export function describeTreemap(
  router: TreemapDescriber,
  ...maps: readonly Element[] | readonly [...maps: Element[], options: DescribeListViewOptions]
): () => void {
  const { hosts, options } = describedHosts(maps);
  const activate = options.activate ?? __`open`;
  const found = hosts.map((host) => {
    const model = MAPS.get(host);
    if (model === undefined) {
      throw new TypeError(__`Expected an element that Treemap() returned`);
    }
    return { activate: model.activate, scope: host };
  });

  const off: Array<() => void> = [];
  for (const { activate: claims, scope } of found) {
    const say = (spec: string, description: string, priority: number): void => {
      off.push(router.describe(spec, { description, priority, scope }));
    };
    say('up', __`move`, 1);
    say('down', __`move`, 1);
    say('left', __`move`, 1);
    say('right', __`move`, 1);
    if (claims) {
      say('enter', activate, 2);
    }
  }

  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
