/**
 * A tree: `├──` and `└──` hierarchies, printed or browsed.
 *
 * What Lip Gloss's `tree` draws, and what Textual's `Tree` and `DirectoryTree` are
 * as widgets. Two halves over one drawing:
 *
 * - `tree()` prints nested data as a block of text, the way `outline()` prints a
 *   list. It takes the same items -- a string, or `{ text, items }` -- so one value
 *   can be printed either way.
 * - `selectTree()` asks for a node of one: Right opens a branch and Left closes it,
 *   a branch's children may be a function that is called the first time it opens,
 *   and the rows on screen are a window over what is open. `directoryTree()` is
 *   that prompt over a directory, read a level at a time.
 *
 * ```js
 * console.log(tree({ text: 'src', items: ['index.ts', { text: 'parser', items: ['argv.ts'] }] }));
 * // src
 * // ├── index.ts
 * // └── parser
 * //     └── argv.ts
 * ```
 *
 * The lines are a `guide` (`plain` or `rounded`); `enumerator` is `outline()`'s,
 * drawn after the guide, so a numbered tree is `enumerator: 'arabic'`.
 */

import { strip } from '../ansi/index.js';
import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { baseDir } from '../paths.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { errorMessage } from '../util/error-message.js';
import { stringWidth } from '../width/index.js';
import { terminalWidth, wrap } from '../wrap/index.js';
import { colorLevelOf } from './color-level.js';
import { unicodeSupported } from './note.js';
import {
  type OutlineEntry,
  outlineEntries,
  type OutlineEnumerator,
  type OutlineItem,
  outlineMarkers,
} from './outline.js';
import { candidatesOf, entryCache, type PathFilter } from './path.js';
import {
  type AccessibleOptions,
  type ChoiceEntry,
  listWindow,
  PROMPT_SYMBOLS,
  promptAnswered,
  promptAnswerSlot,
  promptAsLines,
  promptFooter,
  promptHeadLine,
  promptHeadWidths,
  promptKeys,
  PromptError,
  promptLineChoice,
  type PromptLineForm,
  type PromptLineReply,
  type PromptOptions,
  promptNote,
  promptListRows,
  promptSameValue,
  runLinePrompt,
  runPrompt,
  setPromptNote,
} from './prompt.js';
import nodePath from 'node:path';

/**
 * The lines a tree is drawn with. `plain` ends a list with `└──` and `rounded`
 * with `╰──`; everything else is the same. Where the terminal cannot be trusted
 * with box drawing, both are drawn as `|--` and `` `-- ``.
 */
export type TreeGuide = 'plain' | 'rounded';

/**
 * The pieces a tree is drawn with: the four a guide is made of, each four columns
 * wide, and the three toggles an interactive tree draws in front of a node's text,
 * each two.
 */
export interface TreeGlyphs {
  /** Under an ancestor that was the last of its list: nothing to continue. */
  readonly after: string;
  /** In front of an item with more after it. */
  readonly branch: string;
  /** In front of a branch that is closed. */
  readonly closed: string;
  /** In front of the last item of a list. */
  readonly last: string;
  /** In front of a leaf, where a branch's toggle would be: blank, so the text lines up. */
  readonly leaf: string;
  /** In front of a branch that is open. */
  readonly open: string;
  /** Under an ancestor with more after it: the line carries on down. */
  readonly through: string;
}

/** The toggles, which no guide style changes. */
const TOGGLES = {
  ascii: { closed: '+ ', leaf: '  ', open: '- ' },
  unicode: { closed: '▸ ', leaf: '  ', open: '▾ ' },
} as const;

const GLYPHS: Readonly<Record<TreeGuide | 'ascii', TreeGlyphs>> = {
  ascii: { ...TOGGLES.ascii, after: '    ', branch: '|-- ', last: '`-- ', through: '|   ' },
  plain: { ...TOGGLES.unicode, after: '    ', branch: '├── ', last: '└── ', through: '│   ' },
  rounded: { ...TOGGLES.unicode, after: '    ', branch: '├── ', last: '╰── ', through: '│   ' },
};

/**
 * The pieces a guide style draws.
 *
 * @param guide - The style. Defaults to `plain`.
 * @param ascii - Whether to keep to ASCII.
 * @returns The glyphs.
 */
export function treeGlyphs(guide: TreeGuide = 'plain', ascii = false): TreeGlyphs {
  if (guide !== 'plain' && guide !== 'rounded') {
    throw new TypeError(__`Unknown tree guide ${String(guide)}`);
  }
  return ascii ? GLYPHS.ascii : GLYPHS[guide];
}

/** A tree with a label at the top: an item whose children hang from the left margin. */
export type TreeRoot = Exclude<OutlineItem, string>;

export interface TreeOptions extends StyledOptions {
  /**
   * Draw with ASCII only. Defaults to what `unicodeSupported()` says of `env` and
   * `platform`.
   */
  ascii?: boolean;
  /**
   * A marker drawn after the guide, as `outline()` draws one: a style name, a
   * function of `{ index, depth, count, item }`, or an array of either read by
   * depth. Defaults to `'none'`, which is a tree with no numbering.
   */
  enumerator?: OutlineEnumerator | readonly OutlineEnumerator[];
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** The lines between items. Defaults to `plain`. */
  guide?: TreeGuide;
  /** How far the whole block is indented. Defaults to 0. */
  indent?: number;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /** The number a counting enumerator starts from. Defaults to 1. */
  start?: number;
  /** The widest the block may be. Defaults to `terminalWidth()`. */
  width?: number;
}

/** One drawn line: the guide in front of it, the marker, and the text. */
interface TreeLine {
  guide: string;
  marker: string;
  text: string;
}

/**
 * A run of a line that is drawn at the width it has, never wrapped or squeezed:
 * a guide, a marker, a twisty. `tree()`, `selectTree()` and `TreeListView` all
 * draw their runs with it. Frozen, because it is exported and one object: a
 * caller that wrote to it would change every tree in the process.
 */
export const TREE_FIXED: Readonly<{ 'flex-shrink': 0; 'white-space': 'nowrap' }> = Object.freeze({
  'flex-shrink': 0,
  'white-space': 'nowrap',
});

/** The narrowest a block is squeezed to: a guide and a few columns of text. */
const MIN_WIDTH = 8;

/** Whether what was handed over is a root rather than a list. */
function isRoot(items: readonly OutlineItem[] | TreeRoot): items is TreeRoot {
  return !Array.isArray(items) && typeof items === 'object' && items !== null;
}

/**
 * The lines of a tree, with the text of each item wrapped to the room its guide
 * leaves and every line after an item's first carrying that item's guide on down.
 *
 * Line by line rather than as nested boxes, which is the one way this differs from
 * `outline()`: a guide is a column that runs beside an item _and everything under
 * it_ and stops at the last sibling, and a box beside a body of unknown height
 * cannot be told where to turn into `└──`.
 *
 * @param items - The list, or a root.
 * @param opts - The guide, the enumerator, and the room.
 * @param room - The columns the lines may take.
 * @returns The lines.
 */
function treeLines(
  items: readonly OutlineItem[] | TreeRoot,
  opts: TreeOptions,
  room: number
): TreeLine[] {
  const ascii = opts.ascii ?? !unicodeSupported(opts.env, opts.platform);
  const glyphs = treeGlyphs(opts.guide, ascii);
  const lines: TreeLine[] = [];
  const marking = { enumerator: opts.enumerator ?? 'none', start: opts.start };

  const add = (guide: string, rest: string, marker: string, text: string): void => {
    const width = Math.max(1, room - stringWidth(guide) - stringWidth(marker));
    const blank = ' '.repeat(stringWidth(marker));
    for (const [n, line] of wrap(text, { width }).split('\n').entries()) {
      lines.push({ guide: n === 0 ? guide : rest, marker: n === 0 ? marker : blank, text: line });
    }
  };

  const walk = (entries: readonly OutlineEntry[], depth: number, base: string): void => {
    const { column, drawn } = outlineMarkers(entries, depth, marking, ascii);
    for (const [index, entry] of entries.entries()) {
      const last = index === entries.length - 1;
      const rest = base + (last ? glyphs.after : glyphs.through);
      add(
        base + (last ? glyphs.last : glyphs.branch),
        rest,
        column === 0 ? '' : `${drawn[index]} `,
        entry.text
      );
      walk(entry.items, depth + 1, rest);
    }
  };

  if (isRoot(items)) {
    const [root] = outlineEntries([items]);
    add('', '', '', root.text);
    walk(root.items, 0, '');
  } else {
    walk(outlineEntries(items), 0, '');
  }
  return lines;
}

/**
 * Builds the element tree for a tree.
 *
 * Colour is a theme role: the guides and markers are `.sigil-muted`, and
 * `.sigil-tree-label` is the item.
 *
 * @param items - A list, drawn from the left margin, or a root `{ text, items }`
 *   whose label sits on a line of its own with its children hung from it. Escape
 *   sequences in the text are dropped.
 * @param opts - The guide, the enumerator, and the room.
 * @returns The tree, and the room it was built for.
 */
export function treeView(
  items: readonly OutlineItem[] | TreeRoot,
  opts: TreeOptions = {}
): { element: Element; width: number } {
  const indent = Math.max(0, Math.floor(opts.indent ?? 0));
  const room = Math.max(
    MIN_WIDTH,
    Math.floor(opts.width ?? terminalWidth({ env: opts.env })) - indent
  );

  return {
    element: box(
      {
        class: 'sigil-tree',
        'flex-direction': 'column',
        'max-width': room,
        'padding-left': indent,
      },
      ...treeLines(items, opts, room).map((line) =>
        box(
          { class: 'sigil-tree-line', 'flex-direction': 'row' },
          // `nowrap` rather than `pre`: the line is already wrapped, and a guide
          // that is all spaces must keep its width, which `pre` does not
          ...(line.guide
            ? [textNode(line.guide, { ...TREE_FIXED, class: 'sigil-tree-guide sigil-muted' })]
            : []),
          ...(line.marker
            ? [textNode(line.marker, { ...TREE_FIXED, class: 'sigil-tree-marker sigil-muted' })]
            : []),
          textNode(line.text, { ...TREE_FIXED, class: 'sigil-tree-label' })
        )
      )
    ),
    width: room + indent,
  };
}

/**
 * Draws nested data as a tree, with `├──` and `└──` between the items.
 *
 * A facade over `treeView()`: it returns a string and the caller does the writing,
 * which is also why it ignores `--quiet` -- a tree is a result, as `outline()` and
 * `table()` are.
 *
 * An item is a string, or `{ text, items }` with the items nested under it --
 * exactly `outline()`'s, so the same value prints as either. Handed a list, the
 * tree starts at the left margin; handed one object, its text is a root on a line
 * of its own. An item that wraps carries its guide down beside the lines it wraps
 * onto.
 *
 * @param items - A list, or a root.
 * @param opts - The guide, the enumerator, and the room.
 * @returns The block, with no trailing newline.
 */
export function tree(items: readonly OutlineItem[] | TreeRoot, opts: TreeOptions = {}): string {
  const { element, width } = treeView(items, opts);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: colorLevelOf(opts),
    colorScheme: opts.colorScheme,
    width,
  });
}

/** What a branch's children are: a list, or a function that produces one when it opens. */
export type TreeChildren<T = string> =
  | readonly TreeChoiceItem<T>[]
  | (() => readonly TreeChoiceItem<T>[] | Promise<readonly TreeChoiceItem<T>[]>);

/** A node of an interactive tree. */
export interface TreeChoice<T = string> {
  /** Whether it starts open. A function for `items` is called at once if so. */
  expanded?: boolean;
  /**
   * What is under it. A node with `items` is a branch, even an empty one; a
   * function is called the first time the branch opens, and what it returns is
   * kept for the rest of the prompt.
   */
  items?: TreeChildren<T>;
  /** What is drawn. Escape sequences are dropped and a line break is a space. */
  text: string;
  /** What the prompt answers with. Defaults to `text`. */
  value?: T;
}

/** A node: a string, which is a leaf whose value is itself, or a `TreeChoice`. */
export type TreeChoiceItem<T = string> = string | TreeChoice<T>;

export interface SelectTreeOptions<T = string> extends PromptOptions, AccessibleOptions {
  /** Draw with ASCII only. Defaults to what `unicodeSupported()` says. */
  ascii?: boolean;
  /** As `tree()`'s: a marker after the guide. Defaults to `'none'`. */
  enumerator?: OutlineEnumerator | readonly OutlineEnumerator[];
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** The lines between nodes. Defaults to `plain`. */
  guide?: TreeGuide;
  /**
   * What to pick from: a list, drawn from the left margin, or one root node whose
   * children hang from it -- as `tree()` reads them.
   */
  items: readonly TreeChoiceItem<T>[] | TreeChoice<T>;
  /**
   * Only a leaf can be the answer, and Enter on a branch opens or closes it.
   * Defaults to `false`, where Enter answers with whatever is highlighted.
   */
  leaves?: boolean;
  /** Whether the highlight wraps from one end to the other. Defaults to `true`. */
  loop?: boolean;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /** How many rows the tree may take. Defaults to what the terminal has left. */
  rows?: number;
  /** What is shown once answered. Defaults to the node's text. */
  short?: (value: T) => string;
  /** The number a counting enumerator starts from. Defaults to 1. */
  start?: number;
  /**
   * Checks the answer. Return a string to reject it with that message, or
   * anything falsy to accept.
   */
  validate?: (value: T) => string | undefined | false | Promise<string | undefined | false>;
  /**
   * An answer to start from: the node holding it starts highlighted, with every
   * branch above it opened. Compared the way a `Map` compares keys.
   *
   * Looked for among the nodes there are, and no branch is read to look further:
   * one under a branch whose `items` is a function is found once something opens
   * that branch -- its own `expanded`, say -- and not before. Given up at the
   * first key, and simply never found if nothing holds it.
   */
  value?: T;
}

/** A node as the prompt holds it. */
interface TreeNode<T> {
  branch: boolean;
  /** `undefined` on a branch whose function has not been called yet. */
  children: TreeNode<T>[] | undefined;
  depth: number;
  expanded: boolean;
  last: boolean;
  load?: () => readonly TreeChoiceItem<T>[] | Promise<readonly TreeChoiceItem<T>[]>;
  loading?: Promise<void>;
  marker: string;
  parent: TreeNode<T> | undefined;
  /** Drawn bare, with no guide in front: the one node handed over on its own. */
  root: boolean;
  text: string;
  value: T;
}

/** A node's text on one line, with its escape sequences dropped. */
function flat(text: string): string {
  return strip(text).replaceAll(/\s*[\n\r]+\s*/g, ' ');
}

/** A node as an interactive tree reads it: what `treeChoiceOf()` returns. */
export interface TreeChoiceParts<T = string> {
  /** Whether it is a branch: it has `items`, even an empty list or a function. */
  readonly branch: boolean;
  /** The node as an object: the item itself, or `{ text, value }` for a string. */
  readonly choice: TreeChoice<T>;
  /** What is drawn: the text on one line, with its escape sequences dropped. */
  readonly text: string;
  /** What identifies it and what it answers with: `value`, or `text` without one. */
  readonly value: T;
}

/**
 * Reads one node of a tree the way `selectTree()` and `TreeListView` both read it:
 * a string is a leaf whose value is itself, an object needs a `text` string, a
 * node with `items` is a branch, and the text is drawn on one line.
 *
 * @param item - The node.
 * @returns Its parts.
 * @throws TypeError for an item that is neither a string nor an object with text.
 */
export function treeChoiceOf<T = string>(item: TreeChoiceItem<T>): TreeChoiceParts<T> {
  if (typeof item === 'string') {
    return {
      branch: false,
      choice: { text: item, value: item as unknown as T },
      text: flat(item),
      value: item as unknown as T,
    };
  }
  if (item === null || typeof item !== 'object' || typeof item.text !== 'string') {
    throw new TypeError(__`Expected each item to be a string or an object with a text string`);
  }
  return {
    branch: item.items !== undefined,
    choice: item,
    text: flat(item.text),
    value: item.value === undefined ? (item.text as T) : item.value,
  };
}

/**
 * Asks for a node of a tree.
 *
 * Up and Down move the highlight and wrap; Home, End, Page Up and Page Down go
 * further. **Right opens a branch**, and on one already open moves to its first
 * child; **Left closes** an open branch and otherwise moves to the parent. Space
 * opens or closes. **Enter answers** with the highlighted node's value -- or, with
 * `leaves`, opens and closes a branch and answers only on a leaf.
 *
 * A branch whose `items` is a function is read when it first opens and the result
 * kept. Keys that move or answer wait for a read in flight, so a Right and a Down
 * typed together land on the first child; Left does not wait, so a branch that is
 * slow to read can always be closed. A function that throws closes the branch
 * again and says why under the question, and the next Right asks again.
 *
 * @param opts - What to ask, and the tree to pick from.
 * @returns The chosen node's value.
 */
export function selectTree<T = string>(opts: SelectTreeOptions<T>): Promise<T> {
  if (Array.isArray(opts.items) && opts.items.length === 0) {
    return Promise.reject(new PromptError(`"${opts.message}" has nothing to offer`));
  }

  const terminal = opts.terminal ?? defaultTerminal;
  const loop = opts.loop ?? true;
  const ascii = opts.ascii ?? !unicodeSupported(opts.env, opts.platform);
  const glyphs = treeGlyphs(opts.guide, ascii);
  const marking = { enumerator: opts.enumerator ?? 'none', start: opts.start };

  let top: TreeNode<T>[] = [];
  let active: TreeNode<T> | undefined;
  let first = 0;
  let error: string | undefined;
  let finished = false;
  let chosen = '';
  let draw = (): void => {};
  /** The starting answer, until it is found or a key is pressed. */
  let want = opts.value;

  /** The first node there is that holds a value, open or not. */
  function find(nodes: readonly TreeNode<T>[], value: T): TreeNode<T> | undefined {
    for (const node of nodes) {
      if (promptSameValue(node.value, value)) {
        return node;
      }
      const inside = node.children && find(node.children, value);
      if (inside) {
        return inside;
      }
    }
    return undefined;
  }

  /** Highlights the starting answer, once there is a node holding it. */
  function place(): void {
    if (want === undefined) {
      return;
    }
    const found = find(top, want);
    if (found === undefined) {
      return;
    }
    want = undefined;
    for (let up = found.parent; up !== undefined; up = up.parent) {
      open(up);
    }
    active = found;
  }

  /** One node, and what is under it when that is a list. */
  function nodeOf(
    parts: TreeChoiceParts<T>,
    parent: TreeNode<T> | undefined,
    depth: number,
    marker: string,
    last: boolean
  ): TreeNode<T> {
    const choice = parts.choice;
    const node: TreeNode<T> = {
      branch: parts.branch,
      children: undefined,
      depth,
      expanded: false,
      last,
      marker,
      parent,
      root: false,
      text: parts.text,
      value: parts.value,
    };
    if (typeof choice.items === 'function') {
      node.load = choice.items;
    } else if (choice.items !== undefined) {
      node.children = build(choice.items, node, depth + 1);
    }
    if (choice.expanded) {
      open(node);
    }
    return node;
  }

  /** Reads a list of nodes, numbering them as `outline()` would. */
  function build(
    items: readonly TreeChoiceItem<T>[],
    parent: TreeNode<T> | undefined,
    depth: number
  ): TreeNode<T>[] {
    if (!Array.isArray(items)) {
      throw new TypeError(__`Expected items to be an array`);
    }
    const choices = items.map((item) => treeChoiceOf<T>(item));
    const { column, drawn } = outlineMarkers(
      choices.map((parts) => ({ items: [], text: parts.text })),
      depth,
      marking,
      ascii
    );
    return choices.map((parts, index) =>
      nodeOf(
        parts,
        parent,
        depth,
        column === 0 ? '' : `${drawn[index]} `,
        index === choices.length - 1
      )
    );
  }

  /** Opens a branch, calling its function the first time. */
  function open(node: TreeNode<T>): void {
    if (!node.branch) {
      return;
    }
    node.expanded = true;
    if (node.children !== undefined || node.loading !== undefined || node.load === undefined) {
      return;
    }
    const loading = Promise.resolve()
      // called through a `then`, so that a function which throws before it
      // returns a promise is a rejection like any other, and so that this
      // settles after `loading` is recorded rather than before
      .then(node.load)
      .then(
        (items) => {
          node.children = build(items, node, node.depth + 1);
        },
        (err: unknown) => {
          node.expanded = false;
          error = errorMessage(err);
        }
      )
      .catch((err: unknown) => {
        // `build()` refusing what the function returned
        node.expanded = false;
        error = errorMessage(err);
      })
      .finally(() => {
        node.loading = undefined;
        if (!finished) {
          draw();
        }
      });
    node.loading = loading;
  }

  /**
   * The guide in front of a node: a column per ancestor, carrying the line on
   * down where that ancestor has siblings still to come, and then its own branch.
   * A root has none and gives its children none.
   */
  function guideOf(node: TreeNode<T>): string {
    if (node.root) {
      return '';
    }
    let guide = node.last ? glyphs.last : glyphs.branch;
    for (let up = node.parent; up !== undefined && !up.root; up = up.parent) {
      guide = (up.last ? glyphs.after : glyphs.through) + guide;
    }
    return guide;
  }

  /** The nodes on screen, in order: every node whose ancestors are all open. */
  function visible(): TreeNode<T>[] {
    const out: TreeNode<T>[] = [];
    const walk = (nodes: readonly TreeNode<T>[]): void => {
      for (const node of nodes) {
        out.push(node);
        if (node.expanded && node.children) {
          walk(node.children);
        }
      }
    };
    walk(top);
    return out;
  }

  /**
   * Waits for every open branch on screen to have its children, and for any of
   * those that open themselves in turn. A branch that was closed again is not
   * waited for: its children would not be on screen, so they change nothing a
   * key could land on.
   */
  async function opened(): Promise<void> {
    for (;;) {
      const reads = visible()
        .filter((node) => node.expanded && node.loading !== undefined)
        .map((node) => node.loading);
      if (reads.length === 0) {
        return;
      }
      await Promise.all(reads);
    }
  }

  /** Reads what was handed over into nodes, which is where a malformed item is refused. */
  function plant(): void {
    if (Array.isArray(opts.items)) {
      top = build(opts.items, undefined, 0);
    } else {
      // the one node handed over on its own: drawn bare, with its children hung
      // from the margin -- which is what a depth of -1 makes them, depth 0
      const root = nodeOf(treeChoiceOf<T>(opts.items as TreeChoice<T>), undefined, -1, '', true);
      root.root = true;
      top = [root];
    }
    active = top[0];
  }

  if (promptAsLines(opts)) {
    return lineTree();
  }

  /**
   * The tree as lines: one level at a time, as a numbered list.
   *
   * Flattening the whole tree into one list was the obvious form, and it reads
   * every branch there is to do it -- which for `directoryTree()` is every
   * directory under the root, and for a branch whose `items` is a function is the
   * read the drawn prompt makes only when it is opened. So a line lists one level:
   * a leaf is an answer, a branch is gone into, and the level says where it is,
   * which is the depth an indent would have shown and a screen reader would not
   * have said. Without `leaves` a branch is an answer as well, picked from inside
   * itself as `this one` -- one number per thing a number does, rather than a
   * second gesture beside it. Going back up is a number like any other.
   *
   * A branch is read the first time it is gone into, through `open()`, so the
   * read is the drawn prompt's, kept the same way, and a read that fails says why
   * and stays on the level it was asked from. A starting answer is found once the
   * branches that open themselves have been read, and the list opens on its level
   * with it as what Enter alone picks.
   */
  function lineTree(): Promise<T> {
    type Step =
      | { kind: 'pick'; node: TreeNode<T> }
      | { kind: 'go'; level: TreeNode<T> | undefined };

    /** Whether a level has been listed, so the top of a list is headed coming back to it. */
    let again = false;

    /** The list for a level: a node, or `undefined` for the top of a list handed over. */
    function level(at: TreeNode<T> | undefined, from?: TreeNode<T>): PromptLineForm<T> {
      const steps: Step[] = [];
      const entries: ChoiceEntry<Step>[] = [];
      const add = (label: string, hint: string | undefined, value: Step): void => {
        steps.push(value);
        entries.push({ hint, label, value });
      };

      if (at && !opts.leaves) {
        add(at.text, __`this one`, { kind: 'pick', node: at });
      }
      for (const node of at ? (at.children ?? []) : top) {
        if (node.branch) {
          add(node.text, __`go in`, { kind: 'go', level: node });
        } else {
          add(node.text, undefined, { kind: 'pick', node });
        }
      }
      if (at && !at.root) {
        add(at.parent ? __`Back to ${at.parent.text}` : __`Back to the top`, undefined, {
          kind: 'go',
          level: at.parent,
        });
      }

      // what Enter alone picks: the node a level was come back up from, or a
      // starting answer, and otherwise the first -- the drawn prompt's highlight
      const initial =
        from === undefined
          ? -1
          : steps.findIndex((s) => (s.kind === 'pick' ? s.node : s.level) === from);
      const form = promptLineChoice<Step, T>(opts.message, entries, {
        // the top of a list is the question's own level, which the question
        // heads the first time it is written and is said again on the way back
        heading: at ? [__`In ${at.text}`] : again ? [opts.message] : [],
        initial: Math.max(0, initial),
        pick: (choice) => step(choice.value as Step, at),
      });
      if (form instanceof PromptError) {
        throw form;
      }
      again = true;
      return form;
    }

    async function step(chosen: Step, here: TreeNode<T> | undefined): Promise<PromptLineReply<T>> {
      if (chosen.kind === 'pick') {
        const { node } = chosen;
        const failed = await opts.validate?.(node.value);
        if (typeof failed === 'string' && failed) {
          return failed;
        }
        return {
          said: __`Chosen: ${opts.short ? opts.short(node.value) : node.text}`,
          value: node.value,
        };
      }
      const target = chosen.level;
      if (target && target.children === undefined) {
        open(target);
        await target.loading;
        if (target.children === undefined) {
          // a read that failed is not kept, so asking for it again reads again
          const why = error ?? '';
          error = undefined;
          return why;
        }
      }
      return level(target, target === here?.parent ? here : undefined);
    }

    return runLinePrompt<T>(opts, () => {
      // at once, so a malformed item is refused before anything is written
      plant();
      return opened().then(() => {
        const found = want === undefined ? undefined : find(top, want);
        want = undefined;
        const start = found
          ? found.parent
          : Array.isArray(opts.items)
            ? undefined
            : (top[0] as TreeNode<T>);
        return level(start, found);
      });
    }, [opts.message]);
  }

  return runPrompt<T>(opts, () => {
    plant();

    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width));
    const answer = promptAnswerSlot(head.rest);
    const { line, mark } = promptHeadLine(opts.message, head.message, answer.beside);
    const complaint = promptNote('sigil-prompt-error sigil-error');
    const list = box({ class: 'sigil-tree-list', 'flex-direction': 'column' });

    // Left closes, or goes up, without waiting for anything: it is the key that
    // gets away from a branch whose read has stalled, and holding it behind that
    // read is the freeze `filePicker()` records. Every other key waits for the
    // open branches on screen, so it lands on the rows that will be drawn. What
    // the footer says follows the highlight: Enter toggles a branch under
    // `leaves`, and Space is listed only on a branch, where it does something.
    // The arrows and the paging keys are answered and not listed, as in every
    // list prompt
    const keys = promptKeys<Promise<{ value: T } | void> | void>();
    const settled = (
      step: (
        node: TreeNode<T>,
        rows: TreeNode<T>[],
        at: number
      ) => Promise<{ value: T } | void> | void
    ) => {
      return async (): Promise<{ value: T } | void> => {
        await opened();
        // the starting answer is placed before the key acts, so an Enter typed
        // before the reads on the way down to it landed still takes it --
        // `filePicker()`'s rule. Once a key has acted the person has moved, and
        // a later read is not one to jump to
        place();
        want = undefined;
        const node = active as TreeNode<T>;
        const rows = visible();
        return step(node, rows, rows.indexOf(node));
      };
    };
    const go = (rows: TreeNode<T>[], to: number): void => {
      active = rows[Math.min(Math.max(0, to), rows.length - 1)];
    };
    /** Opens a branch that is closed, and closes one that is open. */
    const flip = (node: TreeNode<T>): void => {
      if (node.branch && node.expanded) {
        node.expanded = false;
      } else {
        open(node);
      }
    };
    const toggles = (): boolean => active?.branch === true;

    keys.on('left', () => {
      // waits for nothing, so the person has moved before any starting answer
      // still being read for could be placed
      want = undefined;
      const node = active as TreeNode<T>;
      if (node.branch && node.expanded) {
        node.expanded = false;
      } else if (node.parent) {
        active = node.parent;
      }
    });
    keys.on(
      'right',
      settled((node) => {
        if (node.branch && !node.expanded) {
          open(node);
        } else if (node.expanded && node.children && node.children.length > 0) {
          active = node.children[0];
        }
      })
    );
    keys.on(
      'up',
      settled((_, rows, at) => go(rows, loop ? (at - 1 + rows.length) % rows.length : at - 1))
    );
    keys.on(
      'down',
      settled((_, rows, at) => go(rows, loop ? (at + 1) % rows.length : at + 1))
    );
    keys.on(
      'home',
      settled((_, rows) => go(rows, 0))
    );
    keys.on(
      'end',
      settled((_, rows) => go(rows, rows.length - 1))
    );
    keys.on(
      'pageup',
      settled((_, rows, at) => go(rows, at - page()))
    );
    keys.on(
      'pagedown',
      settled((_, rows, at) => go(rows, at + page()))
    );
    keys.on(
      'space',
      settled((node) => flip(node)),
      () => (toggles() ? { description: __`toggle`, priority: 2 } : undefined)
    );
    keys.on(
      'enter',
      settled((node) => (node.branch && opts.leaves ? flip(node) : choose(node))),
      () =>
        toggles() && opts.leaves
          ? { description: __`toggle`, priority: 3 }
          : { description: __`pick`, priority: 3 }
    );

    const footer = promptFooter(keys, terminal.width, opts.back);
    const view = box(
      { class: 'sigil-prompt sigil-tree-select', 'flex-direction': 'column' },
      line,
      answer.under,
      box({ 'padding-left': 2 }, complaint),
      list,
      footer
    );

    // the footer's row is kept back with the question's and the error line's
    const room = (): number => {
      return promptListRows(opts.rows, terminal.height, head.lines + (error ? 1 : 0) + 1);
    };

    /** A page, in rows: the window less one, so a row stays in view. */
    const page = (): number => Math.max(1, room() - 1);

    /** One row: the pointer, the guide, whether it is open, the marker and the text. */
    function row(node: TreeNode<T>, current: boolean): Element {
      const guide = guideOf(node);
      const state = node.branch ? (node.expanded ? glyphs.open : glyphs.closed) : glyphs.leaf;
      return box(
        { class: current ? 'sigil-tree-row is-active sigil-accent' : 'sigil-tree-row' },
        textNode(PROMPT_SYMBOLS.cursor, {
          class: 'sigil-tree-pointer',
          'margin-right': 1,
          visibility: current ? 'visible' : 'hidden',
          'white-space': 'nowrap',
        }),
        ...(guide
          ? [textNode(guide, { ...TREE_FIXED, class: 'sigil-tree-guide sigil-muted' })]
          : []),
        textNode(state, { ...TREE_FIXED, class: 'sigil-tree-toggle sigil-muted' }),
        ...(node.marker
          ? [textNode(node.marker, { ...TREE_FIXED, class: 'sigil-tree-marker sigil-muted' })]
          : []),
        textNode(node.text, { class: 'sigil-tree-label', 'white-space': 'nowrap' }),
        // only on an open branch: a closed one still reading is nothing on screen
        ...(node.expanded && node.loading
          ? [
              textNode(ascii ? ' ...' : ' …', {
                ...TREE_FIXED,
                class: 'sigil-tree-loading sigil-muted',
              }),
            ]
          : [])
      );
    }

    draw = (): void => {
      place();
      const rows = visible();
      if (active === undefined || !rows.includes(active)) {
        active = rows[0];
      }
      const at = active === undefined ? 0 : rows.indexOf(active);
      keys.refresh();
      setPromptNote(complaint, error);
      const space = room();
      first = listWindow(rows.length, at, space, first);
      const shown = Math.max(1, Math.min(space, rows.length));

      while (list.children.length > 0) {
        list.removeChild(list.children[0] as Element);
      }
      for (const [index, node] of rows.entries()) {
        if (index >= first && index < first + shown) {
          list.append(row(node, node === active));
        }
      }
    };

    draw();

    /** Submits an answer, or says why it cannot be. */
    async function choose(node: TreeNode<T>): Promise<{ value: T } | void> {
      const failed = await opts.validate?.(node.value);
      if (typeof failed === 'string' && failed) {
        error = failed;
        draw();
        return;
      }
      chosen = opts.short ? opts.short(node.value) : node.text;
      return { value: node.value };
    }

    return {
      async key(k) {
        error = undefined;
        if (active === undefined) {
          return;
        }
        const done = await keys.match(k)?.(k);
        if (done) {
          return done;
        }
        draw();
      },

      settle(): void {
        finished = true;
        promptAnswered(mark);
        answer.show(chosen);
        setPromptNote(complaint, undefined);
        footer.setProps({ display: 'none' });
        list.setProps({ display: 'none' });
      },

      view,
    };
  });
}

/** Which directories and files a directory tree offers, and where it starts. */
export interface DirectoryRootOptions {
  /** List directories only, and no files. Defaults to `false`. */
  directory?: boolean;
  /**
   * Which files are offered, by extension, with or without the dot. Directories
   * are always offered. The rule `path()` and `filePicker()` have.
   */
  extensions?: readonly string[];
  /** List dotfiles. Defaults to `false`. */
  hidden?: boolean;
  /** The directory at the top of the tree. Defaults to the working directory. A `~` is expanded. */
  root?: string;
  /**
   * A path under `root` to open the way down to: every directory between the two
   * starts open. Nothing is opened for a path that is not under `root`.
   */
  value?: string;
}

/**
 * A directory as the root node of a tree: open, with each directory under it a
 * branch whose `items` is a function that reads it.
 *
 * What `directoryTree()` asks over and what a `TreeListView` browses, so the two
 * offer the same entries: each read goes through `path()`'s reader and its filter,
 * so `directory`, `extensions` and `hidden` mean what they mean there, directories
 * come first, and a directory that cannot be read has nothing in it. A directory
 * is read each time its function is called, which both trees do once and then
 * keep -- so a tree that is asked to read one again reads the disk again. Every
 * `value` is an absolute path.
 *
 * @param opts - Where to start, and what to offer.
 * @returns The root node.
 */
export function directoryRoot(opts: DirectoryRootOptions = {}): TreeChoice<string> {
  const base = baseDir(opts.root) ?? nodePath.resolve(opts.root ?? process.cwd());
  const filter: PathFilter = {
    directory: opts.directory,
    extensions: opts.extensions,
    hidden: opts.hidden,
  };
  // the directories on the way down to a starting path are opened here, where
  // the path says which they are, since neither tree reads a branch to look
  const target = typeof opts.value === 'string' ? nodePath.resolve(opts.value) : undefined;

  const read = (dir: string) => async (): Promise<TreeChoice<string>[]> => {
    // a reader of its own per call, so a second call reads the disk again
    const cache = entryCache();
    await cache.load(dir);
    return candidatesOf(cache.get(dir) ?? [], '', filter).map((entry) => {
      const value = nodePath.join(dir, entry.name);
      return entry.dir
        ? {
            expanded: target?.startsWith(value + nodePath.sep) === true,
            items: read(value),
            text: entry.name + nodePath.sep,
            value,
          }
        : { text: entry.name, value };
    });
  };

  return {
    expanded: true,
    items: read(base),
    text: (nodePath.basename(base) || base) + (nodePath.basename(base) ? nodePath.sep : ''),
    value: base,
  };
}

export interface DirectoryTreeOptions extends Omit<
  SelectTreeOptions<string>,
  'items' | 'leaves' | 'short' | 'enumerator' | 'start'
> {
  /**
   * Pick a directory rather than a file. Defaults to `false`.
   *
   * Files are not listed, and Enter answers with the highlighted directory --
   * the root included -- while Right and Left open and close.
   */
  directory?: boolean;
  /**
   * Which files are offered, by extension, with or without the dot. Directories
   * are always offered. The rule `path()` and `filePicker()` have.
   */
  extensions?: readonly string[];
  /** List dotfiles. Defaults to `false`. */
  hidden?: boolean;
  /** The directory at the top of the tree. Defaults to the working directory. A `~` is expanded. */
  root?: string;
  /**
   * An answer to start from: a path, which starts highlighted with every
   * directory between it and `root` opened. Dropped when it is not under `root`
   * or is not there any more.
   */
  value?: string;
}

/**
 * Asks for a file, or a directory, out of a tree of them.
 *
 * `selectTree()` over `directoryRoot()`: the root is the top node, open, and each
 * directory under it is a branch read the first time it opens -- through the same
 * read and the same filter `path()` and `filePicker()` use, so the three agree
 * about what is offered. Enter on a directory opens and closes it and on a file
 * answers; with `directory`, files are not listed and Enter answers with a
 * directory. The answer is an absolute path.
 *
 * @param opts - What to ask, where to start, and what to offer.
 * @returns The path.
 */
export function directoryTree(opts: DirectoryTreeOptions): Promise<string> {
  const target = typeof opts.value === 'string' ? nodePath.resolve(opts.value) : undefined;
  return selectTree<string>({
    ...opts,
    value: target,
    items: directoryRoot({
      directory: opts.directory,
      extensions: opts.extensions,
      hidden: opts.hidden,
      root: opts.root,
      value: target,
    }),
    leaves: !opts.directory,
    short: (value) => value,
  });
}
