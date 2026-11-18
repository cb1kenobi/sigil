/**
 * The map as an element, and the swatch the tree draws beside a file.
 *
 * Both are `raw` elements, the trapdoor the image component is built on: measured
 * like a text, placed by the layout, and painting their own cells. The map lays
 * its tree out again only when the tree, its root or its size moved -- a move of
 * the selection repaints over the same layout.
 */

import type { Category } from './disk.ts';
import type { DiskNode } from './scan.ts';
import { categoryColor, layoutMap, type MapLayout, markFor, paintMap, tileAt } from './treemap.ts';
import { DEFAULT_COLOR } from '@ttylabs/sigil/canvas';
import { type Element, raw } from '@ttylabs/sigil/element';
import type { MouseEvent } from '@ttylabs/sigil/input';
import { createEffect } from '@ttylabs/sigil/renderer';
import { stringWidth } from '@ttylabs/sigil/width';
import { truncate } from '@ttylabs/sigil/wrap';

export interface MapViewProps {
  /** What the map draws, or nothing while there is nothing to draw. */
  readonly root: { get(): DiskNode | undefined };
  /** The path whose tile is outlined. */
  readonly selected: { get(): string | undefined };
  /** What to say where there is no map: the scan's progress, or why it is empty. */
  readonly message: () => string;
  /** A click on a tile: the path of what it is, or the largest of what it gathers. */
  readonly onPick?: (path: string) => void;
  /** A class for the host. */
  readonly class?: string;
}

/**
 * The treemap of a tree, filling the box it is given.
 *
 * @param props - The tree, the selection, and what a click does.
 * @returns The element.
 */
export function MapView(props: MapViewProps): Element {
  let laid: { layout: MapLayout; root: DiskNode } | undefined;
  /** Where the last paint put the map, for a click to be read against. */
  let at = { x: 0, y: 0 };

  const layoutFor = (root: DiskNode, width: number, height: number): MapLayout => {
    if (
      laid === undefined ||
      laid.root !== root ||
      laid.layout.width !== width ||
      laid.layout.height !== height
    ) {
      laid = { layout: layoutMap(root, width, height), root };
    }
    return laid.layout;
  };

  const element = raw(
    {
      // it takes whatever room the panel gives it, and asks for none of its own
      measure: () => ({ height: 0, minHeight: 0, minWidth: 0, width: 0 }),
      paint: (painter, box, self) => {
        at = { x: box.x, y: box.y };
        const root = props.root.get();
        if (box.width <= 0 || box.height <= 0) {
          return;
        }
        if (root === undefined || root.bytes <= 0) {
          laid = undefined;
          const lines = props.message().split('\n');
          const top = box.y + Math.max(0, Math.floor((box.height - lines.length) / 2));
          for (const [i, line] of lines.entries()) {
            if (i >= box.height) {
              break;
            }
            const cut = truncate(line, Math.max(0, box.width - 2));
            const left = box.x + Math.max(1, Math.floor((box.width - stringWidth(cut)) / 2));
            painter.text(left, top + i, cut, { fg: DEFAULT_COLOR });
          }
          return;
        }
        const layout = layoutFor(root, box.width, box.height * 2);
        const selected = props.selected.get();
        paintMap(painter, box.x, box.y, layout, {
          level: self.colorLevel,
          // the map's own root is the whole map, which an outline says nothing about
          mark:
            selected === undefined || selected === root.path
              ? undefined
              : markFor(layout, selected, root.path),
        });
      },
    },
    { class: props.class ?? 'map', 'flex-grow': 1, 'min-height': 0, 'min-width': 0 }
  );

  // a paint reads no signal the renderer can see, so what it draws is asked for
  // again whenever one of them moves
  createEffect(() => {
    props.root.get();
    props.selected.get();
    props.message();
    element.invalidatePaint();
  });

  element.onMouse = (event: MouseEvent): void => {
    if (event.kind !== 'click' || event.button !== 'left' || laid === undefined) {
      return;
    }
    const x = event.x - at.x;
    // either half of the cell clicked: the upper is as good a guess as any, and
    // the lower is the one under it when the upper is an edge
    const tile =
      tileAt(laid.layout, x, (event.y - at.y) * 2) ??
      tileAt(laid.layout, x, (event.y - at.y) * 2 + 1);
    if (tile === undefined) {
      return;
    }
    event.stop();
    props.onPick?.(
      tile.kind === 'rest' ? (tile.rest?.[0]?.path ?? tile.node.path) : tile.node.path
    );
  };
  return element;
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
