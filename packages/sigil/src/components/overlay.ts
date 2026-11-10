/**
 * What every box drawn over the app shares: where it goes, how it hides what is
 * under it, and who has the keys while it is up.
 *
 * ```js
 * import { holdInput, opaqueFill, rootOf } from '@ttylabs/sigil/components/overlay';
 * ```
 *
 * The modal, the tooltip and the menus each put a box over the screen, and each
 * had written the same three things for it: the walk up to the root a `fixed` box
 * resolves against, the blank fill that makes a box opaque at every colour level,
 * and -- the modal and the menus -- a per-router list saying which of them owns the
 * input. The list is the one that has to be shared rather than only written once:
 * a dropdown opened inside a dialog is two overlays on one router, and the dialog
 * stands aside for the dropdown only because both read the same list. `AGENTS.md`
 * records it under "Menus".
 */

import { cellStyle, type Element, raw } from '../element/index.js';
import type { InputRouter } from '../input/index.js';

/**
 * The outermost ancestor: the box a `fixed` element resolves against, and the one
 * that is laid out.
 *
 * @param element - Anything in the tree.
 * @returns The root of that tree, which is `element` itself when it has no parent.
 */
export function rootOf(element: Element): Element {
  let at = element;
  while (at.parent !== undefined) {
    at = at.parent;
  }
  return at;
}

/**
 * A blank fill over the whole padding box of the element it is appended to.
 *
 * A box with no background paints nothing in its empty cells, and a background
 * colour is no answer, because it is dropped at colour level 0 -- so what is under
 * an overlay would show between its words for a user who asked for no colour.
 * Blank cells are counted as drawn, so this hides what is under it at every level,
 * in the terminal's own colours. Nothing is declared for it in the sheet; the
 * class is the hook for a theme that wants a colour behind the overlay, and the
 * fill reads its own style so that one rule reaches it.
 *
 * Append it **first**, so that everything else is painted over it.
 *
 * @param className - The hook, such as `sigil-modal-fill`.
 * @returns The element to append.
 */
export function opaqueFill(className: string): Element {
  return raw(
    {
      measure: () => ({ height: 0, width: 0 }),
      paint: (painter, area, element) => {
        painter.fill(area.x, area.y, area.width, area.height, cellStyle(element.style));
      },
    },
    { bottom: 0, class: className, left: 0, position: 'absolute', right: 0, top: 0 }
  );
}

/** One overlay that holds a router's input: a dialog, or an open menu. */
export interface InputLayer {
  /** What it drew. A layer below asks it whether the focus is inside it. */
  readonly element: Element;
  /**
   * Whether the focus lives inside it, which a dialog's does and a menu's does
   * not: a menu leaves the focus where it was and takes the keys with a binding.
   * A dialog closing under it hands the focus to the nearest trap below.
   */
  readonly trap: boolean;
}

/** What {@link holdInput} hands back. */
export interface InputHold {
  /** Whether this is the layer on top, which is the only one that answers a key. */
  isTop(): boolean;
  /** The nearest trap still held on the router, once this one is released. */
  nearestTrap(): InputLayer | undefined;
  /** Takes it off the list. Doing it twice does nothing. */
  release(): void;
}

/** Each router's open layers, bottom first. The last one owns the input. */
const LAYERS = new WeakMap<InputRouter, InputLayer[]>();

/**
 * Puts an overlay on top of a router's input.
 *
 * A list per router rather than module state, so two routers do not share one.
 * Each overlay registers its own binding and answers only while it is on top, so
 * a lower one's binding runs, stands aside, and leaves the key for the upper one.
 *
 * @param input - The router.
 * @param layer - What is being put on top.
 * @returns The hold, which says whether it is still on top and takes it off.
 */
export function holdInput(input: InputRouter, layer: InputLayer): InputHold {
  let list = LAYERS.get(input);
  if (list === undefined) {
    list = [];
    LAYERS.set(input, list);
  }
  const mine = list;
  mine.push(layer);
  return {
    isTop: () => mine.at(-1) === layer,
    nearestTrap: () => mine.findLast((it) => it.trap && it !== layer),
    release(): void {
      const index = mine.indexOf(layer);
      if (index !== -1) {
        mine.splice(index, 1);
      }
    },
  };
}

/**
 * The layer on top of a router's input, if anything is held.
 *
 * What a key-opened overlay asks before it opens over another: a context menu's
 * key reaching an element under a dialog is not that element's to answer.
 *
 * @param input - The router.
 * @returns The top layer, or `undefined`.
 */
export function topLayer(input: InputRouter): InputLayer | undefined {
  return LAYERS.get(input)?.at(-1);
}
