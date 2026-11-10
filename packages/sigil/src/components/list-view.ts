/**
 * A list view: a scrolling list of rows with a current row, and keys to move it.
 *
 * The workhorse of lazygit, k9s, every file manager and every log viewer, as an
 * element. `select()` and `multiselect()` are prompts and `ScrollBox` has no notion
 * of a selection; this is the element between them.
 *
 * ```js
 * import { ListView } from '@ttylabs/sigil/components/list-view';
 *
 * const files = ListView({
 *   items: ['README.md', 'package.json', 'src/'],
 *   onActivate: (key) => open(key),
 *   props: { height: 10 },
 * });
 * ```
 *
 * It is two layers, and the lower one is published for the table and the tree to
 * stand on. {@link createListSelection} is the selection with no elements in it:
 * the current row as a key, the selected rows as a set of keys, and the moves --
 * by one, by a page, to an end -- over whatever rows it was last handed. Rows are
 * identified by key, so a re-sort, a filter or a live update that replaces the
 * data leaves the selection on the same rows. {@link ListView} is the element over
 * it: a `ScrollBox` whose rows are windowed and keyed, a pointer on the current
 * row, a mark on each selected one, the keys and the mouse. `AGENTS.md` has the
 * reasons under "A list view".
 */

import { box, type Element, type ElementPropsWithout, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import {
  type DescribeOptions,
  DOUBLE_CLICK_MS,
  type KeyEvent,
  type MouseEvent,
} from '../input/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { State, untrack } from '../signals/index.js';
import { unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import { ScrollBox, scrollControl, type ScrollControl } from './scroll-box.js';

// -- the selection, with no elements in it ------------------------------------

export interface ListSelectionOptions<K> {
  /**
   * The current row, as its key.
   *
   * A key is where the cursor starts. A `State` is the state itself: the moves
   * write it, and an app that writes it moves the cursor -- the shape `Tabs`'
   * `active` and `Collapsible`'s `open` have. Left out, or `undefined`, the cursor
   * starts on the first row that is not disabled.
   */
  current?: K | State<K | undefined>;
  /**
   * Whether more than one row can be selected. Defaults to `false`, where the
   * current row is the selection and `selected` stays empty.
   */
  multiple?: boolean;
  /**
   * The selected rows, as a set of keys, for a `multiple` selection.
   *
   * Keys are where it starts; a `State` is the state itself. It is replaced
   * rather than mutated by every write here, and an app writing it does the same:
   * a `State` notifies on a new value, so a set changed in place is one nobody
   * hears about.
   */
  selected?: Iterable<K> | State<ReadonlySet<K>>;
}

/**
 * A current row and a set of selected rows, over rows identified by key.
 *
 * What `ListView` is built on, and published so that a table and a tree build on
 * the same answer rather than a second one: the rows are whatever was last handed
 * to {@link ListSelection.setRows} -- a list's items, a table's rows in the order
 * they are sorted into, a tree's visible nodes -- and every move is over those.
 *
 * Every method reads the states **untracked**, so calling one from inside an
 * effect makes it depend on nothing; an effect that wants to follow the cursor
 * reads `current` itself.
 */
export interface ListSelection<K> {
  /**
   * The current row's key. Kept on a row that can be moved to whenever there is
   * one; with none -- no rows, or every row disabled -- it keeps the key it had, so
   * a filter that matched nothing and is then cleared finds the cursor where it
   * was.
   */
  readonly current: State<K | undefined>;
  /** Moves to the first row that is not disabled. @returns Whether the cursor moved. */
  first(): boolean;
  /** The current row's position in the rows, or `-1` where it is not one of them. */
  index(): number;
  /** The position of the row with a key, or `-1`. */
  indexOf(key: K): number;
  /** Whether the row at a position is disabled, which a move passes over. */
  isDisabled(index: number): boolean;
  /** Whether a key is in `selected`. */
  isSelected(key: K): boolean;
  /** The key of the row at a position, or `undefined` past either end. */
  keyAt(index: number): K | undefined;
  /** Moves to the last row that is not disabled. @returns Whether the cursor moved. */
  last(): boolean;
  /**
   * Moves the cursor by a number of rows -- one for an arrow, a page for Page Down
   * -- passing over disabled rows, and stopping at the ends rather than wrapping.
   *
   * @returns Whether the cursor moved.
   */
  move(by: number): boolean;
  /**
   * Moves the cursor to the row at a position, or to the nearest row that is not
   * disabled, looking the way `direction` says first.
   *
   * @returns Whether the cursor moved.
   */
  moveTo(index: number, direction?: 1 | -1): boolean;
  /** Whether more than one row can be selected. */
  readonly multiple: boolean;
  /** How many rows there are. */
  readonly rowCount: number;
  /** The selected rows' keys, for a `multiple` selection. Never pruned by `setRows()`. */
  readonly selected: State<ReadonlySet<K>>;
  /**
   * Hands over the rows, in the order they are shown, and settles the cursor on
   * them: it stays on its key wherever that key now is; a key that is gone puts it
   * on the row now at the position it had, or the nearest one that is not
   * disabled; and a row that became disabled under it moves it the same way.
   *
   * Each key must be unique, and a duplicate throws: a key is what the cursor and
   * the selection mean by a row, so two rows with one key are two rows nothing can
   * tell apart.
   *
   * @param keys - The rows' keys, in order. Kept, not copied: hand over a new array
   *   rather than changing this one.
   * @param disabled - Whether the row at a position is disabled.
   */
  setRows(keys: readonly K[], disabled?: (index: number) => boolean): void;
  /**
   * Puts the cursor back on a row it can be on, after an app wrote a key that is
   * not one: the rule `setRows()` applies, without new rows.
   *
   * @returns Whether the cursor moved.
   */
  settle(): boolean;
  /**
   * Selects every row that is not disabled, or, where every one already is,
   * unselects them. Disabled rows and keys that are not among the rows are left as
   * they were. Does nothing for a single selection.
   *
   * @returns Whether the selection changed.
   */
  toggleAll(): boolean;
  /**
   * Selects a row or unselects it: the current row by default. Refused for a key
   * that is not among the rows, a disabled row, and a single selection.
   *
   * @returns Whether the selection changed.
   */
  toggle(key?: K): boolean;
}

/**
 * Builds a selection: a current row and, for a `multiple` one, a set of selected
 * rows, both by key.
 *
 * @param opts - Where the cursor and the selection start, or the states that hold
 *   them, and whether the selection is multiple.
 * @returns The selection, with no rows until `setRows()` is called.
 */
export function createListSelection<K>(opts: ListSelectionOptions<K> = {}): ListSelection<K> {
  if (opts.selected !== undefined && !(opts.selected instanceof State)) {
    if (typeof (opts.selected as Iterable<K>)[Symbol.iterator] !== 'function') {
      throw new TypeError(__`Expected list selected to be an iterable of keys or a State`);
    }
  }
  const multiple = opts.multiple === true;
  const current =
    opts.current instanceof State ? opts.current : new State<K | undefined>(opts.current);
  const selected =
    opts.selected instanceof State
      ? opts.selected
      : new State<ReadonlySet<K>>(new Set(opts.selected ?? []));

  let keys: readonly K[] = [];
  let positions = new Map<K, number>();
  let off: (index: number) => boolean = () => false;
  /**
   * Where the current row was last seen, which is where the cursor goes when its
   * key disappears: the row that took its place, rather than the top.
   */
  let last = -1;

  const peek = (): K | undefined => untrack(() => current.get());
  const clamp = (index: number): number => Math.min(Math.max(index, 0), keys.length - 1);
  const disabledAt = (index: number): boolean => off(index) === true;

  /** The first row from `from` that is not disabled, walking one way. */
  const nearest = (from: number, direction: 1 | -1): number => {
    for (let i = from; i >= 0 && i < keys.length; i += direction) {
      if (!disabledAt(i)) {
        return i;
      }
    }
    return -1;
  };
  /** The nearest row that is not disabled, looking one way first and then the other. */
  const around = (from: number, direction: 1 | -1 = 1): number => {
    if (keys.length === 0) {
      return -1;
    }
    const at = clamp(from);
    const ahead = nearest(at, direction);
    return ahead >= 0 ? ahead : nearest(at, direction === 1 ? -1 : 1);
  };
  const go = (index: number): boolean => {
    if (index < 0) {
      return false;
    }
    last = index;
    const key = keys[index] as K;
    if (peek() === key) {
      return false;
    }
    current.set(key);
    return true;
  };
  const indexOf = (key: K | undefined): number =>
    key === undefined ? -1 : (positions.get(key) ?? -1);

  const settle = (): boolean => {
    const key = peek();
    const at = indexOf(key);
    if (at >= 0 && !disabledAt(at)) {
      last = at;
      return false;
    }
    // gone, or disabled now: the row at the place it had, or the nearest one that
    // can be the cursor -- and with none, the key is kept, so the cursor comes back
    // to it when the rows do
    return go(around(at >= 0 ? at : last >= 0 ? last : 0));
  };

  const write = (next: Set<K>): boolean => {
    selected.set(next);
    return true;
  };

  return {
    current,
    first: () => go(nearest(0, 1)),
    index: () => indexOf(peek()),
    indexOf: (key) => indexOf(key),
    isDisabled: (index) => index >= 0 && index < keys.length && disabledAt(index),
    isSelected: (key) => untrack(() => selected.get()).has(key),
    keyAt: (index) => (index >= 0 && index < keys.length ? keys[index] : undefined),
    last: () => go(nearest(keys.length - 1, -1)),
    move(by: number): boolean {
      if (keys.length === 0) {
        return false;
      }
      const step = Math.trunc(by);
      const from = indexOf(peek());
      if (from < 0) {
        // no cursor among these rows yet: any move puts it on the first one
        return go(around(0));
      }
      if (step === 0) {
        return false;
      }
      const direction = step > 0 ? 1 : -1;
      const target = clamp(from + step);
      const ahead = nearest(target, direction);
      // a page that lands past the last row that can be the cursor stops on it
      // rather than not moving at all
      return go(ahead >= 0 ? ahead : nearest(target, direction === 1 ? -1 : 1));
    },
    moveTo: (index, direction = 1) => go(around(Math.trunc(index), direction)),
    multiple,
    get rowCount() {
      return keys.length;
    },
    selected,
    setRows(next, disabled) {
      const map = new Map<K, number>();
      for (const [i, key] of next.entries()) {
        if (map.has(key)) {
          throw new TypeError(
            __`Expected every list row to have a key of its own: ${String(key)} is used twice`
          );
        }
        map.set(key, i);
      }
      // where the cursor was, by position, before the rows moved under it
      const was = indexOf(peek());
      if (was >= 0) {
        last = was;
      }
      keys = next;
      positions = map;
      off = disabled ?? (() => false);
      settle();
    },
    settle,
    toggleAll(): boolean {
      if (!multiple) {
        return false;
      }
      const now = untrack(() => selected.get());
      const open: K[] = [];
      for (const [i, key] of keys.entries()) {
        if (!disabledAt(i)) {
          open.push(key);
        }
      }
      if (open.length === 0) {
        return false;
      }
      const next = new Set(now);
      if (open.every((key) => now.has(key))) {
        for (const key of open) {
          next.delete(key);
        }
      } else {
        for (const key of open) {
          next.add(key);
        }
      }
      return write(next);
    },
    toggle(key = peek()): boolean {
      if (!multiple || key === undefined) {
        return false;
      }
      const at = indexOf(key);
      if (at < 0 || disabledAt(at)) {
        return false;
      }
      const next = new Set(untrack(() => selected.get()));
      if (!next.delete(key)) {
        next.add(key);
      }
      return write(next);
    },
  };
}

// -- the element -------------------------------------------------------------

/** What a list reads its items from: an array, or a `State` or a `Computed` of one. */
export interface ListItems<T> {
  get(): readonly T[];
}

export interface ListViewProps<T, K = T> {
  /**
   * Draw the pointer and the marks with ASCII only, `>` and `[x]`. Defaults to
   * what `unicodeSupported()` says, which is the rule `Tabs` keeps.
   */
  ascii?: boolean;
  /**
   * The current row, as its key, or the state that holds it: see
   * {@link ListSelectionOptions.current}.
   */
  current?: K | State<K | undefined>;
  /**
   * Whether an item's row is disabled: drawn muted, passed over by the cursor, not
   * clicked, and never selected by a key or a click.
   */
  disabled?: (item: T) => boolean;
  /**
   * What to show when there are no items. A string is drawn muted; a function
   * builds an element. Defaults to "Nothing to show".
   */
  empty?: string | (() => Element);
  /**
   * Type-to-find: a printable key moves the cursor to the next row whose `label`
   * starts with what was typed in the last second. Off by default, because a list
   * that takes every letter takes the app's own keys -- `q` among them -- while it
   * has the focus. Not with `vim`, which wants four of those letters.
   */
  find?: boolean;
  /**
   * The items, in the order they are shown.
   *
   * An array is fixed. A `State` or a `Computed` is followed: a new array re-keys
   * the rows, keeps the cursor and the selection on their keys, and rebuilds the
   * rows on screen whose item is a different object than when they were built.
   * Replace the array to change it, since a `State` hears a new value and not a
   * mutated one; for items changed in place, `listControl(host).refresh()`.
   */
  items: readonly T[] | ListItems<T>;
  /**
   * What identifies an item's row, which the cursor and the selection hold.
   * Defaults to the item itself, which is right for strings and for objects that
   * are never replaced; data that is fetched again wants its own id here.
   */
  key?: (item: T) => K;
  /**
   * The text type-to-find matches against. Defaults to the item itself for a
   * string or a number, and nothing -- a row `find` never lands on -- otherwise.
   */
  label?: (item: T) => string;
  /**
   * Whether more than one row can be selected. Space selects the current row,
   * Ctrl-A every row, and a click the row clicked; each selected row carries a
   * mark. Defaults to `false`, where the current row is the selection.
   */
  multiple?: boolean;
  /**
   * Called with the current row's key and item on Enter or a double-click. A list
   * without one claims neither, so Enter reaches whatever is around it.
   */
  onActivate?: (key: K, item: T) => void;
  /** The host box's own props: a height, a border, a class. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey'>;
  /**
   * Builds an item's row: an element, or a string drawn as one line.
   *
   * Called when the row comes into view and again when its item is replaced, not
   * when the cursor or the selection moves -- those are classes on the row around
   * it, `is-current` and `is-selected`, which a stylesheet reaches with
   * `.sigil-list-row.is-current .mine`. Called under an owner of its own, so the
   * row may hold effects; they are disposed when the row leaves the view.
   */
  row?: (item: T, key: K) => Element | string;
  /** Every row's height in cells, fixed rather than measured. Defaults to 1. */
  rowHeight?: number;
  /** Whether to draw a scrollbar. Defaults to `true`. */
  scrollbar?: boolean;
  /**
   * The selected rows, as keys, or the state that holds them: see
   * {@link ListSelectionOptions.selected}.
   */
  selected?: Iterable<K> | State<ReadonlySet<K>>;
  /**
   * `j` and `k` to move, and `g` and `G` to the ends, which is `less`'s spelling
   * and the pager's. Off by default for the reason `find` is.
   */
  vim?: boolean;
}

/**
 * What a component built **on** a list holds it by: the selection, the scroll
 * box, and the three things only the list can do.
 */
export interface ListControl<K> {
  /**
   * Calls `onActivate` for the current row, as Enter does.
   *
   * @returns Whether there was a handler and a current row to call it with.
   */
  activate(): boolean;
  /**
   * Builds the rows in view again from the items as they are now, for items
   * changed in place. Items replaced by new objects need no call.
   */
  refresh(): void;
  /**
   * Scrolls so that a row is in view, the current row by default -- what every
   * move does by itself.
   *
   * @returns Whether the view moved.
   */
  reveal(key?: K): boolean;
  /** The scroll box the rows are windowed in. */
  readonly scroll: ScrollControl;
  /** The selection: the cursor, the selected rows, and the moves. */
  readonly selection: ListSelection<K>;
}

/** Where a list's keys are described, which is the whole of what is asked of a router. */
export interface ListViewDescriber {
  describe(keys: string, opts: DescribeOptions): () => void;
}

/** What the rows draw with, unicode and ASCII. */
const MARKS = {
  ascii: { off: '[ ]', on: '[x]', pointer: '>' },
  unicode: { off: '◯', on: '◉', pointer: '❯' },
} as const;

/** The keys that move the cursor, which Shift turns into something this list leaves alone. */
const MOVES = new Set(['down', 'end', 'home', 'pagedown', 'pageup', 'up']);

/**
 * What `vim: true` adds: `less`'s spelling, which is the pager's. A `Map`, so a key
 * name is never looked up on `Object.prototype`.
 */
const VIM = new Map<string, number | 'first' | 'last'>([
  ['G', 'last'],
  ['g', 'first'],
  ['j', 1],
  ['k', -1],
]);

/** How long type-to-find keeps what was typed, in milliseconds. */
const FIND_MS = 1000;

interface Model {
  control: ListControl<unknown>;
  /** What the describer needs to know: which keys this list claims. */
  keys: { activate: boolean; find: boolean; multiple: boolean; vim: boolean };
}

/** Each list's control, keyed by the host `ListView()` returned. */
const MODELS = new WeakMap<Element, Model>();

/** One row on screen: the parts a move of the cursor or the selection restyles. */
interface Built {
  mark: Element | undefined;
  pointer: Element;
  row: Element;
}

/**
 * Builds a list view.
 *
 * @param props - The items, how a row is drawn, the selection, and the host's props.
 * @returns The host element, which is the one that takes the focus.
 */
export function ListView<T, K = T>(props: ListViewProps<T, K>): Element {
  refuseOwnedHooks('ListView', props.props, ['onFocusChange', 'onKey']);
  const source = props.items;
  if (!Array.isArray(source) && typeof (source as ListItems<T> | undefined)?.get !== 'function') {
    throw new TypeError(__`Expected list items to be an array, a State or a Computed`);
  }
  for (const name of ['disabled', 'key', 'label', 'onActivate', 'row'] as const) {
    if (props[name] !== undefined && typeof props[name] !== 'function') {
      throw new TypeError(__`Expected list ${name} to be a function`);
    }
  }
  if (
    props.empty !== undefined &&
    typeof props.empty !== 'string' &&
    typeof props.empty !== 'function'
  ) {
    throw new TypeError(
      __`Expected list empty to be a string or a function that builds an element`
    );
  }
  if (props.find && props.vim) {
    throw new TypeError(__`A list takes type-to-find or vim keys, and not both`);
  }

  const read = (): readonly T[] =>
    Array.isArray(source) ? source : (source as ListItems<T>).get();
  const keyOf = props.key ?? ((item: T) => item as unknown as K);
  const labelOf =
    props.label ??
    ((item: T) => (typeof item === 'string' || typeof item === 'number' ? String(item) : ''));
  const step = Math.max(1, Math.trunc(props.rowHeight ?? 1));
  const marks = (props.ascii ?? !unicodeSupported()) ? MARKS.ascii : MARKS.unicode;
  const selection = createListSelection<K>({
    current: props.current,
    multiple: props.multiple,
    selected: props.selected,
  });
  const { current, selected } = selection;

  /** The items the rows were last keyed from, and their keys. */
  let items: readonly T[] = [];
  let keys: K[] = [];
  /**
   * Each row's identity for the scroll box: its key and the item it was built from
   * together, so a replaced item is a row the scroll box has not seen and builds.
   */
  let tokens = new Map<K, { item: T; token: object }>();
  /** The rows on screen, by key. */
  const live = new Map<K, Built>();
  /** Whether the list has the focus, which only the current row shows. */
  let focused = false;

  const tokenAt = (index: number): object => {
    const key = keys[index] as K;
    const item = items[index] as T;
    let held = tokens.get(key);
    if (held === undefined || held.item !== item) {
      held = { item, token: {} };
      tokens.set(key, held);
    }
    return held.token;
  };

  /** Puts the cursor's and the selection's classes on one row. */
  const paint = (key: K, built: Built, now: K | undefined, chosen: ReadonlySet<K>): void => {
    const on = key === now;
    built.row.toggleClass('is-current', on);
    built.row.toggleClass('sigil-focus', on && focused);
    built.pointer.setProp('visibility', on ? 'visible' : 'hidden');
    if (built.mark) {
      const ticked = chosen.has(key);
      built.row.toggleClass('is-selected', ticked);
      built.mark.setText(ticked ? marks.on : marks.off);
      built.mark.toggleClass('sigil-accent', ticked);
    }
  };

  /** Double-click bookkeeping: the row last clicked, and when. */
  let lastClick: { at: number; key: K } | undefined;

  const buildRow = (index: number): Element => {
    const item = items[index] as T;
    const key = keys[index] as K;
    const token = tokens.get(key)?.token;
    const drawn = props.row ? props.row(item, key) : labelOf(item) || String(item);
    const content =
      typeof drawn === 'string'
        ? textNode(drawn, { class: 'sigil-list-text', 'white-space': 'nowrap' })
        : drawn;

    const pointer = textNode(marks.pointer, {
      class: 'sigil-list-pointer sigil-accent',
      'flex-shrink': 0,
      'margin-right': 1,
      visibility: 'hidden',
    });
    const mark = selection.multiple
      ? textNode(marks.off, { class: 'sigil-list-mark', 'flex-shrink': 0, 'margin-right': 1 })
      : undefined;
    const body = box(
      { class: 'sigil-list-content', 'flex-direction': 'column', 'flex-grow': 1, 'min-width': 0 },
      content
    );
    const row = box(
      { class: 'sigil-list-row', 'flex-direction': 'row', 'flex-grow': 1 },
      pointer,
      ...(mark ? [mark] : []),
      body
    );
    const off = props.disabled?.(item) === true;
    if (off) {
      row.addClass('is-disabled');
      row.addClass('sigil-muted');
    }

    // the click rather than the press, so the press keeps its default action --
    // focusing the list -- and a press dragged off the row picks nothing
    row.onMouse = (event: MouseEvent): void => {
      if (event.kind !== 'click' || event.button !== 'left') {
        return;
      }
      event.stop();
      const at = selection.indexOf(key);
      if (at < 0 || selection.isDisabled(at)) {
        return;
      }
      const now = Date.now();
      const second =
        props.onActivate !== undefined &&
        lastClick !== undefined &&
        lastClick.key === key &&
        now - lastClick.at <= DOUBLE_CLICK_MS;
      lastClick = second ? undefined : { at: now, key };
      selection.moveTo(at);
      if (second) {
        // the second click of a double-click activates, and does not also undo
        // the toggle the first one made
        activate();
        return;
      }
      selection.toggle(key);
    };

    const built: Built = { mark, pointer, row };
    live.set(key, built);
    paint(
      key,
      built,
      untrack(() => current.get()),
      untrack(() => selected.get())
    );
    // the row's own owner is disposed when it leaves the view; a row rebuilt for a
    // new item is built before the old one goes, so the old one checks it is still
    // the one on record before taking it off
    onCleanup(() => {
      if (live.get(key) === built) {
        live.delete(key);
      }
      const held = tokens.get(key);
      if (held !== undefined && held.token === token) {
        tokens.delete(key);
      }
    });
    return row;
  };

  const scroll = ScrollBox({
    // the list holds the focus and every key, so the box inside it holds neither
    props: {
      class: 'sigil-list-scroll',
      'flex-basis': 0,
      'flex-grow': 1,
      focusable: false,
      'min-height': 0,
    },
    onResize: () => (pending ? reveal() : false),
    rows: {
      // read on every window, which is what lets the items change under it
      get count() {
        return keys.length;
      },
      height: step,
      key: tokenAt,
      row: buildRow,
    },
    scrollbar: props.scrollbar,
  });
  const control = scrollControl(scroll) as ScrollControl;
  const viewport = control.viewport;

  const empty =
    typeof props.empty === 'function'
      ? props.empty()
      : textNode(props.empty ?? __`Nothing to show`, {
          class: 'sigil-list-empty sigil-muted',
          'white-space': 'nowrap',
        });
  empty.addClass('sigil-list-empty');

  const host = box({ ...props.props, 'flex-direction': 'column', focusable: true });
  // added rather than written into the props, so an app's own `class` is kept
  host.addClass('sigil-list');
  if (selection.multiple) {
    host.addClass('is-multiple');
  }
  host.append(scroll, empty);

  /** The viewport's height in cells, from the last layout, or zero before one. */
  const viewHeight = (): number => (viewport.content ?? viewport.box)?.height ?? 0;
  /** How many rows a page is: the view less one, so a row of context survives. */
  const page = (): number => Math.max(1, Math.floor(viewHeight() / step) - 1);
  /** A reveal asked for before there was a layout to measure it against. */
  let pending = false;

  function reveal(key?: K): boolean {
    const at = key === undefined ? selection.index() : selection.indexOf(key);
    if (at < 0) {
      return false;
    }
    const view = viewHeight();
    if (view <= 0) {
      // nothing has laid the list out, so there is no "in view" yet: the scroll
      // box's resize hook asks again once there is
      pending = true;
      return false;
    }
    pending = false;
    const offset = viewport.scroll ?? { x: 0, y: 0 };
    const top = at * step;
    const bottom = top + step;
    let y = offset.y;
    if (top < y) {
      y = top;
    } else if (bottom > y + view) {
      y = bottom - view;
    }
    y = Math.min(Math.max(0, y), Math.max(0, keys.length * step - view));
    if (y === offset.y) {
      return false;
    }
    viewport.scrollTo(offset.x, y);
    return true;
  }

  function activate(): boolean {
    const at = selection.index();
    if (props.onActivate === undefined || at < 0 || selection.isDisabled(at)) {
      return false;
    }
    props.onActivate(keys[at] as K, items[at] as T);
    return true;
  }

  /** The current row's key and position when the view last followed it. */
  let followed: { at: number; key: K | undefined } = { at: -1, key: undefined };

  /** Follows the cursor, and only the cursor: a row that did not move is not chased. */
  const follow = (): void => {
    const key = untrack(() => current.get());
    const at = selection.index();
    if (key === followed.key && at === followed.at) {
      return;
    }
    followed = { at, key };
    reveal();
  };

  // the items: re-keyed, the cursor settled on them, the window rebuilt
  createEffect(() => {
    const next = read();
    untrack(() => {
      const nextKeys = next.map((item) => keyOf(item));
      const disabled = props.disabled;
      selection.setRows(
        nextKeys,
        disabled ? (index: number) => disabled(next[index] as T) === true : undefined
      );
      items = next;
      keys = nextKeys;
      const none = next.length === 0;
      scroll.setProps({ display: none ? 'none' : 'flex' });
      empty.setProps({ display: none ? 'flex' : 'none' });
      // an offset past the end of a list that shrank is put back inside it
      const view = viewHeight();
      const offset = viewport.scroll ?? { x: 0, y: 0 };
      const max = Math.max(0, keys.length * step - view);
      if (view > 0 && offset.y > max) {
        viewport.scrollTo(offset.x, max);
      }
      control.resync();
      follow();
    });
  });

  // the cursor and the selection: restyle the rows on screen, and follow the cursor
  createEffect(() => {
    const now = current.get();
    const chosen = selected.get();
    untrack(() => {
      // a key an app wrote that is not a row it can be on is put back on one,
      // which writes `current` and runs this again with that
      if (selection.settle()) {
        return;
      }
      for (const [key, built] of live) {
        paint(key, built, now, chosen);
      }
      follow();
    });
  });

  host.onFocusChange = (_, now): void => {
    focused = now;
    const key = untrack(() => current.get());
    const built = key === undefined ? undefined : live.get(key);
    built?.row.toggleClass('sigil-focus', now);
  };

  /** What type-to-find has heard, and when the last of it arrived. */
  let typed = { at: 0, text: '' };

  const findNext = (character: string): boolean => {
    const now = Date.now();
    const text = now - typed.at <= FIND_MS ? typed.text + character : character;
    typed = { at: now, text };
    const from = Math.max(0, selection.index());
    const count = keys.length;
    const look = (prefix: string, start: number): number => {
      const want = prefix.toLowerCase();
      for (let n = 0; n < count; n++) {
        const i = (start + n) % count;
        if (
          !selection.isDisabled(i) &&
          labelOf(items[i] as T)
            .toLowerCase()
            .startsWith(want)
        ) {
          return i;
        }
      }
      return -1;
    };
    // one character starts after the cursor, so pressing it again steps through
    // the rows it begins; more extend the match from where the cursor is. A run
    // of one letter that matches nothing as a word steps through that letter,
    // which is what a file manager does with `sss`
    let at = text.length === 1 ? look(text, from + 1) : look(text, from);
    if (at < 0 && text.length > 1 && [...text].every((c) => c === text[0])) {
      at = look(text[0] as string, from + 1);
    }
    return at >= 0 && selection.moveTo(at);
  };

  host.onKey = (event: KeyEvent): void => {
    const k = event.key;
    // a paste is not a keystroke
    if (event.paste) {
      return;
    }
    if (k.ctrl && !k.meta && k.name === 'a') {
      if (selection.multiple && keys.length > 0) {
        selection.toggleAll();
        event.stop();
      }
      return;
    }
    if (k.ctrl || k.meta) {
      return;
    }
    // nothing to move over: the keys are not ours, and reach the pane around
    if (keys.length === 0) {
      return;
    }

    // Shift with a move is a range, which this list does not draw: left for
    // whatever is around it rather than read as the plain key
    if (k.shift && MOVES.has(k.name)) {
      return;
    }

    let by: number | 'first' | 'last' | undefined;
    switch (k.name) {
      case 'up': {
        by = -1;
        break;
      }
      case 'down': {
        by = 1;
        break;
      }
      case 'pageup': {
        by = -page();
        break;
      }
      case 'pagedown': {
        by = page();
        break;
      }
      case 'home': {
        by = 'first';
        break;
      }
      case 'end': {
        by = 'last';
        break;
      }
      case 'enter': {
        if (activate()) {
          event.stop();
        }
        return;
      }
      case 'space': {
        if (selection.multiple && selection.toggle()) {
          event.stop();
        }
        return;
      }
      default: {
        if (props.vim) {
          by = VIM.get(k.name);
        } else if (props.find && [...k.name].length === 1) {
          findNext(k.name);
          // claimed whether or not it found anything: a list that takes letters
          // takes them, or a miss would type into whatever is around it
          event.stop();
          return;
        }
      }
    }
    if (by === undefined) {
      return;
    }

    if (by === 'first') {
      selection.first();
    } else if (by === 'last') {
      selection.last();
    } else {
      selection.move(by);
    }
    // claimed even where the cursor did not move: Down on the last row is still
    // this list's key, which is the scroll box's rule for a box at its end
    event.stop();
  };

  MODELS.set(host, {
    control: {
      activate,
      refresh(): void {
        tokens = new Map();
        control.resync();
      },
      reveal: (key) => reveal(key as K | undefined),
      scroll: control,
      selection: selection as ListSelection<unknown>,
    },
    keys: {
      activate: props.onActivate !== undefined,
      find: props.find === true,
      multiple: selection.multiple,
      vim: props.vim === true,
    },
  });

  return host;
}

/**
 * The control of a list: its selection, its scroll box, and `reveal()`,
 * `refresh()` and `activate()`.
 *
 * @param host - What `ListView()` returned.
 * @returns The control, or `undefined` for an element no list built.
 */
export function listControl<K = unknown>(host: Element): ListControl<K> | undefined {
  return MODELS.get(host)?.control as ListControl<K> | undefined;
}

/**
 * Describes a list's keys to a router, for a key-help footer.
 *
 * Scoped to the list, which is the element whose focus makes the keys apply, and
 * only the keys that list claims: Enter where it has an `onActivate`, Space and
 * Ctrl-A where it is `multiple`, `j`/`k`/`g`/`G` where it is `vim`. Type-to-find
 * is not described, for the reason `describeTabs()` leaves out the digits.
 *
 * @param router - What to describe the keys to.
 * @param lists - Hosts that `ListView()` returned.
 * @returns Takes every description back off.
 */
export function describeListView(
  router: ListViewDescriber,
  ...lists: readonly Element[]
): () => void {
  const found = lists.map((host) => {
    const model = MODELS.get(host);
    if (model === undefined) {
      throw new TypeError(__`Expected an element that ListView() returned`);
    }
    return { keys: model.keys, scope: host };
  });

  const off: Array<() => void> = [];
  for (const { keys, scope } of found) {
    const say = (spec: string, description: string, priority = 0): void => {
      off.push(router.describe(spec, { description, priority, scope }));
    };
    say('up', __`move`, 1);
    say('down', __`move`, 1);
    if (keys.vim) {
      say('k', __`move`, 1);
      say('j', __`move`, 1);
    }
    say('pageup', __`page`);
    say('pagedown', __`page`);
    say('home', __`first`);
    say('end', __`last`);
    if (keys.multiple) {
      say('space', __`select`, 2);
      say('ctrl+a', __`select all`, 1);
    }
    if (keys.activate) {
      say('enter', __`open`, 2);
    }
  }

  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
