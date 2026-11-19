/**
 * The map, the swatch the tree draws beside a file, and the colour of each kind
 * of file, which both of them show.
 *
 * The map is the library's `Treemap` over the scan's tree: squarified, in half
 * blocks, laid out again only when the tree, its root or its size moved, and
 * repainted for what its paint reads. What is this app's is how a `DiskNode` is
 * read -- its bytes, its children, its path -- and what colour a kind of file is.
 * The swatch is a `raw` of its own, the trapdoor the image component is built on.
 */

import { type Category, CATEGORIES } from './disk.ts';
import type { DiskNode } from './scan.ts';
import { type Color, DEFAULT_COLOR, palette, rgb } from '@ttylabs/sigil/canvas';
import { Treemap } from '@ttylabs/sigil/components/treemap';
import { type Element, printable, raw } from '@ttylabs/sigil/element';
import type { Computed, State } from '@ttylabs/sigil/signals';
import { quantizeColor } from '@ttylabs/sigil/style';
import { dirname } from 'node:path';

/**
 * Each category's colour: an RGB for 256 colours and up, and one of the sixteen
 * for 16. The six hues are the six the sixteen have, so at 16 colours no two
 * categories share one -- nor do the bright twins the map draws a tile of many
 * files with -- and the selection is bright white, which none of them is.
 */
const COLOURS: Readonly<Record<Category, { ansi: number; rgb: Color }>> = {
  archive: { ansi: 2, rgb: rgb(92, 178, 96) },
  binary: { ansi: 3, rgb: rgb(206, 170, 64) },
  code: { ansi: 4, rgb: rgb(78, 128, 226) },
  image: { ansi: 5, rgb: rgb(190, 96, 200) },
  media: { ansi: 1, rgb: rgb(214, 86, 78) },
  other: { ansi: 8, rgb: rgb(134, 136, 146) },
  text: { ansi: 6, rgb: rgb(64, 182, 192) },
};

/**
 * A category's colour as the map is told it: one of the sixteen at 16, and the
 * RGB above that, which the map degrades and shades itself.
 */
function mapColor(category: Category, level: number): Color {
  const { ansi, rgb: base } = COLOURS[category];
  return level === 1 ? palette(ansi) : base;
}

/**
 * A category's colour at a colour level, ready to paint: the RGB at truecolor,
 * quantized at 256, the hue of the sixteen at 16, and the terminal's own at 0,
 * where nothing is coloured.
 *
 * @param category - What kind of file.
 * @param level - The colour level.
 * @returns The colour.
 */
export function categoryColor(category: Category, level: 0 | 1 | 2 | 3): Color {
  return level === 0 ? DEFAULT_COLOR : quantizeColor(mapColor(category, level), level);
}

/**
 * The category with the most bytes among some nodes, a directory counting each
 * kind it holds rather than only the kind it is mostly: the colour of a tile of
 * gathered items, which the map would otherwise colour by adding up whole nodes.
 *
 * @param nodes - What a tile gathers.
 * @returns The kind it is coloured as.
 */
export function gatheredCategory(nodes: readonly DiskNode[]): Category {
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

/** The directory a path is in, or nothing above the top of the file system. */
function parentOf(path: string): string | undefined {
  const up = dirname(path);
  return up === path ? undefined : up;
}

export interface MapViewProps {
  /** What the map draws, or nothing while there is nothing to draw. */
  readonly root: Computed<DiskNode | undefined> | State<DiskNode | undefined>;
  /** The path whose tile is outlined, which a click on the map moves. */
  readonly selected: State<string | undefined>;
  /** What to say where there is no map: the scan's progress, or why it is empty. */
  readonly message: () => string;
  /** Enter on the map: the path of what is selected. */
  readonly onActivate?: (path: string) => void;
  /**
   * A tile picked, by a click or an arrow key: the path of what it is, or the
   * largest of what it gathers.
   */
  readonly onPick?: (path: string) => void;
  /** A class for the host. */
  readonly class?: string;
}

/**
 * The treemap of a tree, filling the box it is given.
 *
 * @param props - The tree, the selection, and what a pick and Enter do.
 * @returns The element.
 */
export function MapView(props: MapViewProps): Element {
  return Treemap<DiskNode, string>({
    children: (node) => node.children,
    color: (node, level) => mapColor(node.category, level),
    current: props.selected,
    empty: props.message,
    key: (node) => node.path,
    label: (node) => printable(node.name) + (node.children === undefined ? '' : '/'),
    moreColor: (nodes, level) => mapColor(gatheredCategory(nodes), level),
    // handed on as it is, since a map with an onActivate claims Enter
    onActivate: props.onActivate,
    onPick: (path) => props.onPick?.(path),
    parent: parentOf,
    props: { class: props.class ?? 'map', 'flex-grow': 1, 'min-height': 0, 'min-width': 0 },
    root: props.root,
    size: (node) => node.bytes,
  });
}

/**
 * A square in a category's colour, which is the legend for the tree: what colour a
 * file is on the map. Nothing at colour level 0, where there is no colour to show.
 *
 * @param props - The category.
 * @returns The element: two cells, the square and a space.
 */
export function Swatch(props: { readonly category: Category }): Element {
  return raw(
    {
      measure: () => ({ height: 1, minHeight: 1, minWidth: 2, width: 2 }),
      paint: (painter, box, self) => {
        if (self.colorLevel > 0 && box.width > 0) {
          painter.text(box.x, box.y, '■', { fg: categoryColor(props.category, self.colorLevel) });
        }
      },
    },
    { class: 'swatch', 'flex-shrink': 0 }
  );
}
