/**
 * A menubar: a row of titles across the top of an app, each opening a menu.
 *
 * ```js
 * import { Menubar } from '@ttylabs/sigil/components/menubar';
 *
 * const bar = Menubar({
 *   input,
 *   menus: [
 *     { label: '&File', items: [{ label: '&Open', value: open }, { label: '&Quit', value: quit }] },
 *     { label: '&Edit', items: [{ label: '&Undo', hint: 'ctrl+z', value: undo }] },
 *   ],
 *   onSelect: (item) => item.value(),
 * });
 * ```
 *
 * F10 opens the first menu and Alt with a title's mnemonic opens that one, from
 * wherever the focus is -- as fallbacks, so a focused text field that reads Alt-F
 * as a word to the right keeps it. While one is open, Left and Right move between
 * the titles, and the rest of the keys are the menu's: `menu.ts` has them. A press
 * on a title opens it, a press on it again closes it, and while one is open the
 * pointer moving onto another title opens that one instead. A drag from a title
 * released over an item chooses it.
 *
 * The titles are not in the focus ring, which is the desktop's answer: the bar is
 * reached with F10 and Alt, and Tab stays a walk through the app's own controls.
 * `AGENTS.md` records it under "Menus".
 */

import { box, type Element, type ElementProps, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { InputRouter, MouseEvent } from '../input/index.js';
import { onCleanup } from '../renderer/index.js';
import {
  checkMenuEntries,
  labelParts,
  type MenuBar,
  type MenuEntry,
  type MenuItem,
  type MenuSession,
  openMenuSession,
  parseMnemonic,
} from './menu.js';
import { rootOf } from './overlay.js';

/** One title of a menubar and the menu it opens. */
export interface MenubarMenu<T = unknown> {
  /** Whether it can be opened. A disabled title is drawn muted and is skipped. */
  disabled?: boolean;
  /** What its menu offers. */
  items: readonly MenuEntry<T>[];
  /** What the title says. An `&` marks the letter Alt opens it with. */
  label: string;
}

export interface MenubarProps<T = unknown> {
  /** Draw the menus with ASCII only. Defaults to what `unicodeSupported()` says. */
  ascii?: boolean;
  /** The router the keys come from. */
  input: InputRouter;
  /**
   * Whether F10 and the Alt-letters open the menus. Defaults to `true`.
   *
   * `false` leaves the bar to the pointer and to `menubarControl()`, for an app
   * that has its own use for those keys.
   */
  keys?: boolean;
  /** The titles, in order. */
  menus: readonly MenubarMenu<T>[];
  /** Called with the item chosen, after the menu has closed. */
  onSelect?: (item: MenuItem<T>) => void;
  /** The bar's own props: a class, a margin. Geometry only, never a colour. */
  props?: ElementProps;
}

/** What `menubarControl()` hands back. */
export interface MenubarControl {
  /** Closes the open menu, if one is. */
  close(): void;
  /** Takes the bar's keys off the router and closes its menu. Called for you on unmount. */
  dispose(): void;
  /**
   * Opens a title's menu, with its first item highlighted, the way F10 does.
   *
   * @param index - Which title. Defaults to the first one on offer.
   */
  open(index?: number): void;
  /** Which title's menu is open, or `undefined`. */
  readonly openIndex: number | undefined;
}

/** The control of each bar, for `menubarControl()`. */
const controls = new WeakMap<Element, MenubarControl>();

/**
 * The control of a bar `Menubar()` built.
 *
 * @param host - What `Menubar()` returned.
 * @returns The control, or `undefined` for an element no menubar built.
 */
export function menubarControl(host: Element): MenubarControl | undefined {
  return controls.get(host);
}

/** Whether a box contains a cell. */
function holds(
  at: { height: number; width: number; x: number; y: number } | undefined,
  x: number,
  y: number
): boolean {
  return at !== undefined && x >= at.x && y >= at.y && x < at.x + at.width && y < at.y + at.height;
}

/**
 * Builds a menubar.
 *
 * @param props - The router, the titles and their menus, and what to do with a choice.
 * @returns The bar, a row to put at the top of the app.
 */
export function Menubar<T = unknown>(props: MenubarProps<T>): Element {
  const input = props?.input;
  if (typeof input?.bind !== 'function' || typeof input.fallback !== 'function') {
    throw new TypeError(__`Expected a menubar input to be a router`);
  }
  if (!Array.isArray(props.menus)) {
    throw new TypeError(__`Expected menubar menus to be an array`);
  }
  for (const menu of props.menus) {
    if (typeof menu?.label !== 'string' || menu.label === '') {
      throw new TypeError(__`Expected a menubar menu to have a label`);
    }
    checkMenuEntries(menu.items);
  }
  const menus = props.menus;

  const host = box({ ...props.props, 'flex-direction': 'row', 'flex-shrink': 0 });
  host.addClass('sigil-menubar');

  /** One title's parts: the brackets that show it open at colour level 0, and the face. */
  const titles = menus.map((menu) => {
    const left = textNode(' ', { class: 'sigil-menubar-bracket', 'white-space': 'pre' });
    const right = textNode(' ', { class: 'sigil-menubar-bracket', 'white-space': 'pre' });
    const face = box(
      { class: 'sigil-menubar-face', 'flex-direction': 'row' },
      ...labelParts(menu.label, 'sigil-menubar-label').parts
    );
    const element = box(
      { class: 'sigil-menubar-title', 'flex-direction': 'row', 'flex-shrink': 0 },
      left,
      face,
      right
    );
    if (menu.disabled === true) {
      element.addClass('is-disabled');
      element.addClass('sigil-muted');
    }
    return { element, face, left, mnemonic: parseMnemonic(menu.label).mnemonic, right };
  });
  host.append(...titles.map((title) => title.element));

  const offered = (index: number): boolean =>
    index >= 0 && index < menus.length && menus[index]?.disabled !== true;

  let session: MenuSession<T> | undefined;
  /** The title whose menu is open, or `-1`. */
  let current = -1;

  /** Shows which title is open: the focus role on its face, and brackets around it. */
  function mark(index: number): void {
    for (const [i, title] of titles.entries()) {
      const on = i === index;
      title.face.toggleClass('sigil-focus', on);
      title.left.setText(on ? '[' : ' ');
      title.right.setText(on ? ']' : ' ');
    }
  }

  /** The first title on offer after `from`, stepping by `by`, wrapping. */
  function nextTitle(from: number, by: 1 | -1): number {
    const n = menus.length;
    for (let k = 1; k <= n; k++) {
      const i = (((from + by * k) % n) + n) % n;
      if (offered(i)) {
        return i;
      }
    }
    return -1;
  }

  const bar: MenuBar = {
    at: (x, y) => titles.findIndex((title, i) => offered(i) && holds(title.element.box, x, y)),
    current: () => current,
    show,
    step(by): void {
      const to = nextTitle(current, by);
      if (to !== -1) {
        show(to, 'keys');
      }
    },
    title: (letter) => titles.findIndex((title, i) => offered(i) && title.mnemonic === letter),
  };

  /**
   * Opens a title's menu, in place of the one that is open.
   *
   * @param index - The title.
   * @param how - From the keys, which highlights the first item, or the pointer,
   *   which highlights nothing until the pointer is over one.
   */
  function show(index: number, how: 'keys' | 'pointer'): void {
    const menu = menus[index];
    const title = titles[index];
    if (menu === undefined || title === undefined || !offered(index)) {
      return;
    }
    const root = rootOf(host);
    // a bar nothing is drawing has nowhere to open a menu
    if (root === host) {
      return;
    }
    if (session === undefined || !session.open) {
      session = openMenuSession<T>({
        ascii: props.ascii,
        bar,
        host: root,
        input,
        onClose(item) {
          session = undefined;
          current = -1;
          mark(-1);
          if (item !== undefined) {
            props.onSelect?.(item);
          }
        },
      });
    }
    current = index;
    mark(index);
    const initial =
      how === 'keys'
        ? menu.items.findIndex(
            (entry) => !('separator' in entry) && (entry.disabled ?? false) === false
          )
        : -1;
    session.root(menu.items, title.element, { initial, side: 'bottom' });
  }

  for (const [index, title] of titles.entries()) {
    title.element.onMouse = (event: MouseEvent): void => {
      if (event.kind === 'mousedown') {
        // stopped, so click-to-focus leaves the focus where it was: the bar is
        // not a stop in the ring, and a press on it is not a request to move
        event.stop();
        if (event.button !== 'left' || !offered(index)) {
          return;
        }
        // the backdrop of an open menu covers the bar, so this is reached open
        // only before the frame that draws it -- and then it is the same toggle
        if (session?.open && current === index) {
          session.finish();
        } else {
          show(index, 'pointer');
        }
        return;
      }
      // a press on a title captured the pointer, so the drag that follows and the
      // release that ends it are reported here wherever they happen: a release
      // over an item is that item chosen, which is how a menubar is used with
      // the button held
      if (session?.open && event.kind === 'mousemove' && event.button !== undefined) {
        event.stop();
        session.pointAt(event.x, event.y);
        return;
      }
      if (session?.open && event.kind === 'mouseup') {
        event.stop();
        session.releaseAt(event.x, event.y);
        return;
      }
      if (event.kind === 'click') {
        event.stop();
      }
    };
  }

  const offKeys: (() => void)[] = [];
  if (props.keys !== false) {
    offKeys.push(
      input.fallback(
        'f10',
        () => {
          const first = nextTitle(-1, 1);
          if (first !== -1) {
            show(first, 'keys');
          }
        },
        { description: __`menu` }
      )
    );
    // one fallback per letter: every fallback on a key runs, so two titles that
    // share one would both open. The first title with it is the one, as in a menu
    const letters = new Set<string>();
    for (const [index, title] of titles.entries()) {
      const letter = title.mnemonic;
      if (
        letter === undefined ||
        letters.has(letter) ||
        !offered(index) ||
        !/^[\p{L}\p{N}]$/u.test(letter)
      ) {
        continue;
      }
      letters.add(letter);
      offKeys.push(input.fallback(`alt+${letter}`, () => show(index, 'keys')));
    }
  }

  const control: MenubarControl = {
    close(): void {
      session?.finish();
    },
    dispose(): void {
      for (const off of offKeys.splice(0)) {
        off();
      }
      session?.finish();
    },
    open(index?: number): void {
      show(index ?? nextTitle(-1, 1), 'keys');
    },
    get openIndex() {
      return current === -1 ? undefined : current;
    },
  };
  controls.set(host, control);

  // the fallbacks are on the app's router, so they go when the component does
  onCleanup(() => control.dispose());

  return host;
}
