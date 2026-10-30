/**
 * An outline: bulleted, numbered and nested lists, as a block of text.
 *
 * What Lip Gloss's `list` package and Ink UI's `UnorderedList` and `OrderedList`
 * draw, and what an app printing its "next steps" otherwise does by hand. An item
 * is a string, or an object holding one and the items nested under it; the marker
 * in front of each is chosen by depth, and an item that wraps hangs under its own
 * text rather than under its marker.
 *
 * ```js
 * console.log(
 *   outline(['Install', { text: 'Configure', items: ['Pick a theme', 'Pick a shell'] }, 'Ship'], {
 *     enumerator: ['arabic', 'alpha'],
 *   })
 * );
 * ```
 *
 * Named `outline` and not `list` because `list()` in this barrel has been the
 * prompt that reads a line as an array since SIG-157.
 */

import { ansi as defaultAnsi, strip } from '../ansi/index.js';
import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { For } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { terminalWidth } from '../wrap/index.js';
import { type Mounted, type MountOptions, mountLevel, mountLive } from './mount.js';
import { unicodeSupported } from './note.js';

/** One entry: a string, or a string with the entries nested under it. */
export type OutlineItem = string | { items?: readonly OutlineItem[]; text: string };

/**
 * The markers a name stands for.
 *
 * `arabic`, `alpha`, `ALPHA`, `roman` and `ROMAN` count, and end in a full stop.
 * `bullet`, `dash` and `asterisk` are one character each, and `none` is nothing at
 * all: an item with no marker, which still nests.
 */
export type OutlineStyle =
  | 'alpha'
  | 'ALPHA'
  | 'arabic'
  | 'asterisk'
  | 'bullet'
  | 'dash'
  | 'none'
  | 'roman'
  | 'ROMAN';

/** What an enumerator function is told about the item it is numbering. */
export interface OutlineMarkerInfo {
  /** How many items are in this item's list, so a marker can be `3/7`. */
  count: number;
  /** How deep the item is, 0 for the top. */
  depth: number;
  /** The item's position in its list, from 0. `start` does not move it. */
  index: number;
  /** The item's text. */
  item: string;
}

/** A name from `OutlineStyle`, or a function that returns the marker to draw. */
export type OutlineEnumerator = OutlineStyle | ((info: OutlineMarkerInfo) => string);

export interface OutlineOptions extends StyledOptions {
  /**
   * Draw the bullets with ASCII only. Defaults to what `unicodeSupported()` says
   * of `env` and `platform`.
   */
  ascii?: boolean;
  /**
   * The marker for each item. One value is used at every depth; an array is read
   * by depth and cycles, so `['arabic', 'alpha', 'roman']` is the outline of a
   * legal document and `['bullet', 'dash']` is the default.
   *
   * A function is handed `{ index, depth, count, item }` and returns the marker
   * as text. Escape sequences are dropped from it, and a line break is read as a
   * space.
   */
  enumerator?: OutlineEnumerator | readonly OutlineEnumerator[];
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** How far the whole block is indented. Defaults to 0. */
  indent?: number;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /**
   * The number the first item of a counting list has. Defaults to 1. Only the
   * counting styles read it, and a function is told `index` from 0 regardless.
   */
  start?: number;
  /** The widest the block may be. Defaults to `terminalWidth()`. */
  width?: number;
}

/** Between a marker and the text it belongs to. */
const GAP = 1;

/** How far a list is indented under an item that has no marker to hang it from. */
const BARE_INDENT = 2;

/** The widest a block may be squeezed to: a marker, a space and one column. */
const MIN_WIDTH = 4;

const DEFAULT_ENUMERATOR: readonly OutlineEnumerator[] = ['bullet', 'dash'];

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/**
 * A number as roman numerals, lower case.
 *
 * Roman numerals stop at 3999 -- there is no numeral for 5000 short of a bar over
 * one -- and have no zero or negatives, so those are drawn as the Arabic number
 * they are rather than as an empty marker or a run of `m`.
 *
 * @param value - The number.
 * @returns The numerals.
 */
function toRoman(value: number): string {
  if (value < 1 || value > 3999) {
    return String(value);
  }
  let rest = value;
  let out = '';
  for (const [size, numeral] of ROMAN) {
    while (rest >= size) {
      out += numeral;
      rest -= size;
    }
  }
  return out;
}

/**
 * A number as letters, lower case: `a` to `z`, then `aa`, `ab` -- a spreadsheet's
 * columns, which is the only convention a list that runs past 26 has.
 *
 * @param value - The number, from 1. Anything under 1 has no letter and is
 *   drawn as the number.
 * @returns The letters.
 */
function toAlpha(value: number): string {
  if (value < 1) {
    return String(value);
  }
  let rest = value;
  let out = '';
  while (rest > 0) {
    rest -= 1;
    out = String.fromCharCode(97 + (rest % 26)) + out;
    rest = Math.floor(rest / 26);
  }
  return out;
}

/** The glyphs a style draws, by whether the terminal can be trusted with them. */
const GLYPHS = {
  asterisk: ['*', '*'],
  bullet: ['•', '*'],
  dash: ['–', '-'],
} as const;

/**
 * The marker a style draws for one item.
 *
 * @param style - The style's name.
 * @param position - The number the item has, counting from `start`.
 * @param ascii - Whether to keep to ASCII.
 * @returns The marker.
 */
function styled(style: OutlineStyle, position: number, ascii: boolean): string {
  switch (style) {
    case 'alpha':
      return `${toAlpha(position)}.`;
    case 'ALPHA':
      return `${toAlpha(position).toUpperCase()}.`;
    case 'arabic':
      return `${position}.`;
    case 'asterisk':
    case 'bullet':
    case 'dash':
      return GLYPHS[style][ascii ? 1 : 0];
    case 'none':
      return '';
    case 'roman':
      return `${toRoman(position)}.`;
    case 'ROMAN':
      return `${toRoman(position).toUpperCase()}.`;
    default:
      throw new TypeError(__`Unknown outline enumerator ${String(style)}`);
  }
}

/** One item, read: its text, and what is nested under it. */
interface Entry {
  items: readonly Entry[];
  text: string;
}

/**
 * Reads the items a caller wrote into the shape the rest of this uses.
 *
 * Done once and up front, so a malformed entry throws before anything is laid out
 * and with the same words however deep it was.
 *
 * @param items - What the caller passed.
 * @returns The entries.
 */
function read(items: readonly OutlineItem[]): Entry[] {
  if (!Array.isArray(items)) {
    throw new TypeError(__`Expected items to be an array`);
  }
  return items.map((item) => {
    if (typeof item === 'string') {
      return { items: [], text: strip(item) };
    }
    if (item === null || typeof item !== 'object' || typeof item.text !== 'string') {
      throw new TypeError(__`Expected each item to be a string or an object with a text string`);
    }
    return { items: item.items === undefined ? [] : read(item.items), text: strip(item.text) };
  });
}

/**
 * Asks the options which enumerator a depth takes.
 *
 * @param opts - The options.
 * @param depth - How deep the list is.
 * @returns The enumerator.
 */
function enumeratorAt(opts: OutlineOptions, depth: number): OutlineEnumerator {
  const given = opts.enumerator;
  if (given === undefined) {
    return DEFAULT_ENUMERATOR[depth % DEFAULT_ENUMERATOR.length];
  }
  if (Array.isArray(given)) {
    if (given.length === 0) {
      throw new TypeError(__`Expected enumerator to hold at least one entry`);
    }
    return given[depth % given.length];
  }
  return given as OutlineEnumerator;
}

/**
 * The markers of one list, drawn on one line each and as wide as the widest.
 *
 * Padded on the left so that a counting list lines up on its full stops:
 * `9.` over `10.` would otherwise start its text a column apart.
 *
 * @param entries - The list.
 * @param depth - How deep it is.
 * @param opts - The options.
 * @param ascii - Whether to keep to ASCII.
 * @returns The markers, and the width of the column they make.
 */
function markers(
  entries: readonly Entry[],
  depth: number,
  opts: OutlineOptions,
  ascii: boolean
): { column: number; drawn: string[] } {
  const enumerator = enumeratorAt(opts, depth);
  const start = opts.start === undefined ? 1 : Math.trunc(opts.start);
  const drawn = entries.map((entry, index) => {
    const marker =
      typeof enumerator === 'function'
        ? enumerator({ count: entries.length, depth, index, item: entry.text })
        : styled(enumerator, start + index, ascii);
    if (typeof marker !== 'string') {
      throw new TypeError(__`Expected an enumerator to return a string`);
    }
    return strip(marker).replaceAll(/\s*[\n\r]+\s*/g, ' ');
  });
  const column = Math.max(0, ...drawn.map((marker) => stringWidth(marker)));
  return {
    column,
    drawn: drawn.map((marker) => ' '.repeat(column - stringWidth(marker)) + marker),
  };
}

/**
 * One list and everything nested under it, as a column of rows.
 *
 * A row is the marker and a column beside it holding the text and, under the
 * text, the nested list -- so the nesting lines up with the text it belongs to
 * and not with the marker, and a wrapped line hangs under its own first word
 * without anything here counting a column of it.
 *
 * @param entries - The list.
 * @param depth - How deep it is.
 * @param opts - The options.
 * @param ascii - Whether to keep to ASCII.
 * @returns The list, as a tree.
 */
function listNode(
  entries: readonly Entry[],
  depth: number,
  opts: OutlineOptions,
  ascii: boolean
): Element {
  const { column, drawn } = markers(entries, depth, opts, ascii);

  return box(
    { class: 'sigil-outline-list', 'flex-direction': 'column' },
    ...entries.map((entry, index) => {
      const body: Element[] = [textNode(entry.text, { class: 'sigil-outline-text' })];
      if (entry.items.length > 0) {
        body.push(
          box(
            {
              class: 'sigil-outline-nested',
              'flex-direction': 'column',
              'padding-left': column === 0 ? BARE_INDENT : 0,
            },
            listNode(entry.items, depth + 1, opts, ascii)
          )
        );
      }

      return box(
        { class: 'sigil-outline-item', 'flex-direction': 'row' },
        ...(column === 0
          ? []
          : [
              textNode(drawn[index], {
                class: 'sigil-outline-marker sigil-muted',
                'flex-shrink': 0,
                'padding-right': GAP,
                'white-space': 'nowrap',
              }),
            ]),
        box(
          {
            class: 'sigil-outline-body',
            'flex-direction': 'column',
            'flex-shrink': 1,
            'min-width': 0,
          },
          ...body
        )
      );
    })
  );
}

/**
 * Builds the element tree for an outline.
 *
 * The tree is what an app puts inside its own renderer, and what `createOutline()`
 * rebuilds when its items change. Colour is a theme role: the markers are
 * `.sigil-muted`, and `.sigil-outline-text` is the item.
 *
 * @param items - The items. Escape sequences in a string are dropped.
 * @param opts - The enumerators, and the room.
 * @returns The tree, and the room it was built for.
 */
export function outlineView(
  items: readonly OutlineItem[],
  opts: OutlineOptions = {}
): { element: Element; width: number } {
  const entries = read(items);
  const indent = Math.max(0, Math.floor(opts.indent ?? 0));
  const room = Math.max(
    MIN_WIDTH,
    Math.floor(opts.width ?? terminalWidth({ env: opts.env })) - indent
  );
  const ascii = opts.ascii ?? !unicodeSupported(opts.env, opts.platform);

  return {
    element: box(
      {
        class: 'sigil-outline',
        'flex-direction': 'column',
        'max-width': room,
        'padding-left': indent,
      },
      listNode(entries, 0, opts, ascii)
    ),
    width: room + indent,
  };
}

/**
 * Lays items out as bulleted, numbered or nested lists.
 *
 * A facade over `outlineView()`, the way `note()` is over `noteView()`: it
 * returns a string and the caller does the writing, which is also why it ignores
 * `--quiet` -- a list is a result, on `table()`'s side of that line.
 *
 * A counting list is aligned on its full stops, an item that wraps hangs under
 * its own text, and a list nested under an item starts at the column that item's
 * text does. Escape sequences are dropped from the items and the markers: colour
 * is the theme's, and `.sigil-muted` is what the markers take.
 *
 * @param items - The items. A string is an item, and an object carries the items
 *   nested under it.
 * @param opts - The enumerators, and the room.
 * @returns The block, with no trailing newline.
 */
export function outline(items: readonly OutlineItem[], opts: OutlineOptions = {}): string {
  const { element, width } = outlineView(items, opts);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    colorScheme: opts.colorScheme,
    width,
  });
}

/** A list in a live region, whose items can be replaced. */
export interface Outline {
  /** Ends the outline, leaving it as it stands. Where there is no terminal, writes it. */
  done(): void;
  /** Ends the outline and erases it, leaving nothing behind. */
  stop(): void;
  /** Replaces the items and redraws. */
  update(items: readonly OutlineItem[]): void;
}

/**
 * An outline in a live region, for a list that changes while it is on screen.
 *
 * A checklist whose items appear as they are found, or a plan whose steps are
 * reworded as it runs. The items are replaced whole -- `update()` takes the new
 * list, and the rows that did not change are redrawn identically.
 *
 * Where there is no terminal there is no frame to repaint, so nothing is written
 * until `done()`, which writes the list once, as `outline()` would. A quiet run
 * writes nothing.
 *
 * @param items - The items to start with.
 * @param opts - The enumerators, the room, and where to draw.
 * @returns The handle.
 */
export function createOutline(
  items: readonly OutlineItem[],
  opts: OutlineOptions & MountOptions = {}
): Outline {
  const terminal = opts.terminal ?? opts.backend?.terminal ?? defaultTerminal;
  const base = { ...opts, terminal };
  const shown = new State<readonly OutlineItem[]>(items);
  // read now, so that a malformed list throws where it was handed over
  read(items);

  let current = items;
  let mounted: Mounted | undefined;
  let ended = false;

  if (mountLevel(base) === 'live') {
    mounted = mountLive(
      () =>
        // a one-element list whose element is the items array, so that handing
        // over a new array is the row changing and the tree is rebuilt for it
        For({
          children: (list) => outlineView(list, opts).element,
          each: () => [shown.get()],
        }),
      base
    );
    mounted.frame();
  }

  return {
    done(): void {
      if (ended) {
        return;
      }
      ended = true;
      if (mounted) {
        mounted.frame();
        mounted.done();
      } else if (mountLevel(base) !== 'quiet') {
        terminal.write(`${outline(current, opts)}\n`);
      }
    },

    stop(): void {
      if (ended) {
        return;
      }
      ended = true;
      mounted?.stop();
    },

    update(next: readonly OutlineItem[]): void {
      read(next);
      if (ended) {
        return;
      }
      current = next;
      shown.set(next);
      mounted?.frame();
    },
  };
}
