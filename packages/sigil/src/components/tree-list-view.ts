/**
 * A tree list view: a tree you browse in a full-screen app, as a list of the rows
 * that are open.
 *
 * The file sidebar of an editor, a JSON viewer, a Kubernetes resource tree. `tree()`
 * prints one and `selectTree()` asks for a node of one; this is the element between
 * them, which sits in a pane and stays there.
 *
 * ```js
 * import { directoryRoot } from '@ttylabs/sigil/components/tree';
 * import { TreeListView } from '@ttylabs/sigil/components/tree-list-view';
 *
 * const files = TreeListView({
 *   items: directoryRoot({ root: '.' }),
 *   onActivate: (path) => open(path),
 *   props: { height: 20 },
 * });
 * ```
 *
 * On screen a tree is a list of its visible rows, so this is a `ListView` whose
 * rows are the nodes whose ancestors are all open: the cursor, the selection, the
 * windowing, the mouse and every key a list has are the list's, and what the tree
 * adds is the walk that decides the rows, the guides in front of them, Right and
 * Left, and a branch whose children are read when it first opens. A node is
 * `selectTree()`'s -- a string, or `{ text, value, items, expanded }` -- so one value
 * is printed, asked for and browsed. `AGENTS.md` has the reasons under "A tree list
 * view".
 */

import { box, type Element, type ElementPropsWithout, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { DescribeOptions, KeyEvent, MouseEvent } from '../input/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { State, untrack } from '../signals/index.js';
import { errorMessage } from '../util/error-message.js';
import {
  describeListView,
  type ListControl,
  listControl,
  ListView,
  type ListViewDescriber,
} from './list-view.js';
import { unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import {
  type TreeChoice,
  type TreeChoiceItem,
  treeChoiceOf,
  type TreeChoiceParts,
  treeGlyphs,
  type TreeGuide,
} from './tree.js';

/** What a tree list view shows: a list drawn from the margin, or one root node. */
export type TreeListItems<T = string> = readonly TreeChoiceItem<T>[] | TreeChoice<T>;

/** Where a branch whose `items` is a function stands. */
export type TreeLoadStatus = 'idle' | 'loading' | 'loaded' | 'failed';

/** What a `row` function is told about the node it draws, beside the node itself. */
export interface TreeRowInfo {
  /** Whether it is a branch: it has `items`. */
  readonly branch: boolean;
  /** How deep it is: 0 for a node at the margin, and for the root. */
  readonly depth: number;
  /** Whether it is an open branch. */
  readonly expanded: boolean;
  /** Where its read stands, for a branch whose `items` is a function. */
  readonly status: TreeLoadStatus;
  /** Its text on one line, which is what is drawn without a `row`. */
  readonly text: string;
}

export interface TreeListViewProps<T = string> {
  /** Draw with ASCII only. Defaults to what `unicodeSupported()` says. */
  ascii?: boolean;
  /**
   * The current node, as its value, or the state that holds it -- the shape
   * `ListView`'s `current` has. Left out, the cursor starts on the first row.
   */
  current?: T | State<T | undefined>;
  /**
   * Whether a node is disabled: drawn muted, passed over by the cursor, not
   * activated and never ticked. A disabled branch's twisty still opens and closes
   * it, because disabled says the node cannot be picked, not that what is under it
   * cannot be seen.
   */
  disabled?: (node: TreeChoice<T>) => boolean;
  /** What to show when there are no nodes. Defaults to `ListView`'s "Nothing to show". */
  empty?: string | (() => Element);
  /**
   * The open branches, as a set of values, or the state that holds them.
   *
   * Values are where it starts and a `State` is the state itself: Right, Left,
   * Space and a click on the twisty write it, and an app that writes it opens and
   * closes branches. A node's own `expanded: true` adds its value the first time
   * the node is seen. Closing a branch leaves the branches under it in the set,
   * so they are open again when it is. Replaced on every write, never mutated.
   */
  expanded?: Iterable<T> | State<ReadonlySet<T>>;
  /** Type-to-find over the nodes' text, as `ListView`'s. Off by default. */
  find?: boolean;
  /** The lines between nodes, `plain` or `rounded`. Defaults to `plain`. */
  guide?: TreeGuide;
  /**
   * The tree: a list, drawn from the left margin, or one root node whose children
   * hang from it -- as `selectTree()` reads them. A `State` or a `Computed` of
   * either is followed.
   *
   * A node is a string, or `{ text, value, items, expanded }`. `value` identifies
   * it -- the cursor, the selection and the open set hold values -- and defaults to
   * `text`, so two nodes with one text want a `value` each; two nodes with one
   * value throw. `items` is a list, or a function called the first time the
   * branch opens, whose result, or promise of one, is kept.
   */
  items: TreeListItems<T> | { get(): TreeListItems<T> };
  /** Whether more than one node can be ticked, as `ListView`'s. Defaults to `false`. */
  multiple?: boolean;
  /** Called with the current node's value and the node on Enter or a double-click. */
  onActivate?: (value: T, node: TreeChoice<T>) => void;
  /** The host box's own props: a height, a border, a class. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey'>;
  /**
   * Draws a node's text: an element, or a string drawn as one line. The guide and
   * the twisty are drawn in front of it either way. Called when the row comes into
   * view and again when the node, its depth, or whether it is open changes.
   */
  row?: (node: TreeChoice<T>, info: TreeRowInfo) => Element | string;
  /** Whether to draw a scrollbar. Defaults to `true`. */
  scrollbar?: boolean;
  /** The ticked nodes, for a `multiple` tree, as `ListView`'s `selected`. */
  selected?: Iterable<T> | State<ReadonlySet<T>>;
  /** `ListView`'s `j`/`k`/`g`/`G`, and `h` and `l` for Left and Right. Off by default. */
  vim?: boolean;
}

/** What an app holds a tree list view by, from `treeListControl()`. */
export interface TreeListControl<T> {
  /**
   * Closes a branch, the current node by default.
   *
   * @returns Whether it was open.
   */
  collapse(value?: T): boolean;
  /** The current node's value: the state the cursor is. */
  readonly current: State<T | undefined>;
  /**
   * Opens a branch, the current node by default, reading it if its `items` is a
   * function that has not been read or whose read failed.
   *
   * @returns Whether it was closed.
   */
  expand(value?: T): boolean;
  /** The open branches' values. */
  readonly expanded: State<ReadonlySet<T>>;
  /**
   * The list the tree is drawn in, for its scroll box, `reveal()` and `refresh()`.
   * Its rows include the loading and error lines, whose keys are not values -- they
   * are disabled, so the cursor is never on one.
   */
  readonly list: ListControl<unknown>;
  /**
   * Forgets what a branch's function returned, so the branch reads again: at once
   * if it is open, and the next time it opens otherwise. A read in flight is
   * dropped when it lands.
   *
   * @returns Whether there was anything to forget.
   */
  reload(value: T): boolean;
  /** Where the read of a branch whose `items` is a function stands. */
  status(value: T): TreeLoadStatus;
  /**
   * Opens a branch that is closed and closes one that is open, the current node
   * by default.
   *
   * @returns Whether anything changed.
   */
  toggle(value?: T): boolean;
}

/** A node's row. */
interface NodeRow<T> {
  depth: number;
  guide: string;
  /** The item as it was handed over, which is what says the node was replaced. */
  item: TreeChoiceItem<T>;
  key: T;
  kind: 'node';
  message: string;
  open: boolean;
  parts: TreeChoiceParts<T>;
  status: TreeLoadStatus;
}

/** The line under an open branch whose read is in flight, or failed. */
interface NoteRow {
  guide: string;
  /** A key no value can be: an object made for this branch and kind. */
  key: object;
  kind: 'error' | 'loading';
  text: string;
}

type Row<T> = NodeRow<T> | NoteRow;

/** A read, as the tree keeps it. */
type Load<T> =
  | { readonly run: number; readonly state: 'loading' }
  | { readonly items: readonly TreeChoiceItem<T>[]; readonly state: 'loaded' }
  | { readonly message: string; readonly state: 'failed' };

/** A run of a row that is drawn at the width it has, never wrapped or squeezed. */
const FIXED = { 'flex-shrink': 0, 'white-space': 'nowrap' } as const;

interface Model {
  control: TreeListControl<unknown>;
  keys: { multiple: boolean; vim: boolean };
}

/** Each tree's control, keyed by the host `TreeListView()` returned. */
const MODELS = new WeakMap<Element, Model>();

/** Whether a function's answer is a promise, or anything else with a `then`. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** Whether two rows draw the same thing, so the one already built can be kept. */
function sameRow<T>(a: Row<T>, b: Row<T>): boolean {
  if (a.kind !== b.kind || a.guide !== b.guide) {
    return false;
  }
  if (a.kind === 'node' && b.kind === 'node') {
    return (
      a.item === b.item &&
      a.depth === b.depth &&
      a.open === b.open &&
      a.status === b.status &&
      a.message === b.message
    );
  }
  return (a as NoteRow).text === (b as NoteRow).text;
}

/**
 * Builds a tree list view.
 *
 * Up, Down, Page Up, Page Down, Home and End move the cursor, as in a list. **Right
 * opens** a closed branch, steps onto the first child of an open one, and reads a
 * branch whose read failed again; **Left closes** an open branch and on anything
 * else steps to the parent. Space opens and closes a branch in a single tree and
 * ticks a node in a `multiple` one. **Enter activates**, as does a double-click; a
 * click moves the cursor, and a click on a branch's twisty opens or closes it.
 *
 * A branch whose `items` is a function is read when it first opens, with a
 * `Loading…` line under it while a promise is in flight. A read that rejects puts
 * its message there instead, is not kept, and is read again by Right, by closing
 * and opening the branch, or by `reload()`. A branch closed while it is read
 * keeps the read going, and opens again on what it found.
 *
 * @param props - The tree, how a node is drawn, the open set, the selection, and
 *   the host's props.
 * @returns The host element, which is the one that takes the focus.
 */
export function TreeListView<T = string>(props: TreeListViewProps<T>): Element {
  refuseOwnedHooks('TreeListView', props.props, ['onFocusChange', 'onKey']);
  const source = props.items as unknown;
  const reads = typeof (source as { get?: unknown } | null)?.get === 'function';
  if (
    !Array.isArray(source) &&
    typeof (source as { text?: unknown } | null)?.text !== 'string' &&
    !reads
  ) {
    throw new TypeError(__`Expected tree items to be an array, a root node, a State or a Computed`);
  }
  for (const name of ['disabled', 'onActivate', 'row'] as const) {
    if (props[name] !== undefined && typeof props[name] !== 'function') {
      throw new TypeError(__`Expected tree ${name} to be a function`);
    }
  }
  if (props.expanded !== undefined && !(props.expanded instanceof State)) {
    if (typeof (props.expanded as Iterable<T>)[Symbol.iterator] !== 'function') {
      throw new TypeError(__`Expected tree expanded to be an iterable of values or a State`);
    }
  }

  const read = (): TreeListItems<T> =>
    reads ? (source as { get(): TreeListItems<T> }).get() : (source as TreeListItems<T>);
  const ascii = props.ascii ?? !unicodeSupported();
  const glyphs = treeGlyphs(props.guide, ascii);
  const loadingText = __`Loading` + (ascii ? '...' : '…');
  const expanded =
    props.expanded instanceof State
      ? props.expanded
      : new State<ReadonlySet<T>>(new Set(props.expanded ?? []));
  const current =
    props.current instanceof State ? props.current : new State<T | undefined>(props.current);

  /** The reads of branches whose `items` is a function, by value. */
  const loads = new Map<T, Load<T>>();
  /** Bumped when a read lands, which is what makes the rows be walked again. */
  const landed = new State(0);
  /** Each read's number, so one that a `reload()` superseded is dropped. */
  let runs = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  /** The values seen so far, so a node's own `expanded` is read once and not again. */
  const seen = new Set<T>();
  /** The keys of each branch's loading and error lines. */
  const notes = new Map<T, { error: object; loading: object }>();
  const noteKey = (value: T, kind: 'error' | 'loading'): object => {
    let held = notes.get(value);
    if (held === undefined) {
      held = { error: {}, loading: {} };
      notes.set(value, held);
    }
    return held[kind];
  };

  /** What the last walk found: the rows, each node's parent, and the open branches it showed. */
  let rows: readonly Row<T>[] = [];
  let byKey = new Map<unknown, Row<T>>();
  let parents = new Map<T, T | undefined>();
  let shown = new Set<T>();

  const accept = (value: T, items: unknown): void => {
    if (!Array.isArray(items)) {
      loads.set(value, { message: __`Expected items to be an array`, state: 'failed' });
      return;
    }
    try {
      for (const item of items as readonly TreeChoiceItem<T>[]) {
        treeChoiceOf(item);
      }
    } catch (err) {
      loads.set(value, { message: errorMessage(err), state: 'failed' });
      return;
    }
    loads.set(value, { items: items as readonly TreeChoiceItem<T>[], state: 'loaded' });
  };

  /**
   * Reads a branch. A function that returns a list is taken at once, so a tree of
   * synchronous children never draws a loading line; one that returns a promise is
   * `loading` until it lands, and lands only if nothing has superseded it since.
   */
  const start = (value: T, fn: () => unknown): void => {
    const run = ++runs;
    let result: unknown;
    try {
      result = fn();
    } catch (err) {
      loads.set(value, { message: errorMessage(err), state: 'failed' });
      return;
    }
    if (!isThenable(result)) {
      accept(value, result);
      return;
    }
    loads.set(value, { run, state: 'loading' });
    const land = (settle: () => void): void => {
      const now = loads.get(value);
      if (disposed || now?.state !== 'loading' || now.run !== run) {
        return;
      }
      settle();
      landed.set(untrack(() => landed.get()) + 1);
    };
    Promise.resolve(result).then(
      (items) => land(() => accept(value, items)),
      (err: unknown) =>
        land(() => loads.set(value, { message: errorMessage(err), state: 'failed' }))
    );
  };

  /**
   * The rows an open set shows, in order: every node whose ancestors are all open,
   * with a loading or an error line under an open branch that has no children yet.
   * Also collects the values of nodes seen for the first time with `expanded: true`.
   */
  const walk = (
    top: TreeListItems<T>,
    open: ReadonlySet<T>,
    seed: T[]
  ): { parents: Map<T, T | undefined>; rows: Row<T>[]; shown: Set<T> } => {
    const out: Row<T>[] = [];
    const up = new Map<T, T | undefined>();
    const opened = new Set<T>();

    const visit = (
      items: readonly TreeChoiceItem<T>[],
      depth: number,
      base: string,
      parent: T | undefined,
      root: boolean
    ): void => {
      for (const [index, item] of items.entries()) {
        const parts = treeChoiceOf(item);
        const key = parts.value;
        if (up.has(key)) {
          throw new TypeError(
            __`Expected every tree node to have a value of its own: ${String(key)} is used twice`
          );
        }
        up.set(key, parent);
        if (!seen.has(key)) {
          seen.add(key);
          if (parts.branch && parts.choice.expanded === true && !open.has(key)) {
            seed.push(key);
          }
        }

        const last = index === items.length - 1;
        const guide = root ? '' : base + (last ? glyphs.last : glyphs.branch);
        const rest = root ? '' : base + (last ? glyphs.after : glyphs.through);
        const isOpen = parts.branch && open.has(key);
        let status: TreeLoadStatus = 'idle';
        let children: readonly TreeChoiceItem<T>[] | undefined;
        let message = '';

        if (parts.branch) {
          const what = parts.choice.items;
          if (typeof what === 'function') {
            let held = loads.get(key);
            // a read that failed is not kept: a branch closed over one reads
            // again when it opens, whatever opened it
            if (!isOpen && held?.state === 'failed') {
              loads.delete(key);
              held = undefined;
            }
            if (isOpen && held === undefined) {
              start(key, what);
              held = loads.get(key);
            }
            if (held !== undefined) {
              status = held.state;
              if (held.state === 'loaded') {
                children = held.items;
              } else if (held.state === 'failed') {
                ({ message } = held);
              }
            }
          } else if (Array.isArray(what)) {
            children = what;
          } else {
            throw new TypeError(__`Expected items to be an array`);
          }
        }

        out.push({
          depth,
          guide,
          item,
          key,
          kind: 'node',
          message,
          open: isOpen,
          parts,
          status,
        });
        if (!isOpen) {
          continue;
        }
        if (children !== undefined) {
          opened.add(key);
          visit(children, depth + 1, rest, key, false);
        } else if (status === 'loading' || status === 'failed') {
          const kind = status === 'loading' ? 'loading' : 'error';
          out.push({
            guide: rest + glyphs.last,
            key: noteKey(key, kind),
            kind,
            text: kind === 'loading' ? loadingText : __`Could not load: ${message}`,
          });
        }
      }
    };

    if (Array.isArray(top)) {
      visit(top, 0, '', undefined, false);
    } else {
      visit([top as TreeChoice<T>], 0, '', undefined, true);
    }
    return { parents: up, rows: out, shown: opened };
  };

  /** The rows the list is handed, which it follows. */
  const listed = new State<readonly Row<T>[]>([]);

  /**
   * Puts the cursor on the branch that hid it. A node the cursor was on that is no
   * longer shown, under an ancestor that is shown but no longer shows its
   * children, was closed over rather than deleted -- and the row that took its
   * place, which is where a list puts a cursor whose row went, is a stranger's.
   * So it goes to that ancestor. A node deleted from a branch still open is left
   * to the list's rule.
   */
  const lift = (next: { parents: Map<T, T | undefined>; shown: Set<T> }): void => {
    const at = untrack(() => current.get());
    if (at === undefined || !parents.has(at) || next.parents.has(at)) {
      return;
    }
    for (let up = parents.get(at); up !== undefined; up = parents.get(up)) {
      if (next.parents.has(up)) {
        if (!next.shown.has(up)) {
          current.set(up);
        }
        return;
      }
    }
  };

  createEffect(() => {
    const top = read();
    let open = expanded.get();
    landed.get();
    untrack(() => {
      const first = open;
      // a node seen for the first time with `expanded: true` opens, and what is
      // under it is walked at once rather than a frame later
      let seed: T[] = [];
      let found = walk(top, open, seed);
      while (seed.length > 0) {
        open = new Set([...open, ...seed]);
        seed = [];
        found = walk(top, open, seed);
      }
      if (open !== first) {
        expanded.set(open);
      }
      lift(found);
      // a row that draws what it drew last time is the same object, so the list
      // keeps the element it built for it
      const next = found.rows.map((row) => {
        const was = byKey.get(row.key);
        return was !== undefined && sameRow(was, row) ? was : row;
      });
      const unchanged = next.length === rows.length && next.every((row, i) => row === rows[i]);
      rows = next;
      byKey = new Map(next.map((row) => [row.key, row]));
      parents = found.parents;
      shown = found.shown;
      if (!unchanged) {
        listed.set(next);
      }
    });
  });

  const nodeAt = (value: T | undefined): NodeRow<T> | undefined => {
    const row = value === undefined ? undefined : byKey.get(value);
    return row?.kind === 'node' ? row : undefined;
  };
  const here = (): T | undefined => untrack(() => current.get());

  const setOpen = (value: T, on: boolean): boolean => {
    const now = untrack(() => expanded.get());
    if (now.has(value) === on) {
      return false;
    }
    if (on && loads.get(value)?.state === 'failed') {
      loads.delete(value);
    }
    const next = new Set(now);
    if (on) {
      next.add(value);
    } else {
      next.delete(value);
    }
    expanded.set(next);
    return true;
  };
  const expand = (value = here()): boolean => value !== undefined && setOpen(value, true);
  const collapse = (value = here()): boolean => value !== undefined && setOpen(value, false);
  const toggle = (value = here()): boolean =>
    value !== undefined && setOpen(value, !untrack(() => expanded.get()).has(value));
  const reload = (value: T): boolean => {
    if (!loads.delete(value)) {
      return false;
    }
    landed.set(untrack(() => landed.get()) + 1);
    return true;
  };

  const drawRow = (row: Row<T>): Element => {
    const guide = row.guide
      ? [textNode(row.guide, { ...FIXED, class: 'sigil-tree-guide sigil-muted' })]
      : [];
    if (row.kind !== 'node') {
      return box(
        { class: 'sigil-tree-node', 'flex-direction': 'row' },
        ...guide,
        // in the twisty's place, so the line reads as being under the branch
        textNode(glyphs.leaf, { ...FIXED, class: 'sigil-tree-toggle' }),
        textNode(row.text, {
          class:
            row.kind === 'loading'
              ? 'sigil-tree-loading sigil-muted'
              : 'sigil-tree-error sigil-error',
          'white-space': 'nowrap',
        })
      );
    }
    const { parts } = row;
    const twisty = textNode(parts.branch ? (row.open ? glyphs.open : glyphs.closed) : glyphs.leaf, {
      ...FIXED,
      class: 'sigil-tree-toggle sigil-muted',
    });
    if (parts.branch) {
      // the twisty is a button of its own: it opens and closes, and stops the
      // click, so the list neither moves the cursor nor counts it toward a
      // double-click
      twisty.onMouse = (event: MouseEvent): void => {
        if (event.kind !== 'click' || event.button !== 'left') {
          return;
        }
        event.stop();
        toggle(row.key);
      };
    }
    const drawn = props.row
      ? props.row(parts.choice, {
          branch: parts.branch,
          depth: row.depth,
          expanded: row.open,
          status: row.status,
          text: parts.text,
        })
      : parts.text;
    const label =
      typeof drawn === 'string'
        ? textNode(drawn, { class: 'sigil-tree-label', 'white-space': 'nowrap' })
        : drawn;
    const node = box(
      { class: 'sigil-tree-node', 'flex-direction': 'row' },
      ...guide,
      twisty,
      label
    );
    if (parts.branch) {
      node.addClass('is-branch');
    }
    if (row.open) {
      node.addClass('is-open');
    }
    return node;
  };

  const { disabled, onActivate } = props;
  const host = ListView<Row<T>, unknown>({
    ascii,
    current: current as State<unknown>,
    disabled: (row) => row.kind !== 'node' || disabled?.(row.parts.choice) === true,
    empty: props.empty,
    find: props.find,
    items: listed,
    key: (row) => row.key,
    label: (row) => (row.kind === 'node' ? row.parts.text : ''),
    multiple: props.multiple,
    onActivate: onActivate
      ? (_, row): void => {
          if (row.kind === 'node') {
            onActivate(row.key, row.parts.choice);
          }
        }
      : undefined,
    props: props.props,
    row: drawRow,
    scrollbar: props.scrollbar,
    selected: props.selected as Iterable<unknown> | State<ReadonlySet<unknown>> | undefined,
    vim: props.vim,
  });
  host.addClass('sigil-tree-list-view');
  const list = listControl(host) as ListControl<unknown>;
  const multiple = list.selection.multiple;

  /** Right, Left and Space: whatever the list left alone, about the current node. */
  const treeKey = (event: KeyEvent): void => {
    const k = event.key;
    if (event.paste || k.ctrl || k.meta || k.shift) {
      return;
    }
    const name =
      props.vim && k.name === 'h' ? 'left' : props.vim && k.name === 'l' ? 'right' : k.name;
    const at = here();
    const row = nodeAt(at);
    if (at === undefined || row === undefined) {
      return;
    }
    switch (name) {
      case 'right': {
        if (!row.parts.branch) {
          return;
        }
        if (!row.open) {
          expand(at);
        } else if (row.status === 'failed') {
          reload(at);
        } else if (shown.has(at)) {
          const child = rows[rows.indexOf(row) + 1];
          if (child?.kind !== 'node' || parents.get(child.key) !== at) {
            // open and empty: nothing for Right to do, so it goes on
            return;
          }
          current.set(child.key);
        }
        // claimed while the read is in flight too: the key is about this branch
        event.stop();
        return;
      }
      case 'left': {
        if (row.open) {
          collapse(at);
          event.stop();
          return;
        }
        const parent = parents.get(at);
        if (parent !== undefined) {
          current.set(parent);
          event.stop();
        }
        return;
      }
      case 'space': {
        if (!multiple && row.parts.branch) {
          toggle(at);
          event.stop();
        }
        return;
      }
      default:
    }
  };

  // composed rather than replaced: the list's keys first, and the tree's for what
  // the list did not claim -- the documented way to put a hook over one already
  // there, and what keeps the host the list's, so `listControl()` and the focus
  // role answer for it unchanged
  const listKey = host.onKey;
  host.onKey = (event: KeyEvent): void => {
    listKey?.(event);
    if (!event.stopped) {
      treeKey(event);
    }
  };

  const control: TreeListControl<T> = {
    collapse,
    current,
    expand,
    expanded,
    list,
    reload,
    status: (value) => loads.get(value)?.state ?? 'idle',
    toggle,
  };
  MODELS.set(host, {
    control: control as TreeListControl<unknown>,
    keys: { multiple, vim: props.vim === true },
  });
  return host;
}

/**
 * The control of a tree list view: its open set, its cursor, and the moves.
 *
 * @param host - What `TreeListView()` returned.
 * @returns The control, or `undefined` for an element no tree built.
 */
export function treeListControl<T = string>(host: Element): TreeListControl<T> | undefined {
  return MODELS.get(host)?.control as TreeListControl<T> | undefined;
}

/**
 * Describes a tree's keys to a router, for a key-help footer: the list's, which
 * `describeListView()` says, and Right, Left and -- in a single tree -- Space, scoped
 * to the tree.
 *
 * @param router - What to describe the keys to.
 * @param trees - Hosts that `TreeListView()` returned.
 * @returns Takes every description back off.
 */
export function describeTreeListView(
  router: ListViewDescriber,
  ...trees: readonly Element[]
): () => void {
  const found = trees.map((host) => {
    const model = MODELS.get(host);
    if (model === undefined) {
      throw new TypeError(__`Expected an element that TreeListView() returned`);
    }
    return { keys: model.keys, scope: host };
  });

  const off: Array<() => void> = [];
  for (const { keys, scope } of found) {
    off.push(describeListView(router, scope));
    const say = (spec: string, description: string, priority: number): void => {
      const opts: DescribeOptions = { description, priority, scope };
      off.push(router.describe(spec, opts));
    };
    say('right', __`expand`, 1);
    say('left', __`collapse`, 1);
    if (keys.vim) {
      say('l', __`expand`, 1);
      say('h', __`collapse`, 1);
    }
    if (!keys.multiple) {
      say('space', __`toggle`, 2);
    }
  }

  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
