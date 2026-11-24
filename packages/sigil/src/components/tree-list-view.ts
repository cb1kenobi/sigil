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
import { Computed, State, untrack } from '../signals/index.js';
import { errorMessage } from '../util/error-message.js';
import { controlState, type Written } from './control.js';
import { type DescribeListViewOptions, describedHosts } from './key-help.js';
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
  TREE_FIXED,
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
  /**
   * Where its read stands, for a branch whose `items` is a function. `loading` with
   * the branch's children shown is a read again, after a `reload()`, over what the
   * last one found.
   */
  readonly status: TreeLoadStatus;
  /** Its text on one line, which is what is drawn without a `row`. */
  readonly text: string;
}

export interface TreeListViewProps<T = string> {
  /** Draw with ASCII only. Defaults to what `unicodeSupported()` says. */
  ascii?: boolean;
  /**
   * The current node, as its value, or the state that holds it -- the shape
   * `ListView`'s `current` has, a `Computed` refused. Left out, the cursor starts
   * on the first row.
   */
  current?: Written<T> | State<T | undefined>;
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
   * the node is seen, and again if it leaves the tree and comes back. Closing a
   * branch leaves the branches under it in the set, so they are open again when
   * it is. Replaced on every write, never mutated.
   */
  expanded?: Iterable<T> | State<ReadonlySet<T>>;
  /** Type-to-find over the nodes' text, as `ListView`'s. Off by default. */
  find?: boolean;
  /** The lines between nodes, `plain` or `rounded`. Defaults to `plain`. */
  guide?: TreeGuide;
  /**
   * The tree: a list, drawn from the left margin, or one root node whose children
   * hang from it -- as `selectTree()` reads them. A `State` or a `Computed` of
   * either is followed, as is any object with a `get()`. That `get()` is read inside
   * a `Computed`, so it may not write a signal while it is read -- a source that
   * marks itself loading on its first read does it before, or from an effect -- and
   * is read again when a signal it read changes, not on every key.
   *
   * A node is a string, or `{ text, value, items, expanded }`. `value` identifies
   * it -- the cursor, the selection and the open set hold values -- and defaults to
   * `text`, so two nodes with one text want a `value` each; two nodes with one
   * value throw. `items` is a list, or a function called the first time the
   * branch opens, whose result, or promise of one, is kept until
   * `treeListControl(tree).reload()` says it is out of date or the node leaves
   * the tree.
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
  /**
   * Follow the last row as rows are added, as `tail -f` does: `ListView`'s `tail`,
   * passed to the list the tree is drawn in. The last row is the last one shown,
   * which is the deepest last child of the last open branch -- never a loading or
   * an error line, which the cursor is never on.
   */
  tail?: boolean | State<boolean>;
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
   * Says what a branch's function returned is out of date, so the branch reads
   * again: at once if it is open, and the next time it opens otherwise. What it
   * showed stays on screen until the new read lands, so the cursor, the open
   * branches and the scroll stay where they are; a read in flight is dropped when
   * it lands. With `subtree`, every branch under it that has been read too, at any
   * depth, whether or not it is open.
   *
   * @returns Whether there was anything to forget.
   */
  reload(value: T, options?: { subtree?: boolean }): boolean;
  /**
   * `reload()` for every branch that has been read: what an app calls when the
   * data behind the whole tree changed.
   *
   * @returns Whether there was anything to forget.
   */
  reloadAll(): boolean;
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

/** A node's line, as a walk finds it. */
interface NodeLine<T> {
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
interface NoteLine {
  guide: string;
  /** A key no value can be: an object made for this branch and kind. */
  key: object;
  kind: 'error' | 'loading';
  text: string;
}

type Line<T> = NodeLine<T> | NoteLine;

/**
 * A line as the list holds it. Its guide is a state the drawn row follows, so a
 * row whose guide alone moved -- the last sibling gaining one after it, and every
 * row under it -- is the same object, and the list neither rebuilds it nor keys
 * every row again (SIG-471). `bare` is whether it has a guide at all.
 */
type Held<L extends { guide: string }> = Omit<L, 'guide'> & {
  readonly bare: boolean;
  readonly guide: State<string>;
};

/** A node's row. */
type NodeRow<T> = Held<NodeLine<T>>;

type Row<T> = NodeRow<T> | Held<NoteLine>;

/**
 * A read, as the tree keeps it. A `stale` one is out of date and is read again
 * when its branch is open; a read again carries the `items` the last one found, to
 * show until it lands.
 */
type Load<T> =
  | {
      readonly items?: readonly TreeChoiceItem<T>[];
      readonly run: number;
      readonly state: 'loading';
    }
  | {
      readonly items: readonly TreeChoiceItem<T>[];
      readonly stale?: boolean;
      readonly state: 'loaded';
    }
  | {
      /**
       * The answer a read again that failed replaced: never shown, but what is
       * under it is still the tree's, so a retry that lands finds it as it was.
       */
      readonly last?: readonly TreeChoiceItem<T>[];
      readonly message: string;
      readonly state: 'failed';
    };

/** What a read holds of the tree: what it found, or what a failure replaced. */
function answerOf<T>(load: Load<T> | undefined): readonly TreeChoiceItem<T>[] | undefined {
  return load === undefined ? undefined : load.state === 'failed' ? load.last : load.items;
}

interface Model {
  control: TreeListControl<unknown>;
  held: () => TreeListHeld;
  keys: { multiple: boolean; vim: boolean };
}

/** How many values a tree list view holds something for: see {@link treeListHeld}. */
export interface TreeListHeld {
  /** Branches whose failed read's answer is held, with no read to hold it (SIG-521). */
  readonly kept: number;
  /** Branches with a loading or an error line made for them. */
  readonly notes: number;
  /** Rows the tree finds a value's row by: the rows it shows, and no others (SIG-520). */
  readonly rows: number;
  /** Branches whose function has been read, or is being read. */
  readonly reads: number;
  /** Values the tree has met. */
  readonly seen: number;
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

/**
 * Whether a line draws what a row already built draws, but for its guide, so the
 * row can be kept and handed the guide.
 */
function sameRow<T>(a: Row<T>, b: Line<T>): boolean {
  if (a.kind !== b.kind || a.bare !== (b.guide === '')) {
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
  return (a as Held<NoteLine>).text === (b as NoteLine).text;
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
 * keeps the read going, and opens again on what it found. What a read found is
 * kept until `reload()` or `reloadAll()` says it is out of date, and shown until
 * the read that replaces it lands; a node that leaves the tree takes its read
 * with it, so one that comes back is read again.
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
    throw new TypeError(`Expected tree items to be an array, a root node, a State or a Computed`);
  }
  for (const name of ['disabled', 'onActivate', 'row'] as const) {
    if (props[name] !== undefined && typeof props[name] !== 'function') {
      throw new TypeError(`Expected tree ${name} to be a function`);
    }
  }
  if (props.expanded !== undefined && !(props.expanded instanceof State)) {
    if (typeof (props.expanded as Iterable<T>)[Symbol.iterator] !== 'function') {
      throw new TypeError(`Expected tree expanded to be an iterable of values or a State`);
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
  const current = controlState<T | undefined>(
    props.current,
    `Expected tree current to be a value or a State, not a Computed, since the tree writes it`
  );

  /** The reads of branches whose `items` is a function, by value. */
  const loads = new Map<T, Load<T>>();
  /**
   * The answer a failed read replaced, for a branch whose failure is gone -- retried,
   * or closed over -- and whose new read has not landed (SIG-521). It is never shown,
   * and what is under it is still the tree's: a search in that window finds it here,
   * so a value under it is not new when the read lands. A failed read holds it as
   * its `last`, a read that lands drops it, and a value that leaves the tree takes it.
   */
  const kept = new Map<T, readonly TreeChoiceItem<T>[]>();
  /**
   * Whether a read's answer was replaced or dropped since the last walk that looked
   * for values gone from the tree: the nodes it held may have gone with it.
   */
  let left = false;
  /**
   * Keeps a read, noting when the answer it replaces is a different one. A failure
   * keeps the answer it replaced as `last`, so it is not one: a transient error is
   * not the tree losing the branches under it.
   */
  const put = (value: T, load: Load<T>): void => {
    const had = answerOf(loads.get(value)) ?? kept.get(value);
    // a read begun with nothing to show holds no answer yet, which is not one replaced
    const next = load.state === 'loading' && load.items === undefined ? had : answerOf(load);
    left ||= had !== undefined && next !== had;
    loads.set(value, load);
  };
  /**
   * Forgets a read that failed so the branch reads again, keeping the answer it
   * replaced: that is still the tree's, though nothing shows it (SIG-521).
   */
  const unfail = (value: T, held: Extract<Load<T>, { state: 'failed' }>): void => {
    loads.delete(value);
    if (held.last !== undefined) {
      kept.set(value, held.last);
    }
  };
  /** Bumped when a read lands, which is what makes the rows be walked again. */
  const landed = new State(0);
  /** Each read's number, so one that a `reload()` superseded is dropped. */
  let runs = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  /**
   * The values seen in the tree, so a node's own `expanded` is read once and not
   * again, and whether a walk has gone under each -- which is what says a closed
   * branch may have something below it to keep. A value that leaves the tree is
   * dropped from here, from `loads` and from `notes` (SIG-487).
   */
  const seen = new Map<T, boolean>();
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

  /**
   * Marks one read out of date. What it found is kept to be shown until the read
   * that replaces it lands, and a read in flight is superseded either way: one that
   * carries an earlier answer goes back to it, and one that has none, or a failure,
   * is forgotten.
   */
  const forget = (value: T): boolean => {
    const held = loads.get(value);
    if (held === undefined || (held.state === 'loaded' && held.stale === true)) {
      return false;
    }
    if (held.state === 'failed') {
      unfail(value, held);
    } else if (held.items !== undefined) {
      put(value, { items: held.items, stale: true, state: 'loaded' });
    } else {
      loads.delete(value);
    }
    return true;
  };

  /**
   * The branches that have a read among some nodes and under them: through the
   * lists the nodes hold and through what each read found, so a branch that is
   * closed is reached as surely as one that is open. With `from`, only that value's
   * and those under it.
   */
  const readsIn = (items: readonly TreeChoiceItem<T>[], from?: { value: T }): T[] => {
    const found: T[] = [];
    const been = new Set<T>();
    const visit = (list: readonly TreeChoiceItem<T>[], inside: boolean): void => {
      for (const item of list) {
        const parts = treeChoiceOf(item);
        const key = parts.value;
        // a read that hands back an ancestor's value would otherwise go round
        if (!parts.branch || been.has(key)) {
          continue;
        }
        been.add(key);
        const within = inside || key === from?.value;
        const what = parts.choice.items;
        let children: readonly TreeChoiceItem<T>[] | undefined;
        if (typeof what === 'function') {
          const held = loads.get(key);
          if (held === undefined) {
            continue;
          }
          if (within) {
            found.push(key);
          }
          children = held.state === 'failed' ? undefined : held.items;
        } else if (Array.isArray(what)) {
          children = what;
        }
        if (children !== undefined) {
          visit(children, within);
        }
      }
    };
    visit(items, from === undefined);
    return found;
  };

  /**
   * A read that failed. One that was a read again takes every read under the
   * answer it replaced out of date with it: what they hung from is no longer known,
   * and with the items gone a subtree reload could no longer find them.
   */
  const fail = (value: T, message: string, before?: readonly TreeChoiceItem<T>[]): void => {
    // a read again over a failure has no answer of its own to replace: it replaces
    // the one the failure kept
    const replaced = before ?? kept.get(value);
    kept.delete(value);
    put(value, { last: replaced, message, state: 'failed' });
    if (before === undefined) {
      return;
    }
    let marked = false;
    for (const key of readsIn(before)) {
      if (key !== value) {
        marked = forget(key) || marked;
      }
    }
    // a failure met during a walk can mark a branch that walk has already drawn,
    // when an old answer repeats a value: so it is walked again
    if (marked) {
      landed.set(untrack(() => landed.get()) + 1);
    }
  };

  const accept = (value: T, items: unknown, before?: readonly TreeChoiceItem<T>[]): void => {
    if (!Array.isArray(items)) {
      fail(value, `Expected items to be an array`, before);
      return;
    }
    try {
      for (const item of items as readonly TreeChoiceItem<T>[]) {
        treeChoiceOf(item);
      }
    } catch (err) {
      fail(value, errorMessage(err), before);
      return;
    }
    put(value, { items: items as readonly TreeChoiceItem<T>[], state: 'loaded' });
    kept.delete(value);
  };

  /**
   * Reads a branch. A function that returns a list is taken at once, so a tree of
   * synchronous children never draws a loading line; one that returns a promise is
   * `loading` until it lands, and lands only if nothing has superseded it since.
   */
  const start = (value: T, fn: () => unknown, before?: readonly TreeChoiceItem<T>[]): void => {
    const run = ++runs;
    let result: unknown;
    try {
      result = fn();
    } catch (err) {
      fail(value, errorMessage(err), before);
      return;
    }
    if (!isThenable(result)) {
      accept(value, result, before);
      return;
    }
    put(value, { items: before, run, state: 'loading' });
    const land = (settle: () => void): void => {
      const now = loads.get(value);
      if (disposed || now?.state !== 'loading' || now.run !== run) {
        return;
      }
      settle();
      landed.set(untrack(() => landed.get()) + 1);
    };
    Promise.resolve(result).then(
      (items) => land(() => accept(value, items, before)),
      (err: unknown) => land(() => fail(value, errorMessage(err), before))
    );
  };

  /**
   * The rows an open set shows, in order: every node whose ancestors are all open,
   * with a loading or an error line under an open branch that has no children yet.
   * Also collects the values of nodes seen for the first time with `expanded: true`.
   *
   * With `prune`, it also goes under each closed branch a walk has been under
   * before, through the values seen there, to find what is still in the tree but
   * not shown: those are `reached`, and with what is shown they are every value
   * worth keeping anything for.
   */
  const walk = (
    top: TreeListItems<T>,
    open: ReadonlySet<T>,
    seed: T[],
    prune: boolean
  ): {
    parents: Map<T, T | undefined>;
    reached: Set<T>;
    rows: Line<T>[];
    shown: Set<T>;
  } => {
    const out: Line<T>[] = [];
    const up = new Map<T, T | undefined>();
    const opened = new Set<T>();
    const reached = new Set<T>();

    /** What a read found, or a list: the children a branch holds, shown or not. */
    const childrenOf = (parts: TreeChoiceParts<T>): readonly TreeChoiceItem<T>[] | undefined => {
      const what = parts.choice.items;
      if (Array.isArray(what)) {
        return what;
      }
      return answerOf(loads.get(parts.value)) ?? kept.get(parts.value);
    };

    /**
     * Under a closed branch: only the values seen before, since nothing is kept for
     * one never seen, and only under the ones a walk went under. Nothing here is
     * checked or drawn, so a node it cannot read is passed over rather than thrown
     * at -- a closed branch is read properly when it opens.
     */
    const beneath = (items: readonly TreeChoiceItem<T>[]): void => {
      for (const item of items) {
        let parts: TreeChoiceParts<T>;
        try {
          parts = treeChoiceOf(item);
        } catch {
          continue;
        }
        const key = parts.value;
        const under = seen.get(key);
        // a read that hands back an ancestor's value would otherwise go round
        if (under === undefined || up.has(key) || reached.has(key)) {
          continue;
        }
        reached.add(key);
        const children = under && parts.branch ? childrenOf(parts) : undefined;
        if (children !== undefined) {
          beneath(children);
        }
      }
    };

    const visit = (
      items: readonly TreeChoiceItem<T>[],
      depth: number,
      base: string,
      parent: T | undefined,
      root: boolean,
      waiting: boolean
    ): void => {
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const parts = treeChoiceOf(item);
        const key = parts.value;
        // one lookup, not two: a key already there leaves the size where it was
        const size = up.size;
        up.set(key, parent);
        if (up.size === size) {
          throw new TypeError(
            `Expected every tree node to have a value of its own: ${String(key)} is used twice`
          );
        }
        // reached under a closed branch and shown as well: counted once
        if (reached.size > 0) {
          reached.delete(key);
        }
        // an answer kept for a value that is no longer a function branch is no one's
        if (kept.size > 0 && !(parts.branch && typeof parts.choice.items === 'function')) {
          kept.delete(key);
        }
        const under = seen.get(key);
        if (under === undefined) {
          seen.set(key, false);
          if (parts.branch && parts.choice.expanded === true && !open.has(key)) {
            seed.push(key);
          }
        }

        const last = index === items.length - 1;
        const guide = root ? '' : base + (last ? glyphs.last : glyphs.branch);
        const isOpen = parts.branch && open.has(key);
        let status: TreeLoadStatus = 'idle';
        let children: readonly TreeChoiceItem<T>[] | undefined;
        /** The answer a failure replaced, which is not shown but is still the tree's. */
        let hidden: readonly TreeChoiceItem<T>[] | undefined;
        let message = '';

        if (parts.branch) {
          const what = parts.choice.items;
          if (typeof what === 'function') {
            let held = loads.get(key);
            // a read that failed is not kept: a branch closed over one reads
            // again when it opens, whatever opened it
            if (!isOpen && held?.state === 'failed') {
              unfail(key, held);
              held = undefined;
            }
            // read for the first time, or again over what the last read found --
            // unless a branch above is being read again: its answer may hand over a
            // new node here, whose function is the one to call, so this waits
            if (isOpen && (held === undefined || (held.state === 'loaded' && held.stale))) {
              if (!waiting) {
                start(key, what, held?.items);
                held = loads.get(key);
              } else if (held === undefined) {
                status = 'loading';
              }
            }
            if (held !== undefined) {
              status = held.state;
              if (held.state === 'failed') {
                ({ last: hidden, message } = held);
              } else {
                children = held.items;
              }
            }
            // a read begun over a failure, or a branch closed over one, shows nothing
            // and still has what the failure replaced under it
            hidden ??= kept.get(key);
          } else if (Array.isArray(what)) {
            children = what;
          } else {
            throw new TypeError(`Expected items to be an array`);
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
          const below = children ?? hidden;
          if (prune && under === true && below !== undefined) {
            beneath(below);
          }
          continue;
        }
        const rest = root ? '' : base + (last ? glyphs.after : glyphs.through);
        if (prune && under === true && hidden !== undefined) {
          beneath(hidden);
        }
        if (children !== undefined) {
          if (under !== true) {
            seen.set(key, true);
          }
          opened.add(key);
          // what a read again in flight shows is the last answer, and what is
          // under it waits for the new one
          visit(children, depth + 1, rest, key, false, waiting || status === 'loading');
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
      visit(top, 0, '', undefined, false, false);
    } else {
      visit([top as TreeChoice<T>], 0, '', undefined, true, false);
    }
    return { parents: up, reached, rows: out, shown: opened };
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

  /**
   * One reading of the tree: a new object each time the source is read again, which
   * is each time something it reads changed -- and never otherwise, since a
   * `Computed` keeps its value until then.
   *
   * So it answers the question the walk could not ask of the tree itself. A source
   * that changed its tree in place and woke the walk hands over the same tree in a
   * new reading, which the walk takes for a tree that may have lost values. And a
   * source that builds a new array each time it is read -- a `filter()` in a
   * `get()` -- hands over the same reading until what it filters changes, so the
   * list asking for the rows on every key costs nothing (SIG-469).
   */
  const reading = new Computed(() => {
    try {
      return { top: read() };
    } catch (err) {
      // the graph's own refusal, which names a Computed the app never wrote: said
      // again as the rule a source has to keep, with what to do instead
      if (err instanceof Error && err.message === 'A Computed may not write to a signal') {
        throw new TypeError(
          __`A TreeListView reads items.get() inside a Computed, so a source may not write a signal while it is read: write it before, or from an effect`,
          { cause: err }
        );
      }
      throw err;
    }
  });
  // a source holds every sink that read it until the sink lets go, so a tree that
  // did not would stay reachable from a long-lived State of items for as long as the
  // State lived. A release rather than a destruction: reading it again links it
  // again, which is why a walk asked for after this is refused
  onCleanup(() => reading.dispose());

  /**
   * What the last walk read: the reading, the open set and the count of reads
   * landed. A walk with a new reading may have lost values.
   */
  let walked: { landed: number; open: ReadonlySet<T>; reading: { top: unknown } } | undefined;
  /**
   * Whether a walk is running. A lazy branch's read, a `row` or an effect run by one
   * of the walk's own writes can ask for the rows again from inside it -- through the
   * list's control -- and gets them as the last walk left them rather than a second
   * walk inside the first.
   */
  let walking = false;

  /**
   * Forgets what is held for values the tree no longer has: neither shown nor
   * under a closed branch. A value that comes back is new again -- a branch reads
   * again, and its own `expanded` is read again.
   */
  const dropGone = (found: { parents: Map<T, unknown>; reached: Set<T> }): void => {
    // everything held is for a value in `seen`, and every value the walk met is
    // there: so where it met as many as `seen` holds, none went, and a tree that
    // only grew costs nothing to look through
    if (found.parents.size + found.reached.size === seen.size) {
      return;
    }
    const gone = (value: T): boolean => !found.parents.has(value) && !found.reached.has(value);
    for (const held of [seen, loads, notes, kept]) {
      for (const value of held.keys()) {
        if (gone(value)) {
          held.delete(value);
        }
      }
    }
  };

  /**
   * Walks the rows the list is handed, where what they are walked from moved since
   * the last walk: a new reading of the tree, the open set, a landed read, or a read
   * whose answer left. The effect below asks whenever one of those moves, and the
   * list asks whenever it takes its items -- which a key and a call on its control
   * do before the frame that runs the effect, so that a Right and a Down in one read
   * move over the rows the Right opened (SIG-469). Whichever asks first walks, and
   * the other finds nothing left to do.
   */
  const walkNow = (): void => {
    if (walking || disposed) {
      return;
    }
    const now = reading.get();
    const open = expanded.get();
    const count = landed.get();
    if (
      !left &&
      walked !== undefined &&
      walked.reading === now &&
      walked.open === open &&
      walked.landed === count
    ) {
      return;
    }
    walking = true;
    try {
      walkFrom(now, open, count);
    } finally {
      walking = false;
    }
  };

  /** The walk itself, and what it writes: see {@link walkNow}. */
  const walkFrom = (now: { top: TreeListItems<T> }, first: ReadonlySet<T>, count: number): void => {
    const { top } = now;
    let open = first;
    // only a tree that changed -- a new reading of it, which a change in place is
    // too -- or a read's answer replaced, can take a value out of it, so only then is
    // it looked for: opening and closing leave it as it was
    let pruning = left || walked === undefined || now !== walked.reading;
    left = false;
    // a node seen for the first time with `expanded: true` opens, and what is
    // under it is walked at once rather than a frame later; a read the walk
    // started that replaced an answer walks again, looking for what it took
    let seed: T[] = [];
    let found = walk(top, open, seed, pruning);
    while (seed.length > 0 || left) {
      if (left) {
        pruning = true;
        left = false;
      }
      if (seed.length > 0) {
        open = new Set([...open, ...seed]);
      }
      seed = [];
      found = walk(top, open, seed, pruning);
    }
    if (open !== first) {
      expanded.set(open);
    }
    if (pruning) {
      dropGone(found);
    }
    lift(found);
    // a row that draws what it drew last time is the same object, so the list
    // keeps the element it built for it and finds the rows it already keyed; one
    // whose guide alone moved is handed the guide
    const lines = found.rows;
    // against what the list was handed rather than what the last walk found, which
    // differ where handing it over threw -- inside a `Computed`, which may not write
    const held = untrack(() => listed.get());
    const next: Row<T>[] = [];
    let unchanged = lines.length === held.length;
    // added to the map after the loop, so a throw inside it leaves the map as it was
    const added: Row<T>[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const was = byKey.get(line.key);
      let row: Row<T>;
      if (was === undefined) {
        row = { ...line, bare: line.guide === '', guide: new State(line.guide) } as Row<T>;
        added.push(row);
      } else {
        if (sameRow(was, line)) {
          was.guide.set(line.guide);
          row = was;
        } else {
          row = { ...line, bare: line.guide === '', guide: new State(line.guide) } as Row<T>;
          added.push(row);
        }
      }
      next.push(row);
      unchanged &&= row === held[i];
    }
    for (const row of added) {
      byKey.set(row.key, row);
    }
    // the map the rows are found by was added to rather than made again, which for
    // a tree that only grew is a few entries and not 200,000; where it holds more
    // than the rows, one of its keys is gone and it is made again
    if (byKey.size !== lines.length) {
      byKey = new Map(next.map((row) => [row.key, row]));
    }
    rows = next;
    parents = found.parents;
    shown = found.shown;
    if (!unchanged) {
      listed.set(next);
    }
    // last, so a walk whose writes threw is not taken for one that finished, and is
    // walked again on the next ask. What it records is the open set it was handed,
    // which the `expanded.set()` above runs the effect again over: that run finds a
    // new open set, and walks it as the walk this replaces did
    walked = { landed: count, open: first, reading: now };
  };

  createEffect(() => {
    reading.get();
    expanded.get();
    landed.get();
    untrack(walkNow);
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
    const failed = loads.get(value);
    if (on && failed?.state === 'failed') {
      unfail(value, failed);
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
  const reread = (values: Iterable<T>): boolean => {
    let any = false;
    for (const value of values) {
      any = forget(value) || any;
    }
    if (any) {
      landed.set(untrack(() => landed.get()) + 1);
    }
    return any;
  };
  const reload = (value: T, options?: { subtree?: boolean }): boolean => {
    if (options?.subtree !== true) {
      return reread([value]);
    }
    const top = untrack(read);
    return reread(readsIn(Array.isArray(top) ? top : [top as TreeChoice<T>], { value }));
  };
  const reloadAll = (): boolean => reread([...loads.keys()]);

  const drawRow = (row: Row<T>): Element => {
    const guide: Element[] = [];
    if (!row.bare) {
      const line = textNode(
        untrack(() => row.guide.get()),
        {
          ...TREE_FIXED,
          class: 'sigil-tree-guide sigil-muted',
        }
      );
      // a kept row's guide moves when a sibling arrives after it or one under it goes
      createEffect(() => {
        line.setText(row.guide.get());
      });
      guide.push(line);
    }
    if (row.kind !== 'node') {
      return box(
        { class: 'sigil-tree-node', 'flex-direction': 'row' },
        ...guide,
        // in the twisty's place, so the line reads as being under the branch
        textNode(glyphs.leaf, { ...TREE_FIXED, class: 'sigil-tree-toggle' }),
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
      ...TREE_FIXED,
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
    // the rows as a walk now would find them, which the list asks for as it takes
    // its items: the walk is untracked and `listed` is what the list follows. A walk
    // that throws -- two nodes with one value -- leaves the rows as they were, and
    // the effect above reports it; thrown here, it would be reported again by each of
    // the list's effects that asked, every time one did
    items: {
      get: () => {
        try {
          untrack(walkNow);
        } catch {
          // reported by the tree's effect
        }
        return listed.get();
      },
    },
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
    tail: props.tail,
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
    reloadAll,
    status: (value) => loads.get(value)?.state ?? 'idle',
    toggle,
  };
  MODELS.set(host, {
    control: control as TreeListControl<unknown>,
    held: () => ({
      kept: kept.size,
      notes: notes.size,
      rows: byKey.size,
      reads: loads.size,
      seen: seen.size,
    }),
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
 * How much a tree list view is holding on to: what it read, the keys of its loading
 * and error lines, and the values it has met, each counted by value. Every one of
 * them shrinks when values leave the tree. For a test that says so, and for an app
 * that wants to watch a long run; not on the published subpath.
 *
 * @param host - What `TreeListView()` returned.
 * @returns The counts, or `undefined` for an element no tree built.
 */
export function treeListHeld(host: Element): TreeListHeld | undefined {
  return MODELS.get(host)?.held();
}

/**
 * Describes a tree's keys to a router, for a key-help footer: the list's, which
 * `describeListView()` says, and Right, Left and -- in a single tree -- Space, scoped
 * to the tree. Options after the hosts say what Enter does, as `describeListView()`
 * takes them: `describeTreeListView(input, tree, { activate: 'show' })`.
 *
 * @param router - What to describe the keys to.
 * @param trees - Hosts that `TreeListView()` returned, optionally followed by
 *   `DescribeListViewOptions`, which apply to every one of them.
 * @returns Takes every description back off.
 */
export function describeTreeListView(
  router: ListViewDescriber,
  ...trees: readonly Element[] | readonly [...trees: Element[], options: DescribeListViewOptions]
): () => void {
  const { hosts, options } = describedHosts(trees);
  const found = hosts.map((host) => {
    const model = MODELS.get(host);
    if (model === undefined) {
      throw new TypeError(`Expected an element that TreeListView() returned`);
    }
    return { keys: model.keys, scope: host };
  });

  const off: Array<() => void> = [];
  for (const { keys, scope } of found) {
    off.push(describeListView(router, scope, options));
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
