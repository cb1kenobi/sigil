/**
 * A menu: a list of things to do, anchored to an element or to a point, with
 * submenus, disabled items and separators -- and a context menu built on it.
 *
 * ```js
 * import { attachContextMenu, openMenu } from '@ttylabs/sigil/components/menu';
 *
 * const menu = openMenu(view, {
 *   at: saveButton,
 *   input,
 *   items: [
 *     { hint: 'ctrl+s', label: '&Save', value: 'save' },
 *     { label: 'Save &As', value: 'save-as' },
 *     { separator: '' },
 *     { label: 'E&xport', items: [{ label: 'PDF', value: 'pdf' }, { label: 'HTML', value: 'html' }] },
 *     { disabled: 'Nothing to revert', label: '&Revert', value: 'revert' },
 *   ],
 * });
 * const chosen = await menu.result; // the item, or undefined for a dismissal
 * ```
 *
 * While it is open it has the keys and the mouse, and the focus stays where it
 * was: Up and Down move the highlight past what is disabled, Right and Enter open
 * a submenu, Left and Escape close one, Enter and Space choose, a letter chooses
 * the item it is the mnemonic of (the `&` in the label, else the first letter),
 * and Tab closes it and moves on. A click outside closes it and reaches nothing
 * under it. `AGENTS.md` records why the focus is not moved into it.
 *
 * `menubar.ts` and `dropdown.ts` are built on the same session.
 */

import { box, cellStyle, Element, raw, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { InputRouter, KeyEvent, MouseEvent } from '../input/index.js';
import type { Box } from '../layout/index.js';
import { onCleanup } from '../renderer/index.js';
import { stringWidth } from '../width/index.js';
import { isAbort } from './keys.js';
import type { ModalHost } from './modal.js';
import { unicodeSupported } from './note.js';
import { holdInput, opaqueFill, rootOf, topLayer } from './overlay.js';
import type { Separator } from './prompt.js';
import { placeTooltip, type TooltipSide } from './tooltip.js';

/** One thing a menu offers. */
export interface MenuItem<T = unknown> {
  /**
   * Whether it is on offer. A string is the reason, shown where the hint would be.
   *
   * A disabled item is drawn muted, the highlight steps over it, and neither a
   * click nor its mnemonic chooses it -- but it stays in the list, so a reader can
   * see that the thing exists and why it is not available now.
   */
  disabled?: boolean | string;
  /** Shown at the right of the row, muted: the key that does the same, usually. */
  hint?: string;
  /**
   * A submenu. An item with one opens it rather than being chosen, and draws an
   * arrow at its right.
   */
  items?: readonly MenuEntry<T>[];
  /**
   * What it says. An `&` marks the next character as its mnemonic -- `Save &As`
   * is chosen with `a` -- and `&&` is an ampersand. Without one, the first
   * character is the mnemonic.
   */
  label: string;
  /** What the app reads back when it is chosen. A function is a fine value. */
  value?: T;
}

/**
 * A row of a menu: an item, or a separator.
 *
 * The separator is the prompts' own -- `separator()` from the prompt module, or
 * `{ separator: '' }` -- drawn as a line across the menu, with its label set into
 * the line when it has one that is not itself a line.
 */
export type MenuEntry<T = unknown> = MenuItem<T> | Separator;

/** Where a menu is put: the renderer, or any element that is the router's root. */
export type MenuHost = ModalHost;

/**
 * What a menu is anchored to: an element it opens beside, or a cell it opens at.
 *
 * A cell is a context menu at the pointer -- the `x` and `y` of a mouse event,
 * which are the canvas's own cells and so the coordinates every box is in.
 */
export type MenuAnchor = Element | { readonly x: number; readonly y: number };

export interface MenuOptions<T = unknown> {
  /**
   * Draw the border, the pointer and the arrows with ASCII only. Defaults to what
   * `unicodeSupported()` says, the rule the modal and the tooltip keep.
   */
  ascii?: boolean;
  /** What it opens beside, or the cell it opens at. */
  at: MenuAnchor;
  /**
   * Which entry is highlighted when it opens, by position. Defaults to the first
   * one on offer. A position that is a separator or disabled highlights nothing.
   */
  initial?: number;
  /** The router the keys come from. */
  input: InputRouter;
  /** What it offers. */
  items: readonly MenuEntry<T>[];
  /**
   * Classes put on the menu and on every submenu it opens, beside `sigil-menu`, so
   * a theme can style these menus apart from every other: `.files-menu
   * { background-color: blue }`. A menu is drawn on the root rather than inside
   * whatever opened it, so a rule written under that element cannot reach it.
   * Space-separated for several.
   */
  menuClass?: string;
  /**
   * The narrowest the menu is, border included, in cells. A dropdown passes the
   * width of its field, so the list is never narrower than what it opened from.
   */
  minWidth?: number;
  /** Called with the item that was chosen, after the menu has closed. */
  onSelect?: (item: MenuItem<T>) => void;
  /**
   * The side of an element anchor it opens on when there is room. Defaults to
   * `bottom`. Flipped to the other side when there is not, by `placeTooltip()`.
   */
  side?: TooltipSide;
}

export interface MenuHandle<T = unknown> {
  /** Closes it with nothing chosen. Does nothing the second time. */
  close(): void;
  /** The same as `close()`, by the name every other handle uses. */
  dispose(): void;
  /** The box over the screen that holds the menu and its submenus. */
  readonly element: Element;
  /** Whether it is still open. */
  readonly open: boolean;
  /**
   * The item chosen, or `undefined` for a dismissal: Escape, a click outside,
   * Tab, `close()`, a resize, or the renderer it was opened over going.
   */
  readonly result: Promise<MenuItem<T> | undefined>;
}

/**
 * Above the modal's `900` and the tooltip's `950` -- a dropdown inside a dialog is
 * drawn over the dialog, and over a tooltip on the field it opened from -- and
 * below the debug overlay's `1000`.
 */
const Z_INDEX = 960;

/** What a menu draws with, in each of the two glyph sets. */
const GLYPHS = {
  ascii: { arrow: '>', border: 'ascii', line: '-', pointer: '>' },
  unicode: { arrow: '▸', border: 'round', line: '─', pointer: '❯' },
} as const;

/** A separator label that is only a line, which `separator()`'s default is. */
const LINE_ONLY = /^[\s\-─━═]*$/u;

/** A row, read: what the menu needs of an entry it is drawing. */
interface Row<T> {
  /** The item, or `undefined` for a separator. */
  readonly item: MenuItem<T> | undefined;
  /** Whether it can be highlighted and chosen. */
  readonly enabled: boolean;
  /** The lower-cased character that chooses it, if it has one. */
  readonly mnemonic: string | undefined;
  /** The row's element. */
  readonly element: Element;
  /** The pointer at its left, shown while it is highlighted. */
  readonly pointer: Element | undefined;
}

/**
 * A label's text and its mnemonic, read out of the `&`.
 *
 * `&&` is an ampersand and never a mnemonic, and an `&` at the end marks nothing.
 * Without a marked character the first character is the mnemonic, with `at` left
 * `undefined` because nothing is drawn differently for it.
 *
 * @param label - The label as written.
 * @returns The text to draw, where the marked character is in it, and the letter.
 */
export function parseMnemonic(label: string): {
  at: number | undefined;
  mnemonic: string | undefined;
  text: string;
} {
  let text = '';
  let at: number | undefined;
  for (let i = 0; i < label.length; i++) {
    const ch = label[i] as string;
    if (ch === '&' && i + 1 < label.length) {
      const next = label[i + 1] as string;
      if (next === '&') {
        text += '&';
        i++;
        continue;
      }
      if (at === undefined) {
        at = text.length;
      }
      continue;
    }
    text += ch;
  }
  const marked = at === undefined ? undefined : String.fromCodePoint(text.codePointAt(at) ?? 0);
  const first =
    text.trimStart() === ''
      ? undefined
      : String.fromCodePoint(text.trimStart().codePointAt(0) ?? 0);
  const mnemonic = (marked ?? first)?.toLowerCase();
  return { at, mnemonic, text };
}

/** Whether an entry is a separator rather than an item. */
function isSeparator<T>(entry: MenuEntry<T>): entry is Separator {
  return typeof entry === 'object' && entry !== null && 'separator' in entry;
}

/**
 * Throws unless a list is entries a menu can draw, all the way down.
 *
 * Asked where a list is handed over rather than where it is opened, by whatever
 * can: a menubar's menus open from a key handler, where a throw would be a key
 * that took the dispatch down with it.
 *
 * @param items - What was passed.
 */
export function checkMenuEntries(items: unknown): void {
  if (!Array.isArray(items)) {
    throw new TypeError(__`Expected menu items to be an array`);
  }
  for (const entry of items as unknown[]) {
    if (typeof entry === 'object' && entry !== null && 'separator' in entry) {
      continue;
    }
    const item = entry as MenuItem | undefined;
    if (typeof item?.label !== 'string' || item.label === '') {
      throw new TypeError(__`Expected a menu item to have a label`);
    }
    if (item.items !== undefined) {
      checkMenuEntries(item.items);
    }
  }
}

/**
 * The classes a `menuClass` option names, refused where the component is built.
 *
 * Every entry point calls it when it is built, not when a menu opens, for the
 * reason `checkMenuEntries()` is called there: a menubar's or a dropdown's menu
 * opens from a key handler, after the session already holds the keys.
 *
 * @param value - What was passed.
 * @returns The class names, none if nothing was passed.
 */
export function menuClasses(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (typeof value !== 'string') {
    throw new TypeError(__`Expected a menuClass to be a string of class names`);
  }
  return value.split(/\s+/).filter((name) => name !== '');
}

/**
 * The label drawn as three pieces, so the mnemonic can carry a class of its own.
 *
 * @param label - The label as written.
 * @param className - The class of the pieces.
 * @returns The pieces, in order, and the width they take.
 */
export function labelParts(label: string, className: string): { parts: Element[]; width: number } {
  const { at, text } = parseMnemonic(label);
  const props = { class: className, 'white-space': 'nowrap' } as const;
  if (at === undefined) {
    return { parts: [textNode(text, props)], width: stringWidth(text) };
  }
  const char = String.fromCodePoint(text.codePointAt(at) ?? 0);
  const before = text.slice(0, at);
  const after = text.slice(at + char.length);
  const parts = [
    textNode(char, { ...props, class: `${className} sigil-menu-mnemonic sigil-accent` }),
  ];
  if (before !== '') {
    parts.unshift(textNode(before, props));
  }
  if (after !== '') {
    parts.push(textNode(after, props));
  }
  return { parts, width: stringWidth(text) };
}

/** What a row says at its right: a disabled item's reason, else its hint. */
function hintOf<T>(item: MenuItem<T>): string | undefined {
  return typeof item.disabled === 'string' ? item.disabled : item.hint;
}

/** The words set into a separator's line, with a space either side, or nothing. */
function separatorWords(entry: Separator): string {
  return LINE_ONLY.test(entry.separator) ? '' : ` ${entry.separator.trim()} `;
}

/**
 * The columns a row needs inside the border: the pointer and its space, the label,
 * two spaces and the hint, a space and the arrow, and a space at the end. A
 * separator needs its words and a cell of line either side.
 */
function rowWidth<T>(entry: MenuEntry<T>): number {
  if (isSeparator(entry)) {
    const words = separatorWords(entry);
    return words === '' ? 0 : stringWidth(words) + 2;
  }
  const hint = hintOf(entry);
  return (
    2 +
    stringWidth(parseMnemonic(entry.label).text) +
    (hint ? 2 + stringWidth(hint) : 0) +
    (entry.items ? 2 : 0) +
    1
  );
}

/** One open menu in a session: the root one, or a submenu. */
interface Level<T> {
  readonly anchor: MenuAnchor;
  /** The highlighted row, or `-1` for none. */
  highlight: number;
  readonly list: Element;
  readonly popup: Element;
  readonly rows: Row<T>[];
  readonly side: TooltipSide;
  /** How many rows the list shows, once the layout has said. */
  viewport: number | undefined;
}

/** What a menubar lends a session, so its titles answer while a menu is open. */
export interface MenuBar {
  /** The title under a cell, or `-1`. */
  at(x: number, y: number): number;
  /** Which title's menu is open. */
  current(): number;
  /** Opens a title's menu in place of the one that is open. */
  show(index: number, how: 'keys' | 'pointer'): void;
  /** Opens the next title along that is on offer, wrapping. */
  step(by: 1 | -1): void;
  /** The title an Alt-letter names, or `-1`. */
  title(letter: string): number;
}

export interface MenuSessionOptions<T> {
  ascii?: boolean;
  /** The menubar the session is for, if it is for one. */
  bar?: MenuBar;
  input: InputRouter;
  /** Classes put on every menu panel the session opens, submenus included. */
  menuClass?: string;
  /** Called once, when it closes, with what was chosen. */
  onClose(item: MenuItem<T> | undefined): void;
  /** Where it is drawn, and whose disposal closes it. */
  host: MenuHost;
}

/**
 * Open menus: a root one, its submenus, and who has the input while they are up.
 *
 * One per opening rather than one per menu, because a submenu, the menu it came
 * from and -- for a menubar -- the next title's menu are one thing to the reader:
 * Escape walks back through them, a click outside closes all of them, and they
 * hold the input as one layer.
 */
export interface MenuSession<T> {
  /** The box over the screen that holds every open menu. */
  readonly element: Element;
  /** Closes everything, with `item` chosen or nothing. */
  finish(item?: MenuItem<T>): void;
  /** Whether it is open. */
  readonly open: boolean;
  /** Moves the highlight to what is under a cell, which a captured drag reports. */
  pointAt(x: number, y: number): void;
  /**
   * Opens a menu at the root, in place of whatever was open.
   *
   * @param items - What it offers.
   * @param at - What it is anchored to.
   * @param opts - Its side, its narrowest width, and what is highlighted.
   */
  root(
    items: readonly MenuEntry<T>[],
    at: MenuAnchor,
    opts?: { initial?: number; minWidth?: number; side?: TooltipSide }
  ): void;
  /** Chooses what is under a cell, if it is an item on offer, which is a drag released. */
  releaseAt(x: number, y: number): void;
}

/** The first position from `from`, stepping by `by`, of a row on offer, or `-1`. */
function nextEnabled<T>(rows: readonly Row<T>[], from: number, by: 1 | -1): number {
  const n = rows.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + by * k) % n) + n) % n;
    if (rows[i]?.enabled) {
      return i;
    }
  }
  return -1;
}

/** Whether a box contains a cell. */
function holds(at: Box | undefined, x: number, y: number): boolean {
  return at !== undefined && x >= at.x && y >= at.y && x < at.x + at.width && y < at.y + at.height;
}

/**
 * Opens a menu session over a host. The plumbing under `openMenu()`, the menubar
 * and the dropdown, exported so an ejected one of them can still build on it.
 *
 * @param opts - The host, the router, and what to call when it closes.
 * @returns The session, with nothing open in it until `root()` is called.
 */
export function openMenuSession<T>(opts: MenuSessionOptions<T>): MenuSession<T> {
  const host = opts.host;
  const root = host instanceof Element ? host : host?.root;
  if (!(root instanceof Element)) {
    throw new TypeError(__`Expected a menu host to be an element or a renderer`);
  }
  const input = opts.input;
  if (typeof input?.bind !== 'function' || typeof input.onResize !== 'function') {
    throw new TypeError(__`Expected a menu input to be a router`);
  }
  const glyphs = (opts.ascii ?? !unicodeSupported()) ? GLYPHS.ascii : GLYPHS.unicode;
  const extraClasses = menuClasses(opts.menuClass);
  const bar = opts.bar;

  const levels: Level<T>[] = [];
  let open = true;

  // the transparent box under every open menu, the size of the screen: the hit
  // test is topmost first and a box with no background is hittable, so every
  // mouse report lands here or in a menu, and nothing below hears any of it
  const backdrop = box({
    bottom: 0,
    class: 'sigil-menu-backdrop',
    left: 0,
    position: 'fixed',
    right: 0,
    top: 0,
    'z-index': Z_INDEX,
  });

  // a layer over whatever is held already -- a dialog's, when a dropdown in it
  // opens -- so the dialog stands aside while this answers. Not a trap: the focus
  // is left where it was, and the keys are taken by the binding below
  const hold = holdInput(input, { element: backdrop, trap: false });

  /** Builds a row of a menu. */
  function buildRow(entry: MenuEntry<T>, width: number): Row<T> {
    if (isSeparator(entry)) {
      const words = separatorWords(entry);
      const element = raw(
        {
          measure: () => ({ height: 1, width: 0 }),
          paint: (painter, area, it) => {
            const style = cellStyle(it.style);
            painter.fill(area.x, area.y, area.width, 1, style, glyphs.line);
            if (words !== '') {
              painter.text(area.x + 1, area.y, words, style);
            }
          },
        },
        { class: 'sigil-menu-separator sigil-muted', 'flex-shrink': 0 }
      );
      return { element, enabled: false, item: undefined, mnemonic: undefined, pointer: undefined };
    }

    const item = entry;
    const enabled = item.disabled === undefined || item.disabled === false;
    const hint = hintOf(item);
    const { parts } = labelParts(item.label, 'sigil-menu-label');
    const used = rowWidth(item);
    const pointer = textNode(glyphs.pointer, {
      class: 'sigil-menu-pointer',
      visibility: 'hidden',
      'white-space': 'nowrap',
    });
    const tail = `${' '.repeat(Math.max(0, width - used) + (hint ? 2 : 0))}`;
    const children: Element[] = [pointer, textNode(' ', { 'white-space': 'pre' }), ...parts];
    children.push(textNode(tail, { 'white-space': 'pre' }));
    if (hint) {
      children.push(
        textNode(hint, { class: 'sigil-menu-hint sigil-muted', 'white-space': 'nowrap' })
      );
    }
    if (item.items) {
      children.push(
        textNode(` ${glyphs.arrow}`, { class: 'sigil-menu-arrow', 'white-space': 'pre' })
      );
    }
    children.push(textNode(' ', { 'white-space': 'pre' }));
    const element = box(
      { class: 'sigil-menu-item', 'flex-direction': 'row', 'flex-shrink': 0 },
      ...children
    );
    if (!enabled) {
      element.addClass('is-disabled');
      element.addClass('sigil-muted');
    }
    return { element, enabled, item, mnemonic: parseMnemonic(item.label).mnemonic, pointer };
  }

  /** The width a list of entries needs inside its border. */
  function widthOf(items: readonly MenuEntry<T>[]): number {
    return Math.max(4, ...items.map((entry) => rowWidth(entry)));
  }

  /** Opens a menu at the end of the chain. */
  function push(
    items: readonly MenuEntry<T>[],
    anchor: MenuAnchor,
    side: TooltipSide,
    minWidth: number,
    initial: number
  ): Level<T> {
    const width = Math.max(widthOf(items), minWidth - 2);
    const rows = items.map((entry) => buildRow(entry, width));
    const list = box(
      {
        class: 'sigil-menu-list',
        'flex-direction': 'column',
        'flex-shrink': 1,
        'min-height': 0,
        overflow: 'hidden',
      },
      ...rows.map((row) => row.element)
    );
    const popup = box(
      {
        'border-style': glyphs.border,
        class: 'sigil-menu',
        'flex-direction': 'column',
        left: 0,
        position: 'fixed',
        top: 0,
      },
      opaqueFill('sigil-menu-fill'),
      list
    );
    for (const name of extraClasses) {
      popup.addClass(name);
    }
    const level: Level<T> = { anchor, highlight: -1, list, popup, rows, side, viewport: undefined };

    /** What the menu was last placed against, so a layout that moved none of it moves nothing. */
    let against = '';

    // placed after the layout, which is the only thing that knows how wide the
    // menu came out and where its anchor is -- the tooltip's arrangement, and its
    // arithmetic. A fresh menu starts at the screen's corner with the whole width
    // to measure in, and the frame lays out again before it paints
    popup.onLayout = (it): boolean => {
      const screen = root.box;
      const size = it.box;
      const at = anchorBox(anchor);
      if (screen === undefined || size === undefined || at === undefined) {
        return false;
      }
      // taller than the screen: the list is cut to it and scrolls to the highlight
      const natural = rows.length + 2;
      const height = Math.min(natural, screen.height);
      const key = `${at.x},${at.y},${at.width},${at.height}|${size.width}|${screen.x},${screen.y},${screen.width},${screen.height}`;
      let changed = false;
      if (key !== against) {
        against = key;
        const place = placeTooltip(at, { height, width: size.width }, screen, side);
        it.setProps({
          left: place.x - screen.x,
          'max-height': natural > screen.height ? screen.height : undefined,
          top: place.y - screen.y,
        });
        changed = true;
      }
      level.viewport = Math.max(1, height - 2);
      return reveal(level) || changed;
    };

    levels.push(level);
    backdrop.append(popup);
    highlight(level, initial);
    return level;
  }

  /**
   * The box of an anchor, or `undefined` while an element anchor has none.
   *
   * A submenu's anchor is its item's row grown by the border around it, so the
   * submenu opens clear of its parent's edge with its first item level with the
   * row that opened it -- which is where a reader's eye already is.
   */
  function anchorBox(anchor: MenuAnchor): Box | undefined {
    if (!isElement(anchor)) {
      return { height: 0, width: 0, x: anchor.x, y: anchor.y };
    }
    const at = anchor.box;
    if (at === undefined || !rowAnchors.has(anchor)) {
      return at;
    }
    return { height: at.height + 2, width: at.width + 2, x: at.x - 1, y: at.y - 1 };
  }

  /** The rows a submenu is anchored to, which `anchorBox()` grows by the border. */
  const rowAnchors = new WeakSet<Element>();

  /** Scrolls a list so its highlighted row is in view. Says whether it moved. */
  function reveal(level: Level<T>): boolean {
    const view = level.viewport;
    if (view === undefined || level.highlight < 0) {
      return false;
    }
    const top = level.list.scroll?.y ?? 0;
    let next = top;
    if (level.highlight < top) {
      next = level.highlight;
    } else if (level.highlight >= top + view) {
      next = level.highlight - view + 1;
    }
    next = Math.max(0, Math.min(next, level.rows.length - view));
    if (next === top) {
      return false;
    }
    level.list.scrollTo(0, next);
    return true;
  }

  /** Moves a level's highlight, which is the focus role and the pointer on one row. */
  function highlight(level: Level<T>, index: number): void {
    const to = level.rows[index]?.enabled ? index : -1;
    const from = level.rows[level.highlight];
    if (from !== undefined) {
      from.element.removeClass('sigil-focus');
      from.pointer?.setProp('visibility', 'hidden');
    }
    level.highlight = to;
    const now = level.rows[to];
    if (now !== undefined) {
      now.element.addClass('sigil-focus');
      now.pointer?.setProp('visibility', 'visible');
    }
    reveal(level);
  }

  /** Closes every menu deeper than `depth`, which `-1` makes all of them. */
  function truncate(depth: number): void {
    while (levels.length > depth + 1) {
      levels.pop()?.popup.remove();
    }
  }

  /** Opens the submenu of a level's highlighted item, if it has one on offer. */
  function descend(level: Level<T>, how: 'keys' | 'pointer'): boolean {
    const row = level.rows[level.highlight];
    const sub = row?.item?.items;
    if (row === undefined || !row.enabled || sub === undefined) {
      return false;
    }
    const depth = levels.indexOf(level);
    // already open: keys go into it, the pointer leaves it be
    const open = levels[depth + 1];
    if (open !== undefined && open.anchor === row.element) {
      if (how === 'keys' && open.highlight < 0) {
        highlight(open, nextEnabled(open.rows, -1, 1));
      }
      return true;
    }
    truncate(depth);
    rowAnchors.add(row.element);
    const child = push(sub, row.element, 'right', 0, -1);
    if (how === 'keys') {
      highlight(child, nextEnabled(child.rows, -1, 1));
    }
    return true;
  }

  /** Chooses a level's highlighted item, or opens its submenu. */
  function activate(level: Level<T>, how: 'keys' | 'pointer'): void {
    const row = level.rows[level.highlight];
    if (row === undefined || !row.enabled || row.item === undefined) {
      return;
    }
    if (row.item.items !== undefined) {
      descend(level, how);
      return;
    }
    finish(row.item);
  }

  /** The menu and row under a cell, deepest menu first. */
  function hit(x: number, y: number): { index: number; level: Level<T> } | undefined {
    for (let depth = levels.length - 1; depth >= 0; depth--) {
      const level = levels[depth] as Level<T>;
      if (!holds(level.popup.box, x, y)) {
        continue;
      }
      if (holds(level.list.box, x, y)) {
        const index = level.rows.findIndex((row) => holds(row.element.box, x, y));
        return { index, level };
      }
      return { index: -1, level };
    }
    return undefined;
  }

  /** The pointer is over a row: highlight it, and open its submenu. */
  function hover(level: Level<T>, index: number): void {
    const row = level.rows[index];
    if (row === undefined || !row.enabled) {
      return;
    }
    const depth = levels.indexOf(level);
    if (level.highlight !== index) {
      truncate(depth);
      highlight(level, index);
    }
    descend(level, 'pointer');
  }

  function pointAt(x: number, y: number): void {
    const at = hit(x, y);
    if (at !== undefined) {
      hover(at.level, at.index);
      return;
    }
    const title = bar?.at(x, y) ?? -1;
    if (bar !== undefined && title !== -1 && title !== bar.current()) {
      bar.show(title, 'pointer');
    }
  }

  function releaseAt(x: number, y: number): void {
    const at = hit(x, y);
    const row = at?.level.rows[at.index];
    if (
      at !== undefined &&
      row?.enabled &&
      row.item !== undefined &&
      row.item.items === undefined
    ) {
      finish(row.item);
    }
  }

  backdrop.onMouse = (event: MouseEvent): void => {
    // nothing below hears anything while a menu is up, and a press stopped here
    // is a press click-to-focus never sees, so the focus stays where it was
    event.stop();
    if (!open) {
      return;
    }
    const { x, y } = event;
    if (event.kind === 'mousemove') {
      pointAt(x, y);
      return;
    }
    if (event.kind === 'wheel') {
      const at = hit(x, y);
      if (at !== undefined && (event.wheel === 'up' || event.wheel === 'down')) {
        const by = event.wheel === 'up' ? -1 : 1;
        truncate(levels.indexOf(at.level));
        highlight(at.level, nextEnabled(at.level.rows, at.level.highlight, by));
      }
      return;
    }
    if (event.kind !== 'click') {
      return;
    }
    const at = hit(x, y);
    if (at !== undefined) {
      if (event.button === 'left' && at.index !== -1) {
        hover(at.level, at.index);
        if (at.level.highlight === at.index) {
          activate(at.level, 'pointer');
        }
      }
      return;
    }
    const title = bar?.at(x, y) ?? -1;
    if (bar !== undefined && title !== -1) {
      // the open title closes its menu, which is what a second click on a
      // menubar does everywhere; another title opens its own instead
      if (title === bar.current()) {
        finish();
      } else {
        bar.show(title, 'pointer');
      }
      return;
    }
    // outside every menu, with any button: dismissed, and the click is spent
    finish();
  };

  /** The deepest open menu, which is the one the keys are for. */
  const deepest = (): Level<T> | undefined => levels.at(-1);

  function onKey(event: KeyEvent): void {
    // a dialog under the menu has its binding run first and stand aside, and one
    // opened over it -- an item's own action, say -- is on top and answers
    if (!open || !hold.isTop()) {
      return;
    }
    const k = event.key;
    // never the abort: a binding sees every key first so that the app can always
    // be quit, which is the modal's rule
    if (isAbort(k)) {
      return;
    }
    if (event.paste) {
      event.stop();
      return;
    }
    const level = deepest();
    const depth = levels.length - 1;
    const plain = !k.ctrl && !k.meta;

    if (k.name === 'tab' && plain) {
      // closed, and the key goes on: the focus moves the way it would have
      finish();
      return;
    }
    event.stop();

    if (bar !== undefined && k.name === 'f10' && plain && !k.shift) {
      finish();
      return;
    }
    if (bar !== undefined && k.meta && !k.ctrl && [...k.name].length === 1) {
      const title = bar.title(k.name.toLowerCase());
      if (title !== -1) {
        bar.show(title, 'keys');
      }
      return;
    }
    if (!plain || level === undefined) {
      return;
    }

    switch (k.name) {
      case 'up':
      case 'down': {
        const by = k.name === 'up' ? -1 : 1;
        truncate(depth);
        const from = level.highlight === -1 ? (by === 1 ? -1 : level.rows.length) : level.highlight;
        highlight(level, nextEnabled(level.rows, from, by));
        return;
      }
      case 'home':
      case 'pageup': {
        truncate(depth);
        highlight(level, nextEnabled(level.rows, -1, 1));
        return;
      }
      case 'end':
      case 'pagedown': {
        truncate(depth);
        highlight(level, nextEnabled(level.rows, level.rows.length, -1));
        return;
      }
      case 'right': {
        if (!descend(level, 'keys') && bar !== undefined) {
          bar.step(1);
        }
        return;
      }
      case 'left': {
        if (depth > 0) {
          truncate(depth - 1);
        } else if (bar !== undefined) {
          bar.step(-1);
        }
        return;
      }
      case 'escape': {
        if (depth > 0) {
          truncate(depth - 1);
        } else {
          finish();
        }
        return;
      }
      case 'enter':
      case 'space': {
        activate(level, 'keys');
        return;
      }
      default:
    }

    // a mnemonic. One item with it is chosen, as a click on it would be; several
    // share it, and the highlight steps through them instead
    if ([...k.name].length !== 1) {
      return;
    }
    const letter = k.name.toLowerCase();
    const matches = level.rows
      .map((row, index) => (row.enabled && row.mnemonic === letter ? index : -1))
      .filter((index) => index !== -1);
    if (matches.length === 0) {
      return;
    }
    truncate(depth);
    if (matches.length === 1) {
      highlight(level, matches[0] as number);
      activate(level, 'keys');
      return;
    }
    const after = matches.find((index) => index > level.highlight) ?? (matches[0] as number);
    highlight(level, after);
  }

  const offKey = input.bind(onKey);

  // a resize closes it, which is what a desktop does: a menu placed against a
  // screen that is not there now is in the wrong place, and the reader is not
  // in the middle of anything a reopen cannot give back
  const offResize = input.onResize(() => {
    finish();
  });

  let offDispose: (() => void) | undefined;

  function finish(item?: MenuItem<T>): void {
    if (!open) {
      return;
    }
    open = false;
    hold.release();
    offKey();
    offResize();
    offDispose?.();
    truncate(-1);
    backdrop.remove();
    opts.onClose(item);
  }

  root.append(backdrop);

  // closed with nothing chosen when the renderer goes, for the modal's reason:
  // the binding stops every key, and a router the app keeps would lose them all
  if (!(host instanceof Element)) {
    offDispose = host.onDispose?.(() => {
      finish();
    });
  }

  return {
    element: backdrop,
    finish,
    get open() {
      return open;
    },
    pointAt,
    releaseAt,
    root(items, at, o = {}): void {
      if (!open) {
        return;
      }
      try {
        checkMenuEntries(items);
        truncate(-1);
        const level = push(items, at, o.side ?? 'bottom', o.minWidth ?? 0, -1);
        highlight(level, o.initial ?? -1);
      } catch (error) {
        // the session took the keys and the mouse when it opened, and with no menu
        // in it there is no level for Escape to close: every key would be swallowed
        // until a click outside. So a root that failed closes the session it was in.
        if (levels.length === 0) {
          finish();
        }
        throw error;
      }
    },
  };
}

/** Whether a value is an element. */
function isElement(value: unknown): value is Element {
  return value instanceof Element;
}

const SIDES: readonly TooltipSide[] = ['bottom', 'left', 'right', 'top'];

/**
 * Opens a menu beside an element or at a cell.
 *
 * @param host - The renderer, or the element the router was built over.
 * @param opts - The router, the items, and where it goes.
 * @returns The handle.
 */
export function openMenu<T = unknown>(host: MenuHost, opts: MenuOptions<T>): MenuHandle<T> {
  checkMenuEntries(opts?.items);
  menuClasses(opts.menuClass);
  const at = opts.at;
  if (
    !isElement(at) &&
    !(typeof at?.x === 'number' && Number.isFinite(at.x) && Number.isFinite(at.y))
  ) {
    throw new TypeError(__`Expected a menu to be at an element or a cell`);
  }
  const side = opts.side ?? 'bottom';
  if (!SIDES.includes(side)) {
    throw new TypeError(__`Expected a menu side to be top, bottom, left or right`);
  }
  if (opts.minWidth !== undefined && !(Number.isInteger(opts.minWidth) && opts.minWidth >= 0)) {
    throw new TypeError(__`Expected a menu minWidth to be a whole number of cells`);
  }
  if (
    opts.initial !== undefined &&
    !(Number.isInteger(opts.initial) && opts.initial >= 0 && opts.initial < opts.items.length)
  ) {
    throw new TypeError(__`Expected menu initial to be the position of an item`);
  }

  let settle!: (item: MenuItem<T> | undefined) => void;
  const result = new Promise<MenuItem<T> | undefined>((resolve) => {
    settle = resolve;
  });
  const session = openMenuSession<T>({
    ascii: opts.ascii,
    host,
    input: opts.input,
    menuClass: opts.menuClass,
    onClose(item) {
      settle(item);
      if (item !== undefined) {
        opts.onSelect?.(item);
      }
    },
  });
  const initial =
    opts.initial ??
    opts.items.findIndex((entry) => !isSeparator(entry) && (entry.disabled ?? false) === false);
  session.root(opts.items, at, { initial, minWidth: opts.minWidth ?? 0, side });

  return {
    close: () => session.finish(),
    dispose: () => session.finish(),
    element: session.element,
    get open() {
      return session.open;
    },
    result,
  };
}

export interface ContextMenuOptions<T = unknown> {
  /** Draw it with ASCII only. Defaults to what `unicodeSupported()` says. */
  ascii?: boolean;
  /** The router the right click and the keys come from. */
  input: InputRouter;
  /**
   * What it offers. A function is asked at each opening, with the element the
   * click landed on or the focus is on, so the menu can be about that.
   */
  items: readonly MenuEntry<T>[] | ((target: Element) => readonly MenuEntry<T>[]);
  /** Classes put on every menu it opens, submenus included; `openMenu()`'s option. */
  menuClass?: string;
  /** Called with the item chosen. */
  onSelect?: (item: MenuItem<T>, target: Element) => void;
}

export interface ContextMenuHandle<T = unknown> {
  /** Takes it off the element, closing a menu it has open. */
  dispose(): void;
  /** The menu while one is open. */
  readonly menu: MenuHandle<T> | undefined;
}

/**
 * Gives an element a context menu: a right click inside it opens one at the
 * pointer, and Shift-F10 or the Menu key with the focus inside it opens one at the
 * focused element.
 *
 * The element's own hooks are left alone. The right click is heard through the
 * router's `onMouse()`, which sees what the tree did not stop -- so a control that
 * stops its own right click keeps it -- and the keys through a binding.
 *
 * @param target - The element the menu is about.
 * @param opts - The router, the items, and what to do with a choice.
 * @returns The handle.
 */
export function attachContextMenu<T = unknown>(
  target: Element,
  opts: ContextMenuOptions<T>
): ContextMenuHandle<T> {
  if (!isElement(target)) {
    throw new TypeError(__`Expected a context menu target to be an element`);
  }
  const input = opts?.input;
  if (typeof input?.bind !== 'function' || typeof input.onMouse !== 'function') {
    throw new TypeError(__`Expected a context menu input to be a router`);
  }
  if (typeof opts.items !== 'function') {
    checkMenuEntries(opts.items);
  }
  menuClasses(opts.menuClass);

  let menu: MenuHandle<T> | undefined;

  function show(at: MenuAnchor, about: Element): void {
    const root = rootOf(target);
    // taken out of the tree: nothing is drawing it, so there is nowhere to open
    if (root === target) {
      return;
    }
    const items = typeof opts.items === 'function' ? opts.items(about) : opts.items;
    menu = openMenu<T>(root, {
      ascii: opts.ascii,
      at,
      input,
      items,
      menuClass: opts.menuClass,
      onSelect: (item) => opts.onSelect?.(item, about),
    });
  }

  const offMouse = input.onMouse((event) => {
    if (event.kind !== 'click' || event.button !== 'right') {
      return;
    }
    const on = event.target;
    if (on === undefined || !target.contains(on)) {
      return;
    }
    const top = topLayer(input);
    if (top !== undefined && !top.element.contains(on)) {
      return;
    }
    event.stop();
    show({ x: event.x, y: event.y }, on);
  });

  const offKey = input.bind((event) => {
    const k = event.key;
    const asked =
      !event.paste &&
      !k.ctrl &&
      !k.meta &&
      ((k.name === 'f10' && k.shift) || (k.name === 'menu' && !k.shift));
    if (!asked) {
      return;
    }
    const at = input.focus.current.get();
    if (at === undefined || !target.contains(at)) {
      return;
    }
    // under a dialog or a menu that is not about this, the key is the top one's
    const top = topLayer(input);
    if (top !== undefined && !top.element.contains(at)) {
      return;
    }
    event.stop();
    show(at, at);
  });

  const offHelp = input.describe('shift+f10', {
    description: __`menu`,
    priority: -1,
    scope: target,
  });

  function dispose(): void {
    offMouse();
    offKey();
    offHelp();
    menu?.close();
  }

  // attached inside a component, it goes when the component does
  onCleanup(dispose);

  return {
    dispose,
    get menu() {
      return menu?.open ? menu : undefined;
    },
  };
}
