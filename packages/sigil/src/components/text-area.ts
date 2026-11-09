/**
 * A text area: several lines of editable text, as an element a tree can hold.
 *
 * The `multiline()` prompt's editor without the prompt around it, the way
 * `TextField()` is `text()`'s -- for a commit message box, a notes pane, or an
 * editor a full-screen app is built around. It is built from what the prompt is
 * built from: `editing.ts` for every edit, `layoutField()` for where each cluster
 * of a line goes, `offsetIn()` for the column a vertical move aims at, and the
 * prompt's `HighlightSpan` and token roles for colour.
 *
 * ```js
 * import { TextArea } from '@ttylabs/sigil/components/text-area';
 * import { State } from '@ttylabs/sigil/signals';
 *
 * const message = new State('');
 * box(
 *   { 'flex-direction': 'column' },
 *   TextArea({ value: message, lineNumbers: true, placeholder: 'Commit message' })
 * );
 * ```
 *
 * **The value is an array of lines, and only the lines on screen are laid out
 * and painted.** An edit touches the lines it spans and no others, a frame lays
 * out as many lines as the area is tall, and a line is one row -- the area
 * scrolls sideways rather than wrapping -- so a fifty-thousand-line buffer
 * scrolls the way a ten-line one does. What is still as long as the value is
 * joining it into a string, which happens only when something reads it: a
 * `State` handed in, `onChange`, or `highlight`.
 *
 * Enter is a newline and a bracketed paste keeps its line breaks. Left and Right
 * move by a character and with Ctrl or Alt by a word, Up and Down by a line
 * keeping the column they aim for, PageUp and PageDown by a screen, Home and End
 * (Ctrl-A, Ctrl-E) to the ends of the line and with Ctrl to the ends of the
 * value. Backspace and Delete take a character or with Ctrl or Alt a word,
 * Ctrl-W and Alt-D a word, Ctrl-U and Ctrl-K the line before or after the caret.
 * Shift with any of the moves selects, and so does a drag; typing or deleting
 * over a selection replaces it. With `onCopy`, Ctrl-Y copies the selection and
 * Ctrl-X cuts it. Tab is the focus ring's unless `tab` says what it types, and
 * Shift-Tab and Escape are never the area's. `AGENTS.md` has the reasons under
 * "A text area".
 */

import { selectedStyle } from '../canvas/index.js';
import {
  box,
  cellStyle,
  type Element,
  type ElementPropsWithout,
  raw,
  type RawPainter,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { MouseEvent } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { stringWidth } from '../width/index.js';
import {
  boundary,
  deleteAfter,
  deleteBefore,
  deleteRange,
  type Edit,
  insertAt,
  pastedBlock,
  typedText,
  wordAfter,
  wordBefore,
} from './editing.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import {
  type FieldRow,
  type HighlightSpan,
  layoutField,
  offsetIn,
  TOKEN_ROLE,
  tokensOf,
} from './prompt.js';
import { wheelStep } from './scroll-box.js';

export interface TextAreaProps {
  /**
   * Whether the area refuses input.
   *
   * A disabled area is out of the focus ring, takes no key, no paste and no
   * press, and is drawn in the muted role. A `State<boolean>` is read live.
   * Defaults to `false`.
   */
  disabled?: boolean | State<boolean>;
  /**
   * A mark drawn at the start of every row, after the line number when there is
   * one -- `'│ '` or `'> '`. Drawn muted, and never part of the value.
   */
  gutter?: string;
  /**
   * Says which stretches of the value are which tokens, for syntax highlighting.
   *
   * The `multiline()` prompt's hook, unchanged: called with the whole value
   * whenever it changes and never when only the caret moves, with offsets into
   * the whole value so a comment over several lines is one span. A token becomes
   * the class `sigil-token-<token>`, and the seven names in `TOKEN_ROLE` also
   * draw in a role. Spans are clipped to the value; where two cover one
   * character the later one wins.
   */
  highlight?: (value: string) => readonly HighlightSpan[];
  /**
   * Numbers each line down the left. Two digits at the least, so the area does
   * not move a column right at the tenth line; the caret's line is the one not
   * muted.
   */
  lineNumbers?: boolean;
  /** Called with the value after every edit that changed it. Not called for a write the app made. */
  onChange?: (value: string) => void;
  /**
   * Called with the selected text on a copy or a cut, which is where an app puts
   * it on the clipboard -- `copyToClipboard(app.terminal, text)`.
   *
   * Given, Ctrl-Y copies the selection and Ctrl-X cuts it. Absent, neither key
   * is the area's: a cut with nowhere for the text to go would only delete it.
   */
  onCopy?: (text: string) => void;
  /** Shown, muted, while the value is empty. */
  placeholder?: string;
  /** The host box's own props: a class, a margin, a `flex-grow`. Geometry only, never a colour. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey' | 'onMouse' | 'onPaste'>;
  /**
   * The most rows the area asks for before it scrolls, growing into it as lines
   * are added. Ten by default. A `flex-grow` or a `height` in `props` gives it
   * more, and a column too short for it takes rows away.
   */
  rows?: number;
  /**
   * What Tab types -- `'  '`, or `'\t'`, which draws as one column the way it
   * does everywhere else in this library.
   *
   * Absent, Tab is not the area's and moves the focus on, which is what a form
   * needs. Shift-Tab is never the area's, so an area that takes Tab can still be
   * left.
   */
  tab?: string;
  /**
   * The value.
   *
   * A string is where it starts. A `State<string>` is the value itself: the keys
   * write it, and an app that writes it replaces what the area holds, with the
   * caret moved to the end. Line endings are normalized to `\n`. Defaults to
   * empty.
   */
  value?: string | State<string>;
  /**
   * How many columns the area takes, gutter included. Defaults to what the
   * layout gives it -- the whole width in a column, and forty columns of text in
   * a row, shrinking to its share where the row is short.
   */
  width?: number;
}

/** A place in the value: a line, and an offset into that line on a cluster boundary. */
interface Place {
  col: number;
  line: number;
}

/** What the layers of one frame read, worked out once for the room the area has. */
interface Frame {
  /** Where the caret is drawn, or nothing while it is scrolled out of view. */
  caret: { row: number; text: string; x: number } | undefined;
  /** The row the caret's line is on, for the gutter's one unmuted number. */
  active: number | undefined;
  /** The columns of the numbers, or zero. */
  digits: number;
  /** The line number each row draws, or nothing past the last line. */
  numbers: (number | undefined)[];
  /** The rows on screen, their cells moved left by the sideways scroll. */
  rows: FieldRow[];
  /** The columns of each row that are selected, and whether a line break is. */
  selection: { row: number; width: number; x: number }[];
  /** The token each cell is, indexed by the cell's `at`, which counts cells on screen. */
  tokens: (string | undefined)[];
}

/** How wide the text is in a row when nothing says, which is what a `measure` has to answer. */
const COLUMNS = 40;

/** A control character, which a gutter mark must not hold: the grid throws on one. */
const CONTROL = /\p{Cc}/u;

/** Whether a stretch of a line is whitespace and nothing else, which a word never is. */
const BLANK = /^\s*$/u;

/** Orders two places. */
function before(a: Place, b: Place): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

/** Whether two places are one. */
function same(a: Place, b: Place): boolean {
  return a.line === b.line && a.col === b.col;
}

/**
 * Builds a multi-line text area.
 *
 * @param props - The value, the callbacks, and the host's props.
 * @returns The host element, which is the focusable one.
 */
export function TextArea(props: TextAreaProps = {}): Element {
  refuseOwnedHooks('TextArea', props.props, ['onKey', 'onMouse', 'onPaste', 'onFocusChange']);
  if (
    props.value !== undefined &&
    typeof props.value !== 'string' &&
    !(props.value instanceof State)
  ) {
    throw new TypeError(__`Expected a text area value to be a string or a State`);
  }
  if (
    props.disabled !== undefined &&
    typeof props.disabled !== 'boolean' &&
    !(props.disabled instanceof State)
  ) {
    throw new TypeError(__`Expected text area disabled to be a boolean or a State`);
  }
  if (props.placeholder !== undefined && typeof props.placeholder !== 'string') {
    throw new TypeError(__`Expected a text area placeholder to be a string`);
  }
  // a mark is drawn on every row, and the grid throws on a control character
  if (
    props.gutter !== undefined &&
    (typeof props.gutter !== 'string' || CONTROL.test(props.gutter))
  ) {
    throw new TypeError(__`Expected a text area gutter to be a string with no control character`);
  }
  // what Tab types goes into the value, so it keeps to what a paste is allowed
  // to leave there: a tab, and no line break or other control character
  if (
    props.tab !== undefined &&
    (typeof props.tab !== 'string' ||
      props.tab === '' ||
      pastedBlock(props.tab) !== props.tab ||
      props.tab.includes('\n'))
  ) {
    throw new TypeError(__`Expected a text area tab to be a non-empty string with no line break`);
  }
  if (props.rows !== undefined && !(Number.isInteger(props.rows) && props.rows > 0)) {
    throw new TypeError(__`Expected text area rows to be a positive whole number`);
  }
  if (props.width !== undefined && !(Number.isInteger(props.width) && props.width > 0)) {
    throw new TypeError(__`Expected a text area width to be a positive whole number`);
  }
  if (props.highlight !== undefined && typeof props.highlight !== 'function') {
    throw new TypeError(__`Expected a text area highlight to be a function`);
  }

  const value = props.value instanceof State ? props.value : new State(props.value ?? '');
  const disabled =
    props.disabled instanceof State ? props.disabled : new State(props.disabled ?? false);
  const { highlight, onChange, onCopy, tab } = props;
  const placeholder = (props.placeholder ?? '').split('\n');
  const mark = props.gutter ?? '';
  const numbered = props.lineNumbers === true;
  const cap = props.rows ?? 10;
  /**
   * Whether anything can read the value as a string. Nothing else costs as much
   * as the value is long, so a bare area never pays for it.
   */
  const reads = props.value instanceof State || onChange !== undefined;

  /** The value, one entry per line. Never empty: an empty value is one empty line. */
  let lines: string[] = [''];
  let caret: Place = { col: 0, line: 0 };
  /** Where a selection began, which the caret is the other end of. */
  let anchor: Place | undefined;
  /**
   * The column a run of vertical moves is aiming for, which survives a short
   * line and a wide cluster -- the prompt's rule, and the reason it is a column
   * rather than an offset.
   */
  let goal: number | undefined;
  /** The first line on screen. */
  let top = 0;
  /** How many columns of every line are scrolled off the left. */
  let left = 0;
  /** Whether the next frame brings the caret into view; the wheel is what clears it. */
  let follow = true;
  /** Counts every change a frame would draw differently, so a frame is worked out once. */
  let version = 0;
  /** The value as of the last time the two agreed, so a write the area did not make is told apart. */
  let seen = value.get();
  /** The value as one string, while it is still the one the lines say. */
  let joined: string | undefined;
  /** Whether a press is being dragged into a selection. */
  let dragging = false;
  /** The room of the last frame, which the page keys and the wheel move by. */
  let room = { height: cap, width: props.width ?? COLUMNS };
  /**
   * What `highlight` said, as the spans that touch each line, in the order they
   * were given so that the later one still wins. Kept per line so a frame asks
   * about the lines it draws rather than walking every span there is.
   */
  let spans: (HighlightSpan[] | undefined)[] = [];
  /** The offset of each line's first character in the value, for reading the spans. */
  let starts: number[] = [];

  const step = wheelStep();

  /** The value as a string, joined only when something asks. */
  const text = (): string => (joined ??= lines.join('\n'));

  /** Replaces everything the area holds, which is what a write the app made does. */
  function load(next: string): void {
    lines = pastedBlock(next).split('\n');
    joined = undefined;
    const last = lines.length - 1;
    // the end, which is where a typist would be -- `TextField`'s rule, and the
    // prompt's: the new value carries nothing that says where the caret belongs
    caret = { col: lines[last].length, line: last };
    anchor = undefined;
    goal = undefined;
    follow = true;
  }

  load(seen);

  // ---- the frame -------------------------------------------------------------

  let memo: { frame: Frame; key: string } | undefined;

  /**
   * Works out what is on screen, for the room the text layer was given.
   *
   * At paint rather than at the edit, because the room is the layout's and a
   * frame is when it is known: this is where the caret is brought into view, and
   * it lays out exactly the lines that fit and nothing else. Every layer asks,
   * and the first to ask pays.
   */
  function frame(): Frame {
    const area = textLayer.content ?? textLayer.box;
    const width = Math.max(1, area?.width ?? room.width);
    const height = Math.max(1, area?.height ?? room.height);
    const key = `${version}|${width}|${height}`;
    if (memo?.key === key) {
      return memo.frame;
    }
    if (width !== room.width || height !== room.height) {
      // a new size can put the caret off the edge, so it is looked for again
      follow = true;
      room = { height, width };
    }

    const hinted = hinting();
    const shown = hinted ? placeholder : lines;

    if (!hinted) {
      reveal();
    }
    top = Math.max(0, Math.min(top, shown.length - height));
    left = Math.max(0, left);

    const [from, to] = range() ?? [undefined, undefined];
    const result: Frame = {
      active: undefined,
      caret: undefined,
      digits: numbered ? Math.max(2, String(lines.length).length) : 0,
      numbers: [],
      rows: [],
      selection: [],
      tokens: [],
    };

    for (let row = 0; row < height && top + row < shown.length; row++) {
      const at = top + row;
      const line = shown[at];
      const mine = !hinted && at === caret.line;
      const laid = layoutField(line, mine ? caret.col : 0, Number.POSITIVE_INFINITY);
      const built = laid.rows[0];
      const cells: FieldRow['cells'] = [];

      for (const cell of built.cells) {
        // a cluster cut by either edge is left out whole rather than drawn in
        // half, which the grid could not do anyway: it carries a write on one
        // half of a wide cluster to the other
        if (cell.width === 0 || cell.x < left || cell.x + cell.width > left + width) {
          continue;
        }
        result.tokens.push(hinted ? undefined : tokenAt(at, cell.at));
        cells.push({ ...cell, at: result.tokens.length - 1, x: cell.x - left });
      }
      result.rows.push({ cells, start: 0, width: built.width - left });
      result.numbers.push(at + 1);

      if (mine || (hinted && at === 0)) {
        result.active = row;
        const x = laid.caret.x - left;
        // while something is selected the selection is what is drawn, and the
        // caret is one end of it. A block caret beside a reversed run reads as
        // one more cell selected, and inside one as one fewer, so with both
        // drawn the picture was a cell out whichever way the selection ran
        if (x >= 0 && x < width && from === undefined) {
          result.caret = { row, text: laid.caret.text, x };
        }
      }

      if (from !== undefined && to !== undefined && at >= from.line && at <= to.line) {
        const xOf = (col: number): number => {
          for (const cell of built.cells) {
            if (cell.at >= col) {
              return cell.x;
            }
          }
          return built.width;
        };
        const start = at === from.line ? xOf(from.col) : 0;
        // a selected line break is a column of its own after the line, which is
        // what says a selection runs on to the next line rather than stopping
        const end = at === to.line ? xOf(to.col) : built.width + 1;
        const x = Math.max(start, left) - left;
        const w = Math.min(end, left + width) - left - x;
        if (w > 0) {
          result.selection.push({ row, width: w, x });
        }
      }
    }

    memo = { frame: result, key };
    return result;
  }

  /**
   * Scrolls the caret into the room of the last frame, if a move asked for it.
   *
   * A function of its own because the wheel asks too: a key that moved the caret
   * and a notch that arrives before the frame that would have followed it must
   * scroll from where that frame would have put the view, not from where the
   * view was before the key.
   */
  function reveal(): void {
    if (!follow) {
      return;
    }
    follow = false;
    if (caret.line < top) {
      top = caret.line;
    } else if (caret.line >= top + room.height) {
      top = caret.line - room.height + 1;
    }
    const laid = layoutField(lines[caret.line], caret.col, Number.POSITIVE_INFINITY);
    const x = laid.caret.x;
    const end = x + Math.max(1, stringWidth(laid.caret.text));
    if (x < left) {
      left = x;
    } else if (end > left + room.width) {
      left = end - room.width;
    }
  }

  /** The token the cluster at an offset of a line was highlighted as. */
  function tokenAt(line: number, col: number): string | undefined {
    const touching = spans[line];
    if (touching === undefined) {
      return undefined;
    }
    const at = starts[line] + col;
    let token: string | undefined;
    for (const span of touching) {
      if (at >= span.start && at < span.end) {
        token = span.token;
      }
    }
    return token;
  }

  // ---- the layers ------------------------------------------------------------

  /** Paints the cells of a frame that one layer owns, at the text layer's box. */
  function paintCells(
    painter: RawPainter,
    element: Element,
    owns: (token: string | undefined) => boolean
  ): void {
    const area = textLayer.content ?? textLayer.box;
    if (!area) {
      return;
    }
    const { rows, tokens } = frame();
    const style = cellStyle(element.style);
    for (const [row, built] of rows.entries()) {
      for (const cell of built.cells) {
        if (owns(tokens[cell.at])) {
          painter.text(area.x + cell.x, area.y + row, cell.text, style);
        }
      }
    }
  }

  /**
   * The text: every cell no token claimed, and the one layer in flow, so it is
   * what the area measures as.
   *
   * It asks for its lines up to `rows`, and for forty columns where nothing
   * stretches it. Never for the widest line: that is a walk over every line on
   * every edit, and a width that follows the content is one that reflows a row
   * of panes on every key.
   */
  const textLayer: Element = raw(
    {
      drawsText: true,
      measure: () => {
        const count = lines.length === 1 && lines[0] === '' ? placeholder.length : lines.length;
        const height = Math.min(count, cap);
        return { height, minHeight: 0, minWidth: 0, width: COLUMNS };
      },
      paint: (painter, _area, element) => {
        paintCells(painter, element, (token) => token === undefined);
      },
    },
    { class: 'sigil-text-area-text', 'flex-grow': 1 }
  );

  /** A layer per token, made the first time `highlight` names it -- the prompt's rule. */
  const tokenLayers = new Map<string, Element>();

  function tokenLayer(token: string): Element {
    const role = TOKEN_ROLE.get(token);
    return raw(
      {
        drawsText: true,
        measure: () => ({ height: 0, width: 0 }),
        paint: (painter, _area, element) => {
          paintCells(painter, element, (owner) => owner === token);
        },
      },
      {
        bottom: 0,
        class: `sigil-token sigil-token-${token}${role ? ` ${role}` : ''}`,
        left: 0,
        position: 'absolute',
        right: 0,
        top: 0,
      }
    );
  }

  /**
   * The caret: the cluster it marks, painted again in the focus role while the
   * area has the focus, which is what "Focus on a control" settles for every
   * widget. Unfocused it is the same cell in the text's own style, so a form of
   * several areas shows one caret.
   */
  const caretLayer = raw(
    {
      drawsText: true,
      measure: () => ({ height: 0, width: 0 }),
      paint: (painter, _area, element) => {
        const area = textLayer.content ?? textLayer.box;
        const at = frame().caret;
        if (!area || !at) {
          return;
        }
        painter.text(area.x + at.x, area.y + at.row, at.text, cellStyle(element.style));
      },
    },
    {
      bottom: 0,
      class: 'sigil-text-area-caret',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    }
  );

  /**
   * The selection, as the screen selection draws one: reverse video toggled over
   * cells already painted, by `selectedStyle()`, so the two selections an app can
   * show look alike and neither is a declaration in the framework sheet. Nothing
   * at colour level 0, where the seven attributes go -- the rule both carets and
   * the screen selection already keep -- and what is selected still copies.
   *
   * `drawsText` although it draws no character: it is absolute over the text, so
   * it covers the text's cells, and a `raw` that does not say so makes every cell
   * it covers one a screen selection cannot copy.
   */
  const selectionLayer = raw(
    {
      drawsText: true,
      measure: () => ({ height: 0, width: 0 }),
      paint: (painter, _area, element) => {
        const area = textLayer.content ?? textLayer.box;
        if (!area || element.colorLevel === 0) {
          return;
        }
        for (const run of frame().selection) {
          painter.overlay(area.x + run.x, area.y + run.row, run.width, selectedStyle);
        }
      },
    },
    {
      bottom: 0,
      class: 'sigil-text-area-selection',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    }
  );

  const body = box(
    {
      class: 'sigil-text-area-body',
      'flex-direction': 'column',
      'flex-grow': 1,
      position: 'relative',
    },
    textLayer,
    caretLayer,
    selectionLayer
  );

  /** The columns the gutter takes: the numbers and a gap, then the mark. */
  const gutterColumns = (): number =>
    (numbered ? Math.max(2, String(lines.length).length) + 1 : 0) + stringWidth(mark);

  /** Paints a gutter row's number, right-aligned in the digits. */
  function paintNumber(
    painter: RawPainter,
    x: number,
    y: number,
    digits: number,
    n: number | undefined,
    element: Element
  ): void {
    if (n !== undefined && digits > 0) {
      painter.text(x, y, String(n).padStart(digits), cellStyle(element.style));
    }
  }

  /**
   * The gutter, muted, which never draws text: copying lines out of a numbered
   * area and getting the numbers is what every editor's gutter exists to avoid.
   * The caret's line is a second layer, because one element resolves one style.
   */
  const gutterLayer = raw(
    {
      measure: () => ({ height: 0, minWidth: gutterColumns(), width: gutterColumns() }),
      paint: (painter, area, element) => {
        const { active, digits, numbers } = frame();
        const after = digits > 0 ? digits + 1 : 0;
        for (const [row, n] of numbers.entries()) {
          // the caret's line is the other layer's, for the prompt's reason: one
          // writer per cell. Equivalent under sabotage, since that layer paints
          // over this one, so it is declared rather than claimed
          if (row !== active) {
            paintNumber(painter, area.x, area.y + row, digits, n, element);
          }
          if (mark !== '') {
            painter.text(area.x + after, area.y + row, mark, cellStyle(element.style));
          }
        }
      },
    },
    { class: 'sigil-text-area-gutter sigil-muted' }
  );

  const activeLayer = raw(
    {
      measure: () => ({ height: 0, width: 0 }),
      paint: (painter, _area, element) => {
        const area = gutterLayer.content ?? gutterLayer.box;
        const { active, digits, numbers } = frame();
        if (area && active !== undefined) {
          paintNumber(painter, area.x, area.y + active, digits, numbers[active], element);
        }
      },
    },
    {
      bottom: 0,
      class: 'sigil-text-area-gutter-active',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    }
  );

  const host = box({
    ...props.props,
    // after the caller's: the gutter and the body are placed against this.
    // Nothing here says the area may take less than it asks for, because the text
    // layer's own measure does -- a minimum of nothing on either axis, so a box's
    // automatic minimum, which is its content's, is nothing too. `min-width`,
    // `min-height` and `overflow` on this box and on the body were each written
    // first and deleted for surviving their sabotages: the layers paint only the
    // cells inside the text's box, so there is nothing to clip
    'flex-direction': 'row',
    focusable: !disabled.get(),
    ...(props.width === undefined ? {} : { 'flex-shrink': 0, width: props.width }),
  });
  host.addClass('sigil-text-area');
  if (numbered || mark !== '') {
    host.append(box({ 'flex-shrink': 0, position: 'relative' }, gutterLayer, activeLayer));
  }
  host.append(body);

  host.onFocusChange = (_, focused): void => {
    caretLayer.toggleClass('sigil-focus', focused);
  };

  // ---- editing ---------------------------------------------------------------

  /** The selection as its two ends in order, or nothing when there is none. */
  function range(): [Place, Place] | undefined {
    if (anchor === undefined || same(anchor, caret)) {
      return undefined;
    }
    return before(anchor, caret) ? [anchor, caret] : [caret, anchor];
  }

  /** The text between two places. */
  function between(from: Place, to: Place): string {
    if (from.line === to.line) {
      return lines[from.line].slice(from.col, to.col);
    }
    return [
      lines[from.line].slice(from.col),
      ...lines.slice(from.line + 1, to.line),
      lines[to.line].slice(0, to.col),
    ].join('\n');
  }

  /** Whether the placeholder is what is drawn. */
  const hinting = (): boolean =>
    lines.length === 1 && lines[0] === '' && placeholder.join('') !== '';

  /** Tells every layer that what it draws moved. */
  function redraw(): void {
    version++;
    // the placeholder is muted, the caret's cell included, for `TextField`'s
    // reason: unfocused, a hint whose first letter alone is at full strength
    // reads as something typed
    const hinted = hinting();
    textLayer.toggleClass('sigil-text-area-placeholder', hinted);
    textLayer.toggleClass('sigil-muted', hinted);
    caretLayer.toggleClass('sigil-muted', hinted);
    for (const layer of [textLayer, caretLayer, selectionLayer, gutterLayer, activeLayer]) {
      layer.invalidatePaint();
    }
    for (const layer of tokenLayers.values()) {
      layer.invalidatePaint();
    }
  }

  /** What the value now is, for whatever reads it, and what `highlight` makes of it. */
  function changed(): void {
    joined = undefined;
    if (reads) {
      const now = text();
      seen = now;
      value.set(now);
      onChange?.(now);
    }
    rehighlight();
    // the measure reads the line count and the gutter its digits
    textLayer.invalidateMeasure();
    gutterLayer.invalidateMeasure();
  }

  /** The token names already checked, so each is checked once. */
  const named = new Set<string>();

  /**
   * Asks `highlight` about the value and files the spans by the lines they touch.
   *
   * Whenever the value changes and never when only the caret moves, which is the
   * prompt's rule. A name no class can carry is refused by `tokensOf()` itself,
   * asked over an empty value so that it checks the names and marks nothing --
   * one definition of what a token may be called, rather than a second pattern.
   */
  function rehighlight(): void {
    if (highlight === undefined) {
      return;
    }
    const all = highlight(text());

    // pushed rather than `Array.from({ length })`, which walks the iteration
    // protocol for every slot and was a third of the cost on a long value; the
    // spans are sparse, since most lines of most files are touched by none
    starts = [];
    let offset = 0;
    for (const line of lines) {
      starts.push(offset);
      offset += line.length + 1;
    }

    spans = [];
    /** The line the last span started on, which the next one usually starts on or after. */
    let low = 0;
    for (const span of all) {
      // each name once, through `tokensOf()` itself: the same rule, without
      // asking it again for every one of a hundred thousand keywords
      if (!named.has(span.token)) {
        tokensOf('', [span]);
        named.add(span.token);
      }
      const { end, start } = span;
      // a `NaN` fails this, so it marks nothing, which is `tokensOf()`'s answer.
      // Nothing is clipped to the value: a span reaching past either end is filed
      // under the first or the last line and marks only the cells there are, and a
      // clip written here was deleted for surviving its sabotage
      if (!(start < end)) {
        continue;
      }
      // the line the span starts on, by halving from where the last one did --
      // a highlighter emits its spans in order, so that is almost always a
      // step or two -- and every line after it that the span reaches
      let high = lines.length - 1;
      if (starts[low] > start) {
        high = low;
        low = 0;
      }
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= start) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      for (let line = low; line < lines.length && starts[line] < end; line++) {
        (spans[line] ??= []).push(span);
      }
      if (!tokenLayers.has(span.token)) {
        const layer = tokenLayer(span.token);
        tokenLayers.set(span.token, layer);
        // before the caret, which paints over whatever it marks
        body.insertBefore(layer, caretLayer);
      }
    }
  }

  /**
   * Runs an edit from `editing.ts` over the lines it spans, and puts the result back.
   *
   * The lines from `first` to `last` are joined into the one string the edit
   * reads, so a backspace at the start of a line, a word deleted across a break
   * and a paste of forty lines are each the shared rule and not a second one
   * written for an array. Only those lines are joined, which is what keeps an
   * edit as cheap in a long value as in a short one.
   */
  function edit(
    first: number,
    last: number,
    make: (local: string, offset: (at: Place) => number) => Edit
  ): void {
    const local = lines.slice(first, last + 1).join('\n');
    const offset = (at: Place): number => {
      let sum = at.col;
      for (let line = first; line < at.line; line++) {
        sum += lines[line].length + 1;
      }
      return sum;
    };
    const result = make(local, offset);
    const next = result.value === local ? undefined : result.value.split('\n');

    if (next !== undefined) {
      if (next.length === last - first + 1) {
        for (const [index, line] of next.entries()) {
          lines[first + index] = line;
        }
      } else {
        // a fresh array rather than a spread into `splice()`, which takes its
        // arguments on the stack and overflows it on a paste of a long file
        lines = [...lines.slice(0, first), ...next, ...lines.slice(last + 1)];
      }
    }

    let rest = result.cursor;
    let line = first;
    for (const part of next ?? local.split('\n')) {
      if (rest <= part.length) {
        break;
      }
      rest -= part.length + 1;
      line++;
    }
    caret = { col: rest, line };
    anchor = undefined;
    goal = undefined;
    follow = true;
    if (next !== undefined) {
      changed();
    }
    redraw();
  }

  /** Puts text in at the caret, over the selection when there is one. */
  function insert(input: string): void {
    const [from, to] = range() ?? [caret, caret];
    edit(from.line, to.line, (local, offset) => {
      const cut = deleteRange(local, offset(from), offset(to));
      return insertAt(cut.value, cut.cursor, input);
    });
  }

  /** Takes out the selection, or what a deleting key reaches from the caret when there is none. */
  function remove(reach: () => [Place, Place] | 'before' | 'after'): void {
    const selected = range();
    if (selected !== undefined) {
      const [from, to] = selected;
      edit(from.line, to.line, (local, offset) => deleteRange(local, offset(from), offset(to)));
      return;
    }
    const what = reach();
    if (what === 'before') {
      const first = caret.col === 0 ? Math.max(0, caret.line - 1) : caret.line;
      edit(first, caret.line, (local, offset) => deleteBefore(local, offset(caret)));
    } else if (what === 'after') {
      const last =
        caret.col === lines[caret.line].length
          ? Math.min(lines.length - 1, caret.line + 1)
          : caret.line;
      edit(caret.line, last, (local, offset) => deleteAfter(local, offset(caret)));
    } else {
      const [from, to] = what;
      edit(from.line, to.line, (local, offset) => deleteRange(local, offset(from), offset(to)));
    }
  }

  // ---- moving ----------------------------------------------------------------

  /** The column a place is drawn at, which is what a vertical move aims for. */
  const columnOf = (at: Place): number =>
    layoutField(lines[at.line], at.col, Number.POSITIVE_INFINITY).caret.x;

  /**
   * The start of the word before a place, over line breaks.
   *
   * `wordBefore()` treats a line break as whitespace, so the word before the
   * start of a line is the last word of the nearest line above with one -- which
   * is asked of that line alone rather than of everything between.
   */
  function wordLeft(at: Place): Place {
    if (!BLANK.test(lines[at.line].slice(0, at.col))) {
      return { col: wordBefore(lines[at.line], at.col), line: at.line };
    }
    let line = at.line - 1;
    while (line >= 0 && BLANK.test(lines[line])) {
      line--;
    }
    return line < 0
      ? { col: 0, line: 0 }
      : { col: wordBefore(lines[line], lines[line].length), line };
  }

  /** The end of the word after a place, over line breaks, for `wordLeft()`'s reason. */
  function wordRight(at: Place): Place {
    if (!BLANK.test(lines[at.line].slice(at.col))) {
      return { col: wordAfter(lines[at.line], at.col), line: at.line };
    }
    let line = at.line + 1;
    while (line < lines.length && BLANK.test(lines[line])) {
      line++;
    }
    const last = lines.length - 1;
    return line > last
      ? { col: lines[last].length, line: last }
      : { col: wordAfter(lines[line], 0), line };
  }

  /** A cluster to the left, onto the end of the line above from the start of one. */
  function stepLeft(at: Place): Place {
    if (at.col > 0) {
      return { col: boundary(lines[at.line], at.col, -1), line: at.line };
    }
    return at.line === 0 ? at : { col: lines[at.line - 1].length, line: at.line - 1 };
  }

  /** A cluster to the right, onto the start of the line below from the end of one. */
  function stepRight(at: Place): Place {
    if (at.col < lines[at.line].length) {
      return { col: boundary(lines[at.line], at.col, 1), line: at.line };
    }
    return at.line === lines.length - 1 ? at : { col: 0, line: at.line + 1 };
  }

  /**
   * A move by lines, aiming at the goal column. Up from the first line and down
   * from the last land on the ends of the value, which is the prompt's rule: a
   * caret that moved nowhere reads as a key that did not work.
   */
  function vertical(by: number): Place {
    goal ??= columnOf(caret);
    const line = caret.line + by;
    if (line < 0) {
      return { col: 0, line: 0 };
    }
    if (line >= lines.length) {
      const last = lines.length - 1;
      return { col: lines[last].length, line: last };
    }
    const laid = layoutField(lines[line], 0, Number.POSITIVE_INFINITY);
    return { col: offsetIn(laid, lines[line].length, 0, goal), line };
  }

  /** Where a movement key goes, or nothing for a key that is not one. */
  function moveFor(name: string, ctrl: boolean, meta: boolean): Place | undefined {
    const word = ctrl || meta;
    switch (name) {
      case 'left':
        return word ? wordLeft(caret) : stepLeft(caret);
      case 'right':
        return word ? wordRight(caret) : stepRight(caret);
      case 'up':
        return vertical(-1);
      case 'down':
        return vertical(1);
      case 'pageup':
        return vertical(-room.height);
      case 'pagedown':
        return vertical(room.height);
      case 'home':
        return ctrl ? { col: 0, line: 0 } : { col: 0, line: caret.line };
      case 'end': {
        const line = ctrl ? lines.length - 1 : caret.line;
        return { col: lines[line].length, line };
      }
      case 'a':
        return ctrl && !meta ? { col: 0, line: caret.line } : undefined;
      case 'e':
        return ctrl && !meta ? { col: lines[caret.line].length, line: caret.line } : undefined;
      case 'b':
        return meta && !ctrl ? wordLeft(caret) : undefined;
      case 'f':
        return meta && !ctrl ? wordRight(caret) : undefined;
      default:
        return undefined;
    }
  }

  // ---- input -----------------------------------------------------------------

  host.onKey = (event): void => {
    if (disabled.get()) {
      return;
    }
    const k = event.key;
    const word = k.ctrl || k.meta;
    const selected = range();

    const to = moveFor(k.name, k.ctrl, k.meta);
    if (to !== undefined) {
      const vertically = ['down', 'pagedown', 'pageup', 'up'].includes(k.name);
      if (k.name === 'pageup' || k.name === 'pagedown') {
        // the view goes with the caret, so a page is a page of text and not a
        // caret walking to the edge and then dragging the view a row at a time
        top += k.name === 'pageup' ? -room.height : room.height;
      }
      if (k.shift) {
        anchor ??= caret;
        caret = to;
      } else if (selected !== undefined && !word && (k.name === 'left' || k.name === 'right')) {
        // an arrow over a selection lands on the end it points at rather than
        // one past it, which is what every editor does
        caret = k.name === 'left' ? selected[0] : selected[1];
        anchor = undefined;
      } else {
        caret = to;
        anchor = undefined;
      }
      if (!vertically) {
        goal = undefined;
      }
      follow = true;
      redraw();
      event.stop();
      return;
    }

    if (k.name === 'enter') {
      insert('\n');
    } else if (k.name === 'backspace') {
      remove(() => (word ? [wordLeft(caret), caret] : 'before'));
    } else if (k.name === 'delete') {
      remove(() => (word ? [caret, wordRight(caret)] : 'after'));
    } else if (k.ctrl && k.name === 'w') {
      remove(() => [wordLeft(caret), caret]);
    } else if (k.meta && k.name === 'd') {
      remove(() => [caret, wordRight(caret)]);
    } else if (k.ctrl && k.name === 'u') {
      remove(() => [{ col: 0, line: caret.line }, caret]);
    } else if (k.ctrl && k.name === 'k') {
      // the line's text after the caret and not its break, which is readline's
      // `kill-line` and the prompt's
      remove(() => [caret, { col: lines[caret.line].length, line: caret.line }]);
    } else if (onCopy !== undefined && k.ctrl && (k.name === 'y' || k.name === 'x')) {
      // claimed with or without a selection, so the key means one thing in the
      // area whatever is selected
      if (selected !== undefined) {
        onCopy(between(...selected));
        if (k.name === 'x') {
          remove(() => 'before');
        }
      }
    } else if (k.name === 'tab' && event.paste) {
      // a tab in a paste the terminal did not bracket is content, never a move
      // through the ring -- `pastedBlock()` keeps a tab for the same reason
      insert('\t');
    } else if (k.name === 'tab' && !k.shift && !word && tab !== undefined) {
      insert(tab);
    } else {
      const typed = typedText(k);
      // not the area's: Escape, Tab without `tab`, Shift-Tab, the abort, and any
      // chord nobody bound here, which go on to whatever holds the area
      if (typed === undefined) {
        return;
      }
      insert(typed);
    }

    event.stop();
  };

  host.onPaste = (event): void => {
    if (disabled.get()) {
      return;
    }
    // the breaks kept, which is the deliberate inverse of `TextField`: keeping
    // them is the whole point of having more than one line
    insert(pastedBlock(event.text));
    event.stop();
  };

  /** The place under a cell of the canvas, clamped to the lines there are. */
  function placeAt(x: number, y: number): Place {
    const area = textLayer.content ?? textLayer.box;
    if (!area || (lines.length === 1 && lines[0] === '')) {
      return { col: 0, line: 0 };
    }
    // a row above or below the area is the line just past that edge, so a drag
    // off either edge brings the next line into view
    const line = Math.max(0, Math.min(lines.length - 1, top + (y - area.y)));
    const column = Math.max(0, x - area.x) + left;
    const laid = layoutField(lines[line], 0, Number.POSITIVE_INFINITY);
    return { col: offsetIn(laid, lines[line].length, 0, column), line };
  }

  host.onMouse = (event: MouseEvent): void => {
    if (disabled.get()) {
      return;
    }

    if (event.kind === 'wheel' && event.wheel !== undefined) {
      const sideways = event.wheel === 'left' || event.wheel === 'right' || event.shift;
      const back = event.wheel === 'up' || event.wheel === 'left';
      // nothing to scroll gives the turn up, so an area whose lines fit hands
      // the wheel to the pane around it -- the scroll box's rule
      if (!sideways && lines.length <= room.height) {
        return;
      }
      reveal();
      const by = step(event.wheel) * (back ? -1 : 1);
      if (sideways) {
        left = Math.max(0, left + by);
      } else {
        top += by;
      }
      redraw();
      event.stop();
      return;
    }

    if (event.kind === 'mousedown' && event.button === 'left') {
      const at = placeAt(event.x, event.y);
      anchor = event.shift ? (anchor ?? caret) : at;
      caret = at;
      goal = undefined;
      follow = true;
      dragging = true;
      redraw();
      // not stopped: the press is also what gives the area the focus, and
      // stopping it is how a component keeps the focus where it was
      return;
    }

    if (dragging && event.kind === 'mousemove') {
      caret = placeAt(event.x, event.y);
      follow = true;
      redraw();
      event.stop();
      return;
    }

    if (dragging && event.kind === 'mouseup') {
      dragging = false;
      if (anchor !== undefined && same(anchor, caret)) {
        anchor = undefined;
      }
      redraw();
      event.stop();
    }
  };

  rehighlight();

  createEffect(() => {
    // read here, so a write the app makes replaces what the area holds
    const now = value.get();
    if (now !== seen) {
      seen = now;
      load(now);
      rehighlight();
      textLayer.invalidateMeasure();
      gutterLayer.invalidateMeasure();
    }
    redraw();
  });

  createEffect(() => {
    const off = disabled.get();
    host.setProp('focusable', !off);
    host.toggleClass('is-disabled', off);
    host.toggleClass('sigil-muted', off);
  });

  return host;
}
