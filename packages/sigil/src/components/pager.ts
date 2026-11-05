/**
 * A pager: a long document in a window, with line numbers, `/` search and the
 * keys `less` taught everybody.
 *
 * `ScrollBox` is the scrolling half -- the clip, the scrollbar, the wheel, the
 * windowing that makes ten thousand lines cost what twenty do -- and this is the
 * half a *document* adds on top of it: a keymap, a gutter, and a search whose
 * matches are drawn where they are.
 *
 * ```js
 * import { createPager, page } from '@ttylabs/sigil/components';
 *
 * // the whole screen, until `q`
 * await page(readFileSync('CHANGELOG.md', 'utf8'), { lineNumbers: true });
 *
 * // or an element, in a tree an app already has
 * const pager = createPager({ content: text, props: { height: 20 } });
 * pager.describe(input); // so a key-help footer can list its keys
 * ```
 *
 * ## Its own component, over a scroll box
 *
 * Not props on `ScrollBox`, because the two hold different things. A scroll box
 * holds **no state** -- that is its first recorded decision -- and holds any
 * element at all; a pager holds a query, its matches, which one is current and
 * whether a search is being typed, and what it holds is **text**, which is the
 * only thing a search can be run over. Putting a search on `ScrollBox` would make
 * it a text component with a state, and putting `space`, `b`, `d` and `u` on it
 * would make every scroll box with a text field inside it eat the letters the
 * field was waiting for. So this is a component that builds one, the way
 * `selectRow()` builds on `table()`'s pieces.
 *
 * ## Soft wrap by default, at the column rather than the word
 *
 * A line wider than the window is folded onto the rows under it, which is what
 * `less` does unless asked not to -- and the fold is at the **column**, not at a
 * space. `wrap()` breaks prose at words and drops the whitespace it breaks at,
 * which is right for a help screen and wrong here: a pager shows every character
 * of the file, in order, and a match maps to a row by arithmetic only when no
 * character was moved or dropped. `wrap: false` is the other answer -- one row per
 * line, cut at the window's edge, with Left and Right shifting the view by half a
 * window -- for a log or a table where a folded row breaks the columns.
 */

import { ansi as defaultAnsi, strip } from '../ansi/index.js';
import { createFullscreenCanvas } from '../canvas/index.js';
import { box, type Element, type ElementProps, text, toDisplayText } from '../element/index.js';
import { __ } from '../i18n/index.js';
import {
  canReadKeys,
  createInput,
  type InputRouter,
  type InputStream,
  isAbort,
  type KeyEvent,
} from '../input/index.js';
import { render } from '../renderer/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { graphemes, graphemeWidth, stringWidth } from '../width/index.js';
import { ScrollBox, scrollControl, type ScrollControl } from './scroll-box.js';

/** How a query is read. */
export type PagerSearchMode = 'literal' | 'regex';

export interface PagerOptions {
  /**
   * The document: one string, split on its newlines, or the lines themselves.
   *
   * Escape sequences are **stripped**, so coloured output can be paged without its
   * SGR showing as `[31m` -- and without its colour, which is the cost: carrying
   * an input's own styling through means turning SGR into styled runs, which is a
   * second renderer for one component. A tab goes to the next stop of eight, as a
   * terminal draws it, and every other control character is dropped, as a `text`
   * element drops it.
   *
   * Read once. A document that changes is a new pager.
   */
  content: string | readonly string[];
  /** Number each line in a gutter on the left. Defaults to `false`. */
  lineNumbers?: boolean;
  /**
   * Called on `q`. Without one, `q` is not claimed and reaches whatever is
   * around the pager, which is what an element in a bigger app wants.
   */
  onQuit?: () => void;
  /** The host's own props: the height it is given, a border, a class. */
  props?: ElementProps;
  /** Whether to draw a scrollbar. Defaults to `true`. */
  scrollbar?: boolean;
  /**
   * How a query is read. Defaults to `'literal'`.
   *
   * `'regex'` reads it as a JavaScript regular expression with the `u` flag. A
   * pattern that does not compile is reported on the status line rather than
   * thrown, and a zero-length match counts **once per line** and only on a line
   * with no other match -- so `^$` steps through the blank lines, the way it does
   * in `less`, and `a*` does not step through every column of every line.
   */
  search?: PagerSearchMode;
  /**
   * Fold a line wider than the window onto the rows below it. Defaults to `true`.
   *
   * `false` gives one row per line, cut at the window's edge, and Left and Right
   * move the view sideways by half a window.
   */
  wrap?: boolean;
}

/** One match: a line and the code-unit range on it. */
export interface PagerMatch {
  /** End of the match, exclusive. Equal to `start` for a zero-length match. */
  readonly end: number;
  /** Zero-based line. */
  readonly line: number;
  readonly start: number;
}

/** What a search found, or why it could not run. */
export interface PagerSearchResult {
  /** The pattern's own complaint, for a regular expression that did not compile. */
  readonly error?: string;
  /** In document order. */
  readonly matches: readonly PagerMatch[];
  /** Whether the search stopped at `MAX_MATCHES` rather than at the end. */
  readonly truncated: boolean;
}

/** What `createPager()` returns. */
export interface Pager {
  /** Which match is current, zero-based, or `undefined` before a search lands on one. */
  readonly current: number | undefined;
  /**
   * Lists the pager's keys on a router, for a key-help footer.
   *
   * Scoped to the pager, so they are listed while it or something inside it holds
   * the focus, which is when they work. `q` is listed only where there is an
   * `onQuit` for it to call.
   *
   * @param router - The router whose `bindings()` the footer reads.
   * @param help - A group to list them under, for an expanded footer.
   * @returns A disposer that takes them back off.
   */
  describe(router: InputRouter, help?: { group?: string }): () => void;
  /** The element, which is the thing to put in a tree. */
  readonly element: Element;
  /** The pattern's complaint, where the last query did not compile. */
  readonly error: string | undefined;
  /** How many lines the document has. */
  readonly lineCount: number;
  /** How many matches the last search found. */
  readonly matchCount: number;
  /**
   * Moves to the next match and scrolls it into view.
   *
   * The match after the current one while the current one is on screen, and
   * otherwise the first one below the top of the window -- so `n` after paging
   * away finds the next match from where the reader *is*, which is what `less`
   * does, rather than dragging them back to where they last searched.
   *
   * @returns Whether there was a match to move to.
   */
  next(): boolean;
  /**
   * Moves to the previous match: the one before the current one while it is on
   * screen, otherwise the last one above the top of the window.
   *
   * @returns Whether there was a match to move to.
   */
  previous(): boolean;
  /** The query the matches are for, or `undefined` before a search or after `clear()`. */
  readonly query: string | undefined;
  /**
   * Searches, highlights every match, and moves to the first one at or below the
   * top of the window.
   *
   * @param query - What to look for. An empty one clears the search.
   * @returns How many matches there are.
   */
  search(query: string): number;
  /** Clears the search and its highlights. */
  clear(): void;
}

/**
 * The most matches one search collects.
 *
 * A bound on memory rather than on time: `.` against a large file is a match per
 * character, and a pager that stopped responding to build a list nobody will step
 * through to the end of has answered the wrong question. The status line says the
 * count is a floor.
 */
export const MAX_MATCHES = 100_000;

/** A tab stop, which is what a terminal draws a tab to. */
const TAB = 8;

/** Lines that need no grapheme segmentation: printable ASCII and nothing else. */
const PLAIN = /^[\u0020-\u007e]*$/;

/**
 * Turns a document into the lines a pager draws.
 *
 * One trailing newline is a terminator rather than an empty last line, which is
 * how a file ends and how `less` reads one. `\r\n` is one break. What is left of
 * each line is drawable: escape sequences stripped, tabs expanded to the next
 * stop of eight, and every other control character dropped by the same rule a
 * `text` element applies.
 *
 * @param content - The document.
 * @returns One string per line.
 */
export function pagerLines(content: string | readonly string[]): string[] {
  let lines: readonly string[];
  if (typeof content === 'string') {
    const split = content.split(/\r?\n/);
    if (split.length > 1 && split.at(-1) === '') {
      split.pop();
    }
    lines = split;
  } else {
    lines = content;
  }
  return lines.map((line) => toDisplayText(expandTabs(strip(String(line)))));
}

/**
 * Expands each tab to the next multiple of eight columns.
 *
 * Measured in columns rather than characters, so a tab after a wide character
 * lands where a terminal would put it.
 *
 * @param line - One line, with no escape sequences left in it.
 * @returns The line with spaces where the tabs were.
 */
function expandTabs(line: string): string {
  if (!line.includes('\t')) {
    return line;
  }
  let out = '';
  let column = 0;
  for (const cluster of graphemes(line)) {
    if (cluster === '\t') {
      const pad = TAB - (column % TAB);
      out += ' '.repeat(pad);
      column += pad;
    } else {
      out += cluster;
      column += graphemeWidth(cluster);
    }
  }
  return out;
}

/**
 * Where a line folds at a width, as code-unit ranges.
 *
 * At the **column**, by grapheme cluster, so every character of the line is on
 * some row and in order -- which is what lets a match find its row by offset. A
 * wide character that would straddle the edge goes to the next row whole, and
 * one wider than the whole width has a row to itself and is clipped there, which
 * is what a terminal does with it too.
 *
 * @param line - One drawable line.
 * @param width - Columns per row. Anything below one is no fold at all.
 * @returns At least one range, and exactly one for an empty line.
 */
export function softWrap(line: string, width: number): Array<[number, number]> {
  const cols = Math.trunc(width);
  if (line === '' || !(cols >= 1)) {
    return [[0, line.length]];
  }
  const rows: Array<[number, number]> = [];
  if (PLAIN.test(line)) {
    for (let at = 0; at < line.length; at += cols) {
      rows.push([at, Math.min(line.length, at + cols)]);
    }
    return rows;
  }

  let start = 0;
  let offset = 0;
  let used = 0;
  for (const cluster of graphemes(line)) {
    const w = graphemeWidth(cluster);
    if (used > 0 && used + w > cols) {
      rows.push([start, offset]);
      start = offset;
      used = 0;
    }
    used += w;
    offset += cluster.length;
  }
  rows.push([start, offset]);
  return rows;
}

/**
 * Searches every line, and never throws.
 *
 * **Smart case**: a query with no capital letter in it matches either case, and
 * one with a capital matches exactly -- what `rg -S` and Vim's `smartcase` do, and
 * the reading that makes the common query (lower case, typed fast) find what the
 * reader meant. In a regular expression an escape such as `\S` or `\W` is not a
 * capital letter somebody typed, so escapes are skipped when asking.
 *
 * Literal by default, because what a reader types into a pager is usually text --
 * a function name, a path, a version -- and `.`, `(` and `[` are in all three. A
 * regular expression is an option the app turns on, and it is the app's to turn
 * on because the hazard it brings is real: a pattern that backtracks
 * catastrophically runs on this thread, and no JavaScript engine can interrupt a
 * match once it has started. What is bounded here is everything else -- a pattern
 * that does not compile is reported rather than thrown, an engine error mid-match
 * (a pattern that recurses past the stack) is caught and reported the same way, a
 * zero-length match cannot loop because `matchAll()` advances past one itself, and
 * the number of matches stops at `MAX_MATCHES`.
 *
 * @param lines - What `pagerLines()` produced.
 * @param query - What to look for.
 * @param mode - `'literal'` or `'regex'`.
 * @returns The matches in document order, or the error.
 */
export function searchLines(
  lines: readonly string[],
  query: string,
  mode: PagerSearchMode = 'literal'
): PagerSearchResult {
  if (query === '') {
    return { matches: [], truncated: false };
  }

  const regex = mode === 'regex';
  const asked = regex ? query.replaceAll(/\\./gu, '') : query;
  const flags = `gu${asked === asked.toLowerCase() ? 'i' : ''}`;
  const source = regex ? query : query.replaceAll(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

  let pattern: RegExp;
  try {
    pattern = new RegExp(source, flags);
  } catch (error) {
    return { error: (error as Error).message, matches: [], truncated: false };
  }

  const matches: PagerMatch[] = [];
  try {
    for (const [line, value] of lines.entries()) {
      let empty: number | undefined;
      let found = false;
      for (const match of value.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        if (end === start) {
          empty ??= start;
          continue;
        }
        found = true;
        matches.push({ end, line, start });
        if (matches.length >= MAX_MATCHES) {
          return { matches, truncated: true };
        }
      }
      if (!found && empty !== undefined) {
        matches.push({ end: empty, line, start: empty });
        if (matches.length >= MAX_MATCHES) {
          return { matches, truncated: true };
        }
      }
    }
  } catch (error) {
    // an engine error mid-match -- a pattern nested deeply enough to recurse
    // past the stack -- is the pattern's failure, so it is reported the way one
    // that did not compile is, rather than taking the pager down with it
    return { error: (error as Error).message, matches: [], truncated: false };
  }

  return { matches, truncated: false };
}

/**
 * Widens a range so that neither end falls inside a grapheme cluster.
 *
 * A match of `e` in a decomposed `é` ends between the base and its accent, and a
 * `text` element holding a lone combining mark measures zero columns and is not
 * drawn -- so the highlight would eat the accent. The rule `highlightRuns()`
 * already keeps for a fuzzy match.
 *
 * @param line - The line.
 * @param start - The range's start.
 * @param end - The range's end.
 * @returns The range, on cluster boundaries.
 */
function snapToClusters(line: string, start: number, end: number): [number, number] {
  if (PLAIN.test(line)) {
    return [start, end];
  }
  let a = start;
  let b = end;
  let offset = 0;
  for (const cluster of graphemes(line)) {
    const next = offset + cluster.length;
    if (offset < start && start < next) {
      a = offset;
    }
    if (offset < end && end < next) {
      b = next;
    }
    offset = next;
  }
  return [a, b];
}

/**
 * The code-unit range of a line that falls between two columns.
 *
 * For `wrap: false`, where the view starts some columns in. A wide character cut
 * by the left edge is replaced by the blanks it would have covered, so everything
 * after it stays in its column.
 *
 * @param line - The line.
 * @param from - The first column shown.
 * @param width - How many columns are shown.
 * @returns The range, and how many blanks to draw before it.
 */
function columnRange(
  line: string,
  from: number,
  width: number
): { end: number; pad: number; start: number } {
  const limit = width > 0 ? from + width : Number.POSITIVE_INFINITY;
  if (PLAIN.test(line)) {
    return {
      end: Math.min(line.length, limit),
      pad: 0,
      start: Math.min(line.length, from),
    };
  }
  let column = 0;
  let offset = 0;
  let start: number | undefined;
  let pad = 0;
  let end = line.length;
  for (const cluster of graphemes(line)) {
    const w = graphemeWidth(cluster);
    if (start === undefined) {
      if (column >= from) {
        start = offset;
      } else if (column + w > from) {
        // straddles the left edge: the part that would show is blanks
        pad = column + w - from;
      }
    }
    if (start !== undefined && column + w > limit) {
      end = offset;
      break;
    }
    column += w;
    offset += cluster.length;
  }
  return { end: Math.max(end, start ?? line.length), pad, start: start ?? line.length };
}

/** One row of the window: a line, and the part of it the row shows. */
interface Row {
  end: number;
  line: number;
  start: number;
}

/** What `onKey` and the status line read. */
interface Typing {
  draft: string;
}

/**
 * Builds a pager.
 *
 * The element is a column: the scroll box, which takes the room there is, and a
 * one-row status line under it. Give the element a height -- in props, or from
 * the box it sits in -- because a window is what it is.
 *
 * @param opts - The document and how to show it.
 * @returns The pager.
 */
export function createPager(opts: PagerOptions): Pager {
  const lines = pagerLines(opts.content);
  const wrap = opts.wrap ?? true;
  const mode = opts.search ?? 'literal';
  const numbers = opts.lineNumbers ?? false;
  /** The gutter's digits, sized once from the last line's number. */
  const digits = String(Math.max(1, lines.length)).length;
  const gutter = numbers ? digits + 1 : 0;

  /** The rows of the window, which only a fold makes differ from the lines. */
  let rows: Row[] = [];
  /** The first row of each line, for finding a match's row. */
  let firstRow: number[] = [];
  /** The columns the text was last laid out in, or `undefined` before a layout. */
  let textWidth: number | undefined;
  /** How far the view is shifted right, for `wrap: false`. */
  let column = 0;

  let query: string | undefined;
  let found: PagerSearchResult = { matches: [], truncated: false };
  /** The matches on each line, for drawing a row. */
  let byLine = new Map<number, number[]>();
  let current: number | undefined;
  /** Set while a query is being typed. */
  let typing: Typing | undefined;

  /**
   * The rows on screen, by index, so a search or a resize can redraw them.
   *
   * Filled by the scroll box's `row()` and pruned of the ones whose slot it has
   * since taken out -- a slot that has left the content box has no parent. Pruned
   * after every scroll as well as before a redraw, because paging through a long
   * document without searching would otherwise keep every row it ever built.
   */
  const live = new Map<number, Element>();

  const prune = (): void => {
    for (const [index, row] of live) {
      if (!row.parent?.parent) {
        live.delete(index);
      }
    }
  };

  const layoutRows = (): void => {
    rows = [];
    firstRow = [];
    for (const [index, line] of lines.entries()) {
      firstRow.push(rows.length);
      if (wrap && textWidth !== undefined) {
        for (const [start, end] of softWrap(line, textWidth)) {
          rows.push({ end, line: index, start });
        }
      } else {
        rows.push({ end: line.length, line: index, start: 0 });
      }
    }
  };
  layoutRows();

  /** Draws one row's cells: the gutter, then the text cut at the matches. */
  const rowContent = (index: number): Element[] => {
    const row = rows[index];
    if (!row) {
      return [];
    }
    const line = lines[row.line] ?? '';
    const out: Element[] = [];

    if (numbers) {
      const label = row.start === 0 && firstRow[row.line] === index ? String(row.line + 1) : '';
      out.push(
        text(`${label.padStart(digits)} `, {
          class: 'sigil-pager-number sigil-muted',
          'flex-shrink': 0,
          'white-space': 'nowrap',
        })
      );
    }

    let { end, start } = row;
    let pad = 0;
    if (!wrap) {
      ({ end, pad, start } = columnRange(line, column, textWidth ?? 0));
    }
    if (pad > 0) {
      out.push(piece(' '.repeat(pad), 'sigil-pager-text'));
    }

    let at = start;
    for (const which of byLine.get(row.line) ?? []) {
      const match = found.matches[which];
      if (!match || match.end <= start || match.start >= end || match.end === match.start) {
        continue;
      }
      const [from, to] = snapToClusters(
        line,
        Math.max(start, match.start),
        Math.min(end, match.end)
      );
      if (from < at) {
        continue;
      }
      if (from > at) {
        out.push(piece(line.slice(at, from), 'sigil-pager-text'));
      }
      out.push(
        piece(
          line.slice(from, to),
          which === current ? 'sigil-pager-match is-current sigil-accent' : 'sigil-pager-match'
        )
      );
      at = to;
    }
    if (at < end) {
      out.push(piece(line.slice(at, end), 'sigil-pager-text'));
    }
    return out;
  };

  const refresh = (): void => {
    prune();
    for (const [index, row] of live) {
      empty(row);
      row.append(...rowContent(index));
    }
  };

  const scroll = ScrollBox({
    // both after the scroll box has re-windowed, and both called only once
    // something has laid the tree out -- so the closures they name, declared
    // below, exist by then
    onResize: (control) => resized(control),
    onScroll: () => scrolled(),
    props: {
      // the pager's host is the focus stop; two of them for one widget would be
      // a Tab that seems to do nothing
      focusable: false,
      'flex-basis': 0,
      'flex-grow': 1,
      'min-height': 0,
    },
    rows: {
      // read on every window, which is the line `ScrollRows.count` draws: a fold
      // at a new width is a new count, and the next sync picks it up
      get count() {
        return rows.length;
      },
      height: 1,
      row: (index: number) => {
        const row = box(
          { class: 'sigil-pager-line', 'flex-direction': 'row' },
          ...rowContent(index)
        );
        live.set(index, row);
        return row;
      },
    },
    scrollbar: opts.scrollbar ?? true,
  });
  const { viewport } = scrollControl(scroll)!;

  // the message gives way to the position rather than the other way round: a
  // long query is cut at the edge, and where the reader is stays readable
  const left = box({
    class: 'sigil-pager-message',
    'flex-direction': 'row',
    'flex-grow': 1,
    'min-width': 0,
    overflow: 'hidden',
  });
  const right = text('', {
    class: 'sigil-pager-position sigil-muted',
    'flex-shrink': 0,
    'white-space': 'nowrap',
  });
  const status = box(
    {
      class: 'sigil-pager-status',
      'column-gap': 1,
      'flex-direction': 'row',
      'flex-shrink': 0,
      height: 1,
    },
    left,
    right
  );

  const host = box({
    focusable: true,
    ...opts.props,
    // after the spread, for the reason `ScrollBox` gives: the status line is
    // placed against it
    'flex-direction': 'column',
  });
  host.addClass('sigil-pager');
  host.append(scroll, status);

  /** The viewport's height in rows, or zero before anything laid it out. */
  const view = (): number => (viewport.content ?? viewport.box)?.height ?? 0;
  const top = (): number => viewport.scroll?.y ?? 0;
  /** The furthest the window can go, which is nowhere before a layout. */
  const maxTop = (): number => {
    const height = view();
    return height > 0 ? Math.max(0, rows.length - height) : 0;
  };
  const goTo = (y: number): void => {
    viewport.scrollTo(0, Math.max(0, Math.min(maxTop(), Math.trunc(y))));
  };

  const drawStatus = (): void => {
    empty(left);
    const say = (value: string, cls: string): void => {
      left.append(text(value, { class: cls, 'flex-shrink': 0, 'white-space': 'nowrap' }));
    };

    if (typing) {
      say(`/${typing.draft}`, 'sigil-pager-query');
      say(' ', 'sigil-caret');
    } else if (query !== undefined) {
      if (found.error !== undefined) {
        say(__`Invalid pattern: ${query}`, 'sigil-pager-error sigil-error');
      } else if (found.matches.length === 0) {
        say(__`No matches for ${query}`, 'sigil-pager-error sigil-error');
      } else {
        const total = found.truncated ? `${found.matches.length}+` : String(found.matches.length);
        say(`/${query}  `, 'sigil-pager-query sigil-muted');
        say(__`match ${(current ?? 0) + 1} of ${total}`, 'sigil-pager-count');
      }
    }

    const height = view();
    const percent =
      rows.length === 0 || height === 0
        ? 100
        : Math.min(100, Math.round(((top() + height) / rows.length) * 100));
    right.setText(height === 0 ? '' : `${percent}%`);
  };

  /** Puts a match on screen, moving only where it is not already. */
  const reveal = (which: number): void => {
    const match = found.matches[which];
    if (!match) {
      return;
    }
    const row = rowOf(match);
    const height = view();
    if (height === 0 || row < top() || row >= top() + height) {
      // to the top of the window, which is where `less` puts it: what follows a
      // match is what the reader went looking for. A folded line is shown from
      // its first row where that still leaves the match on screen, so a match
      // on a line's third row does not arrive with the start of its sentence
      // scrolled off above it
      const first = firstRow[match.line] ?? row;
      goTo(height > 0 && row - first < height ? first : row);
    }
    if (!wrap && textWidth !== undefined && textWidth > 0) {
      const line = lines[match.line] ?? '';
      const from = stringWidth(line.slice(0, match.start));
      const to = from + Math.max(1, stringWidth(line.slice(match.start, match.end)));
      if (from < column || to > column + textWidth) {
        column = Math.max(0, from - Math.floor(textWidth / 2));
      }
    }
  };

  const rowOf = (match: PagerMatch): number => {
    let row = firstRow[match.line] ?? 0;
    while (rows[row + 1]?.line === match.line && (rows[row + 1]?.start ?? 0) <= match.start) {
      row++;
    }
    return row;
  };

  /** Whether a match's row is inside the window. */
  const onScreen = (which: number | undefined): boolean => {
    const match = which === undefined ? undefined : found.matches[which];
    if (!match) {
      return false;
    }
    const row = rowOf(match);
    return row >= top() && row < top() + Math.max(1, view());
  };

  const step = (forward: boolean): boolean => {
    const count = found.matches.length;
    if (count === 0) {
      return false;
    }
    let next: number;
    if (current !== undefined && onScreen(current)) {
      next = (current + (forward ? 1 : count - 1)) % count;
    } else {
      const at = top();
      const index = forward
        ? found.matches.findIndex((m) => rowOf(m) >= at)
        : found.matches.findLastIndex((m) => rowOf(m) < at);
      next = index === -1 ? (forward ? 0 : count - 1) : index;
    }
    current = next;
    reveal(next);
    refresh();
    drawStatus();
    return true;
  };

  const run = (value: string): number => {
    if (value === '') {
      clear();
      return 0;
    }
    query = value;
    found = searchLines(lines, value, mode);
    byLine = new Map();
    for (const [index, match] of found.matches.entries()) {
      const list = byLine.get(match.line);
      if (list) {
        list.push(index);
      } else {
        byLine.set(match.line, [index]);
      }
    }
    current = undefined;
    if (found.matches.length > 0) {
      const at = top();
      const first = found.matches.findIndex((m) => rowOf(m) >= at);
      current = first === -1 ? 0 : first;
      reveal(current);
    }
    refresh();
    drawStatus();
    return found.matches.length;
  };

  const clear = (): void => {
    query = undefined;
    found = { matches: [], truncated: false };
    byLine = new Map();
    current = undefined;
    refresh();
    drawStatus();
  };

  /** The scroll box moved the offset and has re-windowed for it. */
  const scrolled = (): void => {
    // so what it took out is known, which is the one moment the map can be pruned
    // without being told which rows went
    prune();
    drawStatus();
  };

  /**
   * The viewport has a new size, and the scroll box has re-windowed for it.
   *
   * For the **old** count, where the width moved and the lines fold differently:
   * the box cannot know a fold is a new count, so it is told, with `resync()`,
   * once the refold has happened. That call is the whole of the ordering -- the
   * refold, the redraw and the re-anchor first, then the resync, because it reads
   * the count the refold produced.
   */
  const resized = (control: ScrollControl): boolean => {
    const size = viewport.content ?? viewport.box;
    const width = Math.max(0, (size?.width ?? 0) - gutter);
    let changed = false;
    if (width !== textWidth) {
      // the row the window starts on, as a line and an offset into it, so that a
      // fold at a new width keeps the reader on the text they were reading rather
      // than on a row number that now means something else
      const anchor = rows[Math.min(top(), rows.length - 1)];
      textWidth = width;
      if (wrap) {
        layoutRows();
      }
      refresh();
      changed = true;
      if (anchor) {
        let row = firstRow[anchor.line] ?? 0;
        while (rows[row + 1]?.line === anchor.line && (rows[row + 1]?.start ?? 0) <= anchor.start) {
          row++;
        }
        goTo(row);
      }
    } else if (top() > maxTop()) {
      goTo(maxTop());
    }
    // asked even where the re-anchor scrolled, which re-windowed already: a
    // re-anchor that lands on the row the window was on writes no offset, and the
    // spacer below would go on measuring the old fold
    const synced = control.resync();
    prune();
    drawStatus();
    return changed || synced;
  };

  const page = (): number => Math.max(1, view() - 1);
  const half = (): number => Math.max(1, Math.floor(view() / 2));

  host.onKey = (event: KeyEvent): void => {
    const { key } = event;
    const plain = !key.ctrl && !key.meta;

    if (typing) {
      if (key.name === 'escape') {
        typing = undefined;
      } else if (key.name === 'enter') {
        const value = typing.draft;
        typing = undefined;
        // an empty Enter repeats the last search, which is `less`'s `/` then Enter
        run(value === '' ? (query ?? '') : value);
      } else if (key.name === 'backspace') {
        if (typing.draft === '') {
          typing = undefined;
        } else {
          typing.draft = graphemes(typing.draft).slice(0, -1).join('');
        }
      } else if (plain && key.name === 'space') {
        typing.draft += ' ';
      } else if (plain && [...key.name].length === 1) {
        typing.draft += key.name;
      } else {
        // a key the field has no use for. Not claimed, so Tab still moves the
        // focus and an app's own keys still reach it
        return;
      }
      drawStatus();
      event.stop();
      return;
    }

    if (!plain) {
      return;
    }

    let by: number | undefined;
    switch (key.name) {
      case 'down':
      case 'j':
      case 'enter': {
        by = 1;
        break;
      }
      case 'up':
      case 'k': {
        by = -1;
        break;
      }
      case 'space':
      case 'f':
      case 'pagedown': {
        by = page();
        break;
      }
      case 'b':
      case 'pageup': {
        by = -page();
        break;
      }
      case 'd': {
        by = half();
        break;
      }
      case 'u': {
        by = -half();
        break;
      }
      case 'g':
      case 'home':
      case '<': {
        by = -top();
        break;
      }
      case 'G':
      case 'end':
      case '>': {
        by = maxTop() - top();
        break;
      }
      case 'left':
      case 'right': {
        if (wrap) {
          return;
        }
        const shift = Math.max(1, Math.floor((textWidth ?? 2) / 2));
        const next = Math.max(0, column + (key.name === 'left' ? -shift : shift));
        if (next !== column) {
          column = next;
          refresh();
        }
        event.stop();
        return;
      }
      case '/': {
        typing = { draft: '' };
        drawStatus();
        event.stop();
        return;
      }
      case 'n':
      case 'N': {
        if (query === undefined) {
          return;
        }
        step(key.name === 'n');
        event.stop();
        return;
      }
      case 'escape': {
        if (query === undefined) {
          return;
        }
        clear();
        event.stop();
        return;
      }
      case 'q': {
        if (!opts.onQuit) {
          return;
        }
        event.stop();
        opts.onQuit();
        return;
      }
      default: {
        return;
      }
    }

    // the scroll box's own rule: a key is claimed only where there is somewhere
    // to go, so a document that fits hands Space on to whatever is around it --
    // and is claimed even where the move is zero, so `g` at the top is still ours
    if (maxTop() <= 0) {
      return;
    }
    goTo(top() + by);
    event.stop();
  };

  drawStatus();

  const pager: Pager = {
    clear,

    get current() {
      return current;
    },

    describe(router: InputRouter, help: { group?: string } = {}): () => void {
      const group = help.group;
      const list: Array<[string, string, number]> = [
        ['up', __`scroll`, 0],
        ['down', __`scroll`, 0],
        ['space', __`page down`, 1],
        ['b', __`page up`, 1],
        ['d', __`half page down`, 0],
        ['u', __`half page up`, 0],
        ['g', __`top`, 0],
        ['G', __`bottom`, 0],
        ['/', __`search`, 2],
        ['n', __`next match`, 1],
        ['N', __`previous match`, 1],
      ];
      if (!wrap) {
        list.push(['left', __`scroll sideways`, 0], ['right', __`scroll sideways`, 0]);
      }
      if (opts.onQuit) {
        list.push(['q', __`quit`, 3]);
      }
      const off = list.map(([keys, description, priority]) =>
        router.describe(keys, { description, group, priority, scope: host })
      );
      return () => {
        for (const dispose of off) {
          dispose();
        }
      };
    },

    element: host,

    get error() {
      return found.error;
    },

    lineCount: lines.length,

    get matchCount() {
      return found.matches.length;
    },

    next: () => step(true),

    previous: () => step(false),

    get query() {
      return query;
    },

    search: run,
  };
  return pager;
}

/**
 * Takes every child off an element.
 *
 * Backwards, so that removing at `i` cannot move anything still to be looked at:
 * `children` is the live array, which is the reason the scroll box's own prune
 * loop runs backwards too.
 */
function empty(element: Element): void {
  for (let i = element.children.length - 1; i >= 0; i--) {
    element.removeChild(element.children[i]!);
  }
}

/** One run of a row's text, which never wraps: the row is already cut to fit. */
function piece(value: string, cls: string): Element {
  return text(value, { class: cls, 'flex-shrink': 0, 'white-space': 'nowrap' });
}

/** What `page()` takes beyond a pager's own options. */
export interface PageOptions extends Omit<PagerOptions, 'content' | 'onQuit'>, StyledOptions {
  /**
   * Track the mouse, so the wheel scrolls and the thumb drags. Defaults to `false`.
   *
   * Off because a terminal reporting the mouse stops doing its own selection, and
   * copying a line out of a document is one of the things a pager is for. `less`
   * makes the same call and asks for `--mouse`.
   */
  mouse?: boolean;
  /**
   * Milliseconds between frames. Defaults to the renderer's thirty a second.
   *
   * Worth naming in a test, for the reason `MountOptions.frameMs` gives.
   */
  frameMs?: number;
  /** Where keys come from. Defaults to the terminal's input. */
  stdin?: InputStream;
  /** The terminal to take over. Defaults to the process's. */
  terminal?: Terminal;
}

/**
 * Pages a document on the whole screen until `q`, the way `gum pager` does.
 *
 * The alternate screen, so the log the reader was looking at is exactly where it
 * was afterwards. `q` and Ctrl-C both resolve it, since leaving is the only thing
 * either can mean here.
 *
 * Where there is no terminal on both sides -- output piped, or a stdin nobody is
 * typing into -- the document is **written out as it was given** and the promise
 * resolves, which is what `less` does when its output is not a terminal: the
 * reader is somebody's `grep`, and what they want is the text.
 *
 * @param content - The document.
 * @param opts - How to show it, and where.
 * @returns Settled when the reader leaves.
 */
export function page(content: string | readonly string[], opts: PageOptions = {}): Promise<void> {
  const terminal = opts.terminal ?? defaultTerminal;
  const stdin = opts.stdin ?? terminal.stdin;

  if (!canReadKeys({ stdin, terminal })) {
    const body = typeof content === 'string' ? content : content.join('\n');
    if (body !== '') {
      terminal.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
    }
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let done = false;
    let pager: Pager | undefined;

    const backend = createFullscreenCanvas({ terminal });
    const view = render(
      () => {
        pager = createPager({
          ...opts,
          content,
          onQuit: () => finish(),
          props: { ...opts.props, 'flex-grow': 1 },
        });
        return box({ 'flex-direction': 'column', height: '100%' }, pager.element);
      },
      {
        backend,
        cascade: themedCascade(opts),
        colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
        colorScheme: opts.colorScheme,
        frameMs: opts.frameMs,
        onError: (error) => finish(error),
        reducedMotion: opts.reducedMotion,
        terminal,
      }
    );
    const input = createInput({
      root: view.root,
      stdin,
      terminal,
      ...(opts.mouse ? { mouse: { surface: view.backend } } : {}),
    });

    function finish(error?: unknown): void {
      if (done) {
        return;
      }
      done = true;
      input.stop();
      view.dispose();
      if (error === undefined) {
        resolve();
      } else {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    input.bind((event) => {
      if (isAbort(event.key)) {
        event.stop();
        finish();
      }
    });
    input.onEnd((error) => finish(error));
    input.focus.focus(pager?.element);
  });
}
