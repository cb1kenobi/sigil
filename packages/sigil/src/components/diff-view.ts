/**
 * A diff view: a diff in a scrolling pane that takes its width from the layout,
 * with a cursor that stops on each hunk.
 *
 * `diffView()` draws a diff for a width it is told, once. What a git client,
 * `tig` or a review tool does with a diff is act on it, a hunk at a time, and
 * that wants three things on top: the width the layout gave, scrolling, and a
 * current hunk that is drawn and kept in view. This is those three, beside
 * `diffView()` as `ListView` is beside `list()`.
 *
 * ```js
 * import { hunkPatch } from '@ttylabs/sigil/components/diff';
 * import { DiffView } from '@ttylabs/sigil/components/diff-view';
 *
 * const view = DiffView({ content: { patch }, current, props: { 'flex-grow': 1 } });
 * ```
 *
 * What it draws is one diff or a list of blocks -- diffs, and prose between them
 * -- and the cursor is a position among the stops `diffStops()` finds in the same
 * content, so an app asking what is at the cursor and the view marking it count
 * one way. `AGENTS.md` has the reasons under "A diff view that scrolls".
 */

import { box, type Element, type ElementPropsWithout, text } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { DescribeOptions, KeyEvent, MouseEvent } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { State, untrack } from '../signals/index.js';
import {
  diffBlocks,
  type DiffLayout,
  type DiffLineKind,
  type DiffViewContent,
  diffView,
} from './diff.js';
import { unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import { ScrollBox, scrollControl, type ScrollControl } from './scroll-box.js';
import type { Highlighter } from './token.js';

export interface DiffViewProps<T = unknown> {
  /** Whether the hunk mark is drawn in ASCII. Defaults to what the terminal can show. */
  ascii?: boolean;
  /**
   * What to draw: one diff -- two texts, a patch, or files `parsePatch()` read --
   * or a list of blocks, diffs and prose between them.
   *
   * Anything with a `get()` -- a `State`, a `Computed` -- or a function is read
   * inside an effect, so the view is drawn again when it changes.
   */
  content: DiffViewContent<T> | { get(): DiffViewContent<T> } | (() => DiffViewContent<T>);
  /**
   * The current stop, as its position among `diffStops(content)`.
   *
   * A number is where the cursor starts; a `State` is the state itself, which `]`
   * and `[` write and an app writes to move the cursor. A position that is not
   * one of the stops -- past the last, negative, between two -- is brought to the
   * nearest that is, whether the content changed or the app wrote it, and `]` or
   * `[` from one goes there before it steps.
   *
   * Two texts are diffed with the default context, 3, as `diffStops()` diffs
   * them, so the two count the same hunks; hunks of another context are handed
   * over as `{ files: [{ hunks: diffHunks(old, new, { context }) }] }`.
   */
  current?: number | State<number>;
  /** `diffView()`'s `highlight`. */
  highlight?: Highlighter;
  /** `diffView()`'s `intraline`. */
  intraline?: boolean;
  /** `diffView()`'s `lang`. */
  lang?: string;
  /**
   * `diffView()`'s `layout`: side by side where the width allows it. A view with
   * `lines` is always drawn unified, since a removed line and the added line beside
   * it share a row side by side, and a cursor is on one line.
   */
  layout?: DiffLayout;
  /** `diffView()`'s `lineNumbers`. */
  lineNumbers?: boolean;
  /**
   * A line cursor inside the current hunk, and the lines picked with it, for an
   * app that acts on part of a hunk -- staging some of its lines. Without it there
   * is only the cursor on hunks, and the keys below are left alone.
   *
   * Enter puts the cursor on the first added or removed line of the current hunk,
   * which is then marked in a second column beside the hunk's own: `▶` on the
   * line, `●` on a line picked, `◉` on both, and `>`, `*` and `@` in ASCII. Up and
   * down step the cursor over the added and removed lines and scroll to keep it in
   * view, `x` picks the line, `a` all of the hunk's, `v` begins a range -- up and
   * down then pick every added or removed line from where it began to the cursor,
   * as well as what was picked before -- and `v` again ends it, keeping the picks.
   * Enter or Escape leaves the lines and drops the picks. `]` and `[` leave them too, as any move to
   * another hunk does. A click on a line of the current hunk moves the cursor to
   * it while it is on the lines, and pressing on a line and dragging to another
   * picks the range `v` would, over what was picked before: a pointer past the
   * view's edge or the hunk's is read as the last row in view or the hunk's last
   * line, and releasing keeps what was picked.
   *
   * A context line is never a stop of the cursor: it has nothing to pick.
   */
  lines?: DiffViewLines;
  /**
   * A `State` the view writes where it is scrolled to, for a status line or a
   * border to show. Written when it changes, never read.
   */
  position?: State<DiffViewPosition>;
  /** The host box's own props: a size, a border, a class. */
  props?: ElementPropsWithout<'onKey'>;
  /** Whether to draw a scrollbar. Defaults to `true`. */
  scrollbar?: boolean;
  /**
   * Whether a line too long for the view is wrapped onto more rows, at words --
   * `diffView()`'s `wrap: 'words'` -- or kept on one row, cut at the edge, with
   * the left and right arrows scrolling every line sideways together, the line
   * numbers and the markers staying put. `w` switches between the two.
   *
   * A boolean is how the view starts, and defaults to `true`; a `State` is the
   * state itself, which `w` writes and an app writes to switch it.
   */
  wrap?: boolean | State<boolean>;
}

/**
 * The states a diff view keeps a line cursor and a selection of lines in, which it
 * writes and an app reads: what to stage is `hunkLinesPatch()` over the stop at
 * `current` and these.
 */
export interface DiffViewLines {
  /**
   * The line the cursor is on, as its position in the current hunk's `lines`, or
   * `undefined` while the cursor is on the hunk as a whole. Enter writes the first
   * added or removed line and Escape or Enter writes `undefined` again; up and
   * down step over the added and removed lines; an app writes it to move the
   * cursor. A position that is not an added or removed line of the current hunk
   * is brought to the nearest that is, or to `undefined` where it has none.
   */
  readonly cursor: State<number | undefined>;
  /**
   * The lines picked, as positions in the current hunk's `lines`: `x` picks or
   * unpicks the one under the cursor and `a` picks all of them, or none where all
   * are. Emptied whenever the current hunk changes, the content changes or the
   * cursor leaves the lines, since a position means nothing in another hunk.
   */
  readonly selected: State<ReadonlySet<number>>;
}

/** Where a diff view is scrolled to, which it writes to its `position`. */
export interface DiffViewPosition {
  /**
   * How far right of the edge the widest line that has been in view ends: as far
   * as `x` goes. The line's width less the room the view gives it, so a wider
   * terminal makes it smaller; `width` is the line's own.
   */
  readonly maxX: number;
  /**
   * How wide the widest line that has been in view is, in columns, whole. It does
   * not depend on the terminal.
   */
  readonly width: number;
  /** How many columns every line is scrolled sideways: always 0 while lines are wrapped. */
  readonly x: number;
  /** The row at the top of the view, counting every row the view draws from 0. */
  readonly y: number;
}

/** Where a diff view's keys are described, which is the whole of what is asked of a router. */
export interface DiffViewDescriber {
  describe(keys: string, opts: DescribeOptions): () => void;
}

/** One stop as drawn: which of the view's rows are its own, and their marks. */
interface Drawn {
  /** Its first row. */
  readonly first: number;
  /** Its last row. */
  readonly last: number;
  /**
   * The first row after the stop before it: what leads into this one -- a
   * section's heading, a file's `---` and `+++` -- which a reveal shows with it
   * where there is the room.
   */
  readonly lead: number;
  readonly marks: readonly Element[];
  /**
   * For a hunk of a view with `lines`: each of its lines' kind and rows, in the
   * order of the hunk's `lines`. `first` and `last` are rows of the view.
   */
  readonly lines?: readonly {
    readonly first: number;
    readonly kind: DiffLineKind;
    readonly last: number;
  }[];
}

/**
 * How far the left and right arrows scroll an unwrapped view, in columns: eight,
 * a tab stop. Half the view, which is `less -S`'s step, moved the text far
 * enough that the reader lost their place on every press.
 */
const SIDEWAYS_STEP = 8;

/** The hosts `DiffView()` built, so `describeDiffView()` can refuse anything else. */
const HOSTS = new WeakSet<Element>();

/** Nothing picked, which a state of lines is emptied to. */
const NONE: ReadonlySet<number> = new Set();

/**
 * Reads what to draw, through a `get()` or a call where it is one.
 *
 * @param source - The content, or what holds it.
 * @returns The content.
 */
function read<T>(source: DiffViewProps<T>['content']): DiffViewContent<T> {
  if (typeof source === 'function') {
    return source();
  }
  if (typeof (source as { get?: unknown }).get === 'function') {
    return (source as { get(): DiffViewContent<T> }).get();
  }
  return source as DiffViewContent<T>;
}

/**
 * Builds a diff view.
 *
 * Every row of the diff sits behind a one-cell mark, blank unless its stop is the
 * current one, where it is `▌` in the accent role -- `>` in ASCII -- so the
 * current hunk is told apart at colour level 0 as well. `]` and `[` move the
 * cursor and scroll it into view; the arrows, Page Up and Down, Home and End
 * scroll, as a scroll box's do. A long line is wrapped at words, and `w` keeps
 * each line on one row instead, which the left and right arrows then scroll. A
 * left click on any row of a stop -- a hunk's `@@` row, a line of it, either half
 * side by side -- makes that stop current where it is, without scrolling.
 *
 * @param props - What to draw, the cursor, and the host's props.
 * @returns The host element, which is the one that takes the focus.
 */
export function DiffView<T = unknown>(props: DiffViewProps<T>): Element {
  refuseOwnedHooks('DiffView', props.props, ['onKey']);
  if (props.content === undefined || props.content === null) {
    throw new TypeError(__`Expected a diff view to have content`);
  }
  if (
    props.current !== undefined &&
    !(props.current instanceof State) &&
    !Number.isInteger(props.current)
  ) {
    throw new TypeError(__`Expected diff view current to be a whole number or a State`);
  }
  if (props.position !== undefined && !(props.position instanceof State)) {
    throw new TypeError(__`Expected diff view position to be a State`);
  }
  if (
    props.lines !== undefined &&
    !(props.lines.cursor instanceof State && props.lines.selected instanceof State)
  ) {
    throw new TypeError(__`Expected diff view lines to hold a cursor and a selected State`);
  }
  const picking = props.lines;
  /** How many cells the marks take: the hunk's, and the line's where there are lines. */
  const markCells = picking ? 2 : 1;
  const lineGlyphs = (props.ascii ?? !unicodeSupported()) ? ['>', '*', '@'] : ['▶', '●', '◉'];
  if (
    props.wrap !== undefined &&
    !(props.wrap instanceof State) &&
    typeof props.wrap !== 'boolean'
  ) {
    throw new TypeError(__`Expected diff view wrap to be a boolean or a State`);
  }
  const current = props.current instanceof State ? props.current : new State(props.current ?? 0);
  const wrapping = props.wrap instanceof State ? props.wrap : new State(props.wrap ?? true);
  const glyph = (props.ascii ?? !unicodeSupported()) ? '>' : '▌';

  /** The width the layout gave the rows, or 0 before it has. */
  let width = 0;
  /** Every row of the view, each a mark and what it marks. */
  let lines: Element[] = [];
  let drawn: Drawn[] = [];
  /** The stop whose marks are lit, or -1. */
  let lit = -1;
  /** The second column of marks, one a row beside `lines`, where there are `lines`. */
  let lineMarks: Element[] = [];
  /** The marks of that column that carry something, so they can be cleared. */
  let painted: Element[] = [];
  /** The line cursor as last drawn, to tell a move from a redraw. */
  let paintedCursor: number | undefined;
  /** The content as last drawn, since a new one makes a position mean something else. */
  let lastContent: unknown;
  /** The stop the cursor was last on, since the line state belongs to one hunk. */
  let lastStop = untrack(() => current.get());
  /** A reveal asked for before there was a layout to measure it against. */
  let pending = false;
  /**
   * The stop a click made current, which the effect over the cursor lights where
   * it is rather than scrolling to: the reader pointed at it on screen.
   */
  let pointed: number | undefined;
  /** How far every line is scrolled sideways while lines are not wrapped. */
  let offset = 0;
  /** How far the widest line runs past its room, which is as far as `offset` goes. */
  let overflow = 0;
  /** How far each row's line runs past its room, beside `lines`. */
  let runs: number[] = [];
  /** How wide each row's line is, whole, beside `lines`. */
  let widths: number[] = [];
  /**
   * The furthest any line that has been in view runs past its room, since the
   * content or the width last changed: as far as the right arrow goes. Kept, so
   * scrolling down to shorter lines does not take back what the reader has seen.
   */
  let seen = 0;
  /** How wide the widest line that has been in view is, over the same span as `seen`. */
  let seenWidth = 0;

  const scroll = ScrollBox({
    // the view holds the focus and every key, so the box inside it holds neither
    onResize: (control) => resized(control),
    onScroll: () => report(),
    props: {
      class: 'sigil-diff-view-scroll',
      'flex-basis': 0,
      'flex-grow': 1,
      focusable: false,
      'min-height': 0,
    },
    rows: {
      // read on every window, which is what lets a new drawing replace the old
      get count() {
        return lines.length;
      },
      height: 1,
      // keyed by the row itself, so a drawing that keeps the count and the offset
      // still builds the rows that changed
      key: (index) => lines[index],
      row: (index) => lines[index] as Element,
    },
    scrollbar: props.scrollbar,
  });
  const control = scrollControl(scroll) as ScrollControl;
  const viewport = control.viewport;

  const host = box({ ...props.props, 'flex-direction': 'column', focusable: true });
  // added rather than written into the props, so an app's own `class` is kept
  host.addClass('sigil-diff-view');
  host.append(scroll);
  HOSTS.add(host);

  /**
   * The stop nearest a position: a whole one, inside the stops there are.
   *
   * @param at - The position, which an app may have written as anything.
   * @returns The position of a stop.
   */
  const nearest = (at: number): number =>
    Math.min(drawn.length - 1, Math.max(0, Number.isFinite(at) ? Math.round(at) : 0));

  /** The viewport's height in cells, from the last layout, or zero before one. */
  const viewHeight = (): number => (viewport.content ?? viewport.box)?.height ?? 0;

  /**
   * The largest of a row-by-row list among the rows in view. A view with no height
   * has no row in view: there is always a layout by now, since nothing is drawn
   * until one has given the view a width.
   *
   * @param values - One number a row, beside `lines`.
   * @returns The largest in view, or 0.
   */
  const inView = (values: readonly number[]): number => {
    const height = viewHeight();
    const top = Math.max(0, Math.floor(viewport.scroll?.y ?? 0));
    let most = 0;
    for (let at = top; at < Math.min(values.length, top + height); at++) {
      most = Math.max(most, values[at] ?? 0);
    }
    return most;
  };

  /**
   * Takes the rows in view into what has been seen, and answers how far right the
   * view may go: the widest line seen since the content or the width changed.
   * Asked whenever the rows in view may have changed -- a draw, a scroll, a
   * resize, a press -- so it is never behind them.
   *
   * @returns The limit.
   */
  const look = (): number => {
    seen = Math.max(seen, inView(runs));
    seenWidth = Math.max(seenWidth, inView(widths));
    return seen;
  };

  /**
   * Draws every row again, for the width there is and the content as it is.
   *
   * @param content - What to draw.
   * @param sideways - Whether all that moved is the sideways scroll, which keeps
   *   the rows where they were rather than bringing the current stop into view: a
   *   reader scrolled away from it to read something is reading it still.
   */
  const draw = (content: DiffViewContent<T>, sideways = false): void => {
    const room = Math.max(1, width - markCells);
    const wrapped = untrack(() => wrapping.get());
    let widest = 0;
    const rows: Element[] = [];
    const marks: Element[] = [];
    const lineColumn: Element[] = [];
    const reaches: number[] = [];
    const wides: number[] = [];
    const stops: {
      first: number;
      last: number;
      lines?: NonNullable<Drawn['lines']>;
    }[] = [];
    const push = (row: Element, reach = 0, wide = 0): void => {
      reaches.push(reach);
      wides.push(wide);
      const mark = text(' ', {
        class: 'sigil-diff-view-mark sigil-accent',
        'flex-shrink': 0,
        width: 1,
      });
      marks.push(mark);
      const cells: Element[] = [mark];
      if (picking) {
        const second = text(' ', {
          class: 'sigil-diff-view-line-mark sigil-accent',
          'flex-shrink': 0,
          width: 1,
        });
        lineColumn.push(second);
        cells.push(second);
      }
      rows.push(
        box(
          { class: 'sigil-diff-view-line', 'flex-direction': 'row', 'flex-shrink': 0, height: 1 },
          ...cells,
          row
        )
      );
    };

    for (const block of diffBlocks(content)) {
      if ('text' in block) {
        const first = rows.length;
        for (const value of block.text.split('\n')) {
          push(
            text(value, {
              class: block.class,
              'flex-shrink': 0,
              'text-overflow': 'ellipsis',
              'white-space': 'pre',
              width: room,
            })
          );
        }
        if (block.stop) {
          stops.push({ first, last: rows.length - 1 });
        }
        continue;
      }
      const tree = diffView(block.diff, {
        highlight: props.highlight,
        intraline: props.intraline,
        lang: props.lang,
        // a line cursor is on one line, and side by side two share a row
        layout: picking ? 'unified' : props.layout,
        lineNumbers: props.lineNumbers,
        offset,
        width: room,
        wrap: wrapped ? 'words' : 'none',
      });
      widest = Math.max(widest, tree.overflow);
      const base = rows.length;
      // a copy, since each row is moved out of the tree into a line of the view's
      for (const [at, row] of tree.element.children.slice().entries()) {
        push(row, tree.rowOverflow[at], tree.rowWidth[at]);
      }
      for (const hunk of tree.hunks) {
        stops.push({
          first: base + hunk.first,
          last: base + hunk.end - 1,
          lines: picking
            ? hunk.lines.map((span, at) => ({
                first: base + span.first,
                kind: hunk.hunk.lines[at]!.kind,
                last: base + span.end - 1,
              }))
            : undefined,
        });
      }
    }

    // new rows: the one the press landed on is not in the tree any more, so a drag
    // that began on it has nothing to follow
    endDrag();
    overflow = widest;
    lines = rows;
    runs = reaches;
    widths = wides;
    lineMarks = lineColumn;
    painted = [];
    if (!sideways) {
      // new content, a new width or wrapped: what was seen was other lines, or the
      // same lines in another room, so it is seen again from the rows now in view
      seen = 0;
      seenWidth = 0;
    }
    for (const [at, stop] of stops.entries()) {
      // the stop is the one this drawing put the row in, so a click is never read
      // through a row count that a later drawing changed
      const onMouse = (event: MouseEvent): void => mouseOn(event, at);
      for (let row = stop.first; row <= stop.last; row++) {
        (rows[row] as Element).onMouse = onMouse;
      }
      // a line's rows know which line they are, which is how a click moves the
      // line cursor: one handler a line, in place of the stop's
      for (const [line, span] of (stop.lines ?? []).entries()) {
        const onLine = (event: MouseEvent): void => mouseOn(event, at, line);
        for (let row = span.first; row <= span.last; row++) {
          (rows[row] as Element).onMouse = onLine;
        }
      }
    }
    drawn = stops.map((stop, at) => ({
      ...stop,
      lead: at === 0 ? 0 : (stops[at - 1] as { last: number }).last + 1,
      marks: marks.slice(stop.first, stop.last + 1),
    }));
    control.resync();

    lit = -1;
    const at = untrack(() => current.get());
    if (drawn.length > 0 && nearest(at) !== at) {
      // the effect over the cursor lights it; this only brings it back to a stop
      current.set(nearest(at));
    }
    light(untrack(() => current.get()));
    // a cursor written before there was a drawing to say which lines exist
    settle();
    paint();
    if (!sideways) {
      if (drawn.length === 0) {
        // nothing to keep in view, so what is drawn is shown from its start
        viewport.scrollTo(0, 0);
      }
      // a drawing in the same flush as a click leaves the clicked stop where it is,
      // as the effect over the cursor does after it
      if (pointed !== untrack(() => current.get())) {
        reveal();
      }
      // and the line cursor, which a hunk taller than the view would leave scrolled off
      const line = picking ? untrack(() => picking.cursor.get()) : undefined;
      if (line !== undefined) {
        revealLine(line);
      }
      if (look() < offset) {
        // scrolled further than any line now in view goes -- narrower content, a
        // wider view, wrapped -- so drawn again from as far as one does
        offset = seen;
        draw(content, true);
        return;
      }
    }
    report();
  };

  /**
   * A click on a row of a stop: the click rather than the press, so the press
   * keeps its default action -- focusing the view -- and a press dragged off the
   * row picks nothing. A row no stop owns has no handler, and its click goes on to
   * the pane around.
   *
   * @param event - The report.
   * @param at - The stop the row was drawn in.
   */
  const clicked = (event: MouseEvent, at: number, line?: number): void => {
    if (event.kind !== 'click' || event.button !== 'left') {
      return;
    }
    event.stop();
    if (dragged) {
      // the click that ends a drag is not a click on anything
      dragged = false;
      return;
    }
    if (untrack(() => current.get()) !== at) {
      pointed = at;
      current.set(at);
      return;
    }
    // on the lines of the current hunk the click is the cursor's, and the line is
    // on screen already
    if (
      picking &&
      line !== undefined &&
      untrack(() => picking.cursor.get()) !== undefined &&
      drawn[at]?.lines?.[line]?.kind !== 'context' &&
      untrack(() => picking.cursor.get()) !== line
    ) {
      anchor = undefined;
      picking.cursor.set(line);
    }
  };

  /**
   * What a press on a changed line of the current hunk began, while the button is
   * held: the line it landed on, and whether the pointer has left it yet. `undefined`
   * while no drag is open.
   */
  let dragging: { line: number; began: boolean } | undefined;
  /** Whether the click a drag will be followed by is still to be swallowed. */
  let dragged = false;

  /**
   * Ends a drag where it stands: a range it opened is closed, keeping its picks, as
   * the release would have. Whatever takes the drag's row or the cursor's lines away
   * asks this, because the release that would close the range will not find the
   * drag.
   */
  const endDrag = (): void => {
    if (dragging?.began) {
      anchor = undefined;
    }
    dragging = undefined;
  };

  /**
   * Routes a report on a row to what it is for. A press captures the pointer, so
   * the moves and the release of a drag arrive at the row it landed on wherever the
   * pointer has got to.
   *
   * @param event - The report.
   * @param at - The stop the row was drawn in.
   * @param line - The line the row belongs to, where it belongs to one.
   */
  const mouseOn = (event: MouseEvent, at: number, line?: number): void => {
    if (event.kind === 'mousedown') {
      pressed(event, at, line);
    } else if (event.kind === 'mousemove') {
      moved(event);
    } else if (event.kind === 'mouseup') {
      released(event);
    } else {
      clicked(event, at, line);
    }
  };

  /**
   * A press: a drag may begin from it, on a changed line of the current hunk while
   * the cursor is on the lines -- the places a click moves the cursor. Nothing is
   * picked until the pointer leaves the line, so a click is still only a click, and
   * the press is not stopped, so it still focuses the view.
   */
  const pressed = (event: MouseEvent, at: number, line?: number): void => {
    // another button's press is not this drag's to end
    if (event.button !== 'left') {
      return;
    }
    // every press starts afresh, so a release that never came cannot leave the
    // next click swallowed
    endDrag();
    dragged = false;
    if (
      !picking ||
      line === undefined ||
      at !== lit ||
      untrack(() => picking.cursor.get()) === undefined ||
      drawn[at]?.lines?.[line]?.kind === 'context'
    ) {
      return;
    }
    dragging = { began: false, line };
  };

  /**
   * The line a row at a height stands for: the row under the pointer, clamped to
   * the rows in view and to the hunk, and for a context line the changed line
   * nearest it on the anchor's side -- the one `v` and a step would end on.
   *
   * @param y - The pointer's row, which a captured drag reports off the canvas.
   * @param from - The line the drag began on.
   * @returns The position among the hunk's lines, or `undefined` before a layout.
   */
  const lineAt = (y: number, from: number): number | undefined => {
    const spans = drawn[lit]?.lines;
    const place = viewport.content ?? viewport.box;
    if (spans === undefined || spans.length === 0 || place === undefined || place.height <= 0) {
      return undefined;
    }
    // clamped rather than scrolled: a drag off the view's edge picks as far as the
    // view shows, and the wheel or `v` takes it further
    const row =
      Math.floor(viewport.scroll?.y ?? 0) + Math.min(Math.max(y - place.y, 0), place.height - 1);
    let line = spans.findIndex((span) => span.last >= row);
    if (line < 0) {
      line = spans.length - 1;
    }
    if (spans[line]!.kind !== 'context') {
      return line;
    }
    const toward = line > from ? -1 : 1;
    for (let at = line + toward; at >= 0 && at < spans.length; at += toward) {
      if (spans[at]!.kind !== 'context') {
        return at;
      }
    }
    return from;
  };

  /**
   * A move of a drag: from the line it began on to the line under the pointer is
   * the range `v` would pick, over what was picked before.
   */
  const moved = (event: MouseEvent): void => {
    if (!picking || !dragging) {
      return;
    }
    if (event.button === undefined) {
      // motion with nothing held, which an app that reports hover is sent: the
      // release never came, and the drag is over
      endDrag();
      return;
    }
    const spans = drawn[lit]?.lines ?? [];
    const cursor = untrack(() => picking.cursor.get());
    if (cursor === undefined || spans[dragging.line] === undefined) {
      // the cursor left the lines, or the hunk is another one: nothing to follow
      endDrag();
      return;
    }
    const to = lineAt(event.y, dragging.line);
    if (to === undefined || (!dragging.began && to === dragging.line)) {
      return;
    }
    const changes = [...spans.keys()].filter((line) => spans[line]!.kind !== 'context');
    if (!dragging.began) {
      dragging.began = true;
      anchor = dragging.line;
      base = untrack(() => picking.selected.get());
      dragged = true;
    }
    // once the pointer has left the line the drag is the view's, and nothing above
    // it acts on what follows
    event.stop();
    if (to !== cursor) {
      picking.cursor.set(to);
    }
    pickRange(to, changes);
  };

  /** The release of a drag, which keeps what it picked. */
  const released = (event: MouseEvent): void => {
    if (!dragging) {
      return;
    }
    // any release ends a drag, whatever its button says
    if (dragging.began) {
      anchor = undefined;
      event.stop();
    }
    dragging = undefined;
  };

  /**
   * Lights the marks of a stop, and puts out the ones that were lit.
   *
   * @param at - The stop.
   */
  const light = (at: number): void => {
    if (at === lit) {
      return;
    }
    for (const mark of drawn[lit]?.marks ?? []) {
      mark.setText(' ');
      mark.removeClass('is-current');
    }
    lit = at;
    for (const mark of drawn[at]?.marks ?? []) {
      mark.setText(glyph);
      mark.addClass('is-current');
    }
  };

  /**
   * Where `v` began a range of lines, and what was picked before it: the picks
   * while the range is open are `base` and the changed lines from `anchor` to the
   * cursor. `undefined` while no range is open.
   */
  let anchor: number | undefined;
  let base: ReadonlySet<number> = NONE;
  /**
   * What the open range last wrote -- the cursor it is at and the picks it made --
   * so a write from anywhere else ends it: an app that moved the cursor or changed
   * the picks has left the range's own arithmetic behind.
   */
  let ranged: { cursor: number; picks: ReadonlySet<number> } | undefined;

  /**
   * Picks the changed lines from the anchor to the cursor, over what was picked
   * before the range began.
   *
   * @param to - The cursor's line.
   * @param changes - The positions of the hunk's added and removed lines.
   */
  const pickRange = (to: number, changes: readonly number[]): void => {
    if (!picking || anchor === undefined) {
      return;
    }
    const low = Math.min(anchor, to);
    const high = Math.max(anchor, to);
    const picks = new Set([...base, ...changes.filter((line) => line >= low && line <= high)]);
    ranged = { cursor: to, picks };
    picking.selected.set(picks);
  };

  /**
   * Empties the line cursor and the picks, which belong to the hunk they were made
   * in: another hunk, new content or the cursor leaving the lines is a new subject.
   */
  const resetLines = (): void => {
    if (!picking) {
      return;
    }
    anchor = undefined;
    ranged = undefined;
    dragging = undefined;
    untrack(() => {
      if (picking.cursor.get() !== undefined) {
        picking.cursor.set(undefined);
      }
      if (picking.selected.get().size > 0) {
        picking.selected.set(NONE);
      }
    });
  };

  /**
   * Brings the line cursor to a line it can be on: an added or removed line of the
   * current hunk, the nearest to where it was put, or none where there is no such
   * line. Nothing is asked before the first drawing, which is what says which
   * hunk is current.
   */
  const settle = (): void => {
    if (!picking || width === 0) {
      return;
    }
    const at = untrack(() => picking.cursor.get());
    if (at === undefined) {
      return;
    }
    const spans = drawn[lit]?.lines ?? [];
    if (Number.isInteger(at) && spans[at] !== undefined && spans[at].kind !== 'context') {
      return;
    }
    let best: number | undefined;
    for (const [line, span] of spans.entries()) {
      if (
        span.kind !== 'context' &&
        (best === undefined ||
          Math.abs(line - (Number.isFinite(at) ? at : 0)) <
            Math.abs(best - (Number.isFinite(at) ? at : 0)))
      ) {
        best = line;
      }
    }
    picking.cursor.set(best);
  };

  /** Draws the line cursor and the picks of the current hunk in the second column. */
  const paint = (): void => {
    for (const mark of painted) {
      mark.setText(' ');
      mark.removeClass('is-cursor');
      mark.removeClass('is-picked');
    }
    painted = [];
    const spans = drawn[lit]?.lines;
    if (!picking || spans === undefined) {
      return;
    }
    const at = untrack(() => picking.cursor.get());
    const picked = untrack(() => picking.selected.get());
    for (const [line, span] of spans.entries()) {
      const here = line === at;
      const chosen = picked.has(line);
      if (span.kind === 'context' || !(here || chosen)) {
        continue;
      }
      for (let row = span.first; row <= span.last; row++) {
        const mark = lineMarks[row] as Element;
        mark.setText(lineGlyphs[chosen ? (here ? 2 : 1) : 0] as string);
        mark.toggleClass('is-cursor', here);
        mark.toggleClass('is-picked', chosen);
        painted.push(mark);
      }
    }
    paintedCursor = at;
  };

  /**
   * Scrolls a line of the current hunk into view, by as little as shows it.
   *
   * @param at - The line's position in the hunk's lines.
   */
  const revealLine = (at: number): void => {
    const span = drawn[lit]?.lines?.[at];
    const height = viewHeight();
    if (span === undefined || height <= 0) {
      return;
    }
    const top = viewport.scroll?.y ?? 0;
    if (span.first < top) {
      viewport.scrollTo(0, span.first);
    } else if (span.last >= top + height) {
      viewport.scrollTo(0, Math.min(span.first, span.last - height + 1));
    }
  };

  /**
   * The keys of the line cursor: Enter to start, then up and down, `x`, `a`, `v`
   * for a range, and Enter or Escape to leave.
   *
   * @param event - The key.
   * @returns Whether it was the cursor's, and is stopped.
   */
  const lineKey = (event: KeyEvent): boolean => {
    if (!picking || event.paste || event.key.ctrl || event.key.meta || event.key.shift) {
      return false;
    }
    const name = event.key.name;
    const at = untrack(() => picking.cursor.get());
    const spans = drawn[lit]?.lines ?? [];
    const changes = [...spans.keys()].filter((line) => spans[line]!.kind !== 'context');
    if (at === undefined) {
      if (name !== 'enter' || changes.length === 0) {
        return false;
      }
      picking.cursor.set(changes[0]);
      event.stop();
      return true;
    }
    if (name === 'enter' || name === 'escape') {
      resetLines();
    } else if (name === 'up' || name === 'down') {
      const next =
        name === 'down' ? changes.find((line) => line > at) : changes.findLast((line) => line < at);
      if (next !== undefined) {
        picking.cursor.set(next);
        pickRange(next, changes);
      }
    } else if (name === 'v') {
      if (anchor === undefined) {
        // the range is the one line to begin with, over what was picked already
        anchor = at;
        base = untrack(() => picking.selected.get());
        pickRange(at, changes);
      } else {
        // closing it keeps what it picked, and the next one starts from there
        anchor = undefined;
      }
    } else if (name === 'x') {
      anchor = undefined;
      const picked = new Set(untrack(() => picking.selected.get()));
      if (!picked.delete(at)) {
        picked.add(at);
      }
      picking.selected.set(picked);
    } else if (name === 'a') {
      anchor = undefined;
      const picked = untrack(() => picking.selected.get());
      picking.selected.set(changes.every((line) => picked.has(line)) ? NONE : new Set(changes));
    } else {
      return false;
    }
    event.stop();
    return true;
  };

  /**
   * Scrolls the lit stop into view, by as little as shows it: with the rows that
   * lead into it -- a heading, a file's `---` and `+++` -- where it fits with them,
   * and from its own first row where it does not.
   *
   * @returns Whether the view moved.
   */
  const reveal = (): boolean => {
    const stop = drawn[lit];
    if (stop === undefined) {
      pending = false;
      return false;
    }
    const height = viewHeight();
    if (height <= 0) {
      // nothing has laid the view out, so there is no "in view" yet: the scroll
      // box's resize hook asks again once there is
      pending = true;
      return false;
    }
    pending = false;
    const top = viewport.scroll?.y ?? 0;
    const from = stop.last - stop.lead < height ? stop.lead : stop.first;
    if (from < top) {
      viewport.scrollTo(0, from);
      return true;
    }
    if (stop.last >= top + height) {
      viewport.scrollTo(0, Math.min(from, stop.last - height + 1));
      return true;
    }
    return false;
  };

  /**
   * The scroll box's resize: the rows are drawn again at the width the layout
   * gave -- before the frame paints, and answered as a change so it lays them out.
   *
   * @param given - The scroll box.
   * @returns Whether the tree changed.
   */
  function resized(given: ScrollControl): boolean {
    const next = Math.floor(given.viewport.content?.width ?? given.viewport.box?.width ?? 0);
    if (next > 0 && next !== width) {
      width = next;
      draw(untrack(() => read(props.content)));
      return true;
    }
    const moved = pending ? reveal() : false;
    // a height that changed alone changes which rows are in view, and so how far
    // right they go, without drawing anything or moving the offset
    report();
    return moved;
  }

  /**
   * Takes in the rows in view, and writes where the view is to `position`, where
   * there is one and it moved.
   */
  function report(): void {
    const limit = look();
    if (props.position === undefined) {
      return;
    }
    const next: DiffViewPosition = {
      maxX: untrack(() => wrapping.get()) ? 0 : limit,
      width: seenWidth,
      x: offset,
      y: Math.max(0, Math.floor(viewport.scroll?.y ?? 0)),
    };
    const was = untrack(() => props.position!.get());
    if (
      was.maxX !== next.maxX ||
      was.width !== next.width ||
      was.x !== next.x ||
      was.y !== next.y
    ) {
      props.position.set(next);
    }
  }

  host.onKey = (event: KeyEvent): void => {
    const k = event.key;
    if (lineKey(event)) {
      return;
    }
    if (!event.paste && !k.ctrl && !k.meta && k.name === 'w') {
      wrapping.set(!untrack(() => wrapping.get()));
      event.stop();
      return;
    }
    if (
      !event.paste &&
      !k.ctrl &&
      !k.meta &&
      !k.shift &&
      (k.name === 'left' || k.name === 'right') &&
      !untrack(() => wrapping.get()) &&
      overflow > 0
    ) {
      // claimed at an end as well, the way Home is at the top, and left alone where
      // nothing in the diff runs past the edge. Right goes as far as the widest line
      // seen, and never back
      const next =
        k.name === 'right'
          ? Math.max(offset, Math.min(look(), offset + SIDEWAYS_STEP))
          : Math.max(0, offset - SIDEWAYS_STEP);
      if (next !== offset) {
        offset = next;
        draw(
          untrack(() => read(props.content)),
          true
        );
      }
      event.stop();
      return;
    }
    if (!event.paste && !k.ctrl && !k.meta && (k.name === ']' || k.name === '[')) {
      // nothing to move over: the key is not ours, and reaches the pane around
      if (drawn.length === 0) {
        return;
      }
      const at = untrack(() => current.get());
      // a cursor an app left between stops goes to the nearest before it steps
      const from = nearest(at);
      const next = from === at ? nearest(at + (k.name === ']' ? 1 : -1)) : from;
      if (next !== at) {
        current.set(next);
      }
      // claimed at an end as well, the way Home is at the top
      event.stop();
      return;
    }
    if (!k.ctrl && !k.meta && !k.shift && (k.name === 'home' || k.name === 'end') && offset > 0) {
      // to the top or the bottom, and back to the start of the lines: claimed for the
      // sideways move even where there is no room to move up or down. A paste is not
      // refused, since the scroll box takes a pasted Home as Home and the two halves
      // of one key must not disagree; a modifier is, as it is for the arrows
      offset = 0;
      draw(
        untrack(() => read(props.content)),
        true
      );
      scroll.onKey?.(event);
      event.stop();
      return;
    }
    // the scroll box is not focusable, so its keys are handed on from here
    scroll.onKey?.(event);
  };

  createEffect(() => {
    const content = read(props.content);
    if (content !== lastContent) {
      // new content renumbers the hunks, and what was picked in one is nothing in it
      if (lastContent !== undefined) {
        resetLines();
      }
      lastContent = content;
    }
    // read for the redraw a switch asks for; draw() reads it again. Wrapped,
    // nothing runs past the edge, so the clamp there puts a sideways scroll back
    // to the start, and lines unwrapped again start from their beginning
    wrapping.get();
    if (width > 0) {
      draw(content);
    }
  });
  createEffect(() => {
    const at = current.get();
    untrack(() => {
      // a position an app wrote that is not a stop is brought to one, and this
      // runs again for it
      if (drawn.length > 0 && nearest(at) !== at) {
        current.set(nearest(at));
        return;
      }
      if (at !== lastStop) {
        lastStop = at;
        resetLines();
      }
      light(at);
      paint();
      // a stop a click made current is on screen already, and scrolling a hunk
      // taller than the view to its first row would move the line clicked away
      if (pointed !== at) {
        reveal();
      }
      pointed = undefined;
    });
  });

  if (picking) {
    createEffect(() => {
      const at = picking.cursor.get();
      picking.selected.get();
      untrack(() => {
        settle();
        if (picking.cursor.get() !== at) {
          // brought to a line it can be on, which runs this again
          return;
        }
        const picked = picking.selected.get();
        if (
          at === undefined ||
          (anchor !== undefined && ranged && (ranged.cursor !== at || ranged.picks !== picked))
        ) {
          anchor = undefined;
        }
        if (at === undefined && picking.selected.get().size > 0) {
          // the cursor is off the lines, however it got there: so are the picks
          picking.selected.set(NONE);
          return;
        }
        const moved = at !== paintedCursor;
        paint();
        if (moved && at !== undefined) {
          revealLine(at);
        }
      });
    });
  }

  return host;
}

/**
 * Describes a diff view's keys to a router, for a key-help footer: `]` and `[`
 * for the hunks, `w` for wrapping, and the arrows for scrolling.
 *
 * @param router - What to describe the keys to.
 * @param views - Hosts that `DiffView()` returned.
 * @returns Takes every description back off.
 */
export function describeDiffView(
  router: DiffViewDescriber,
  ...views: readonly Element[]
): () => void {
  for (const host of views) {
    if (!HOSTS.has(host)) {
      throw new TypeError(__`Expected an element that DiffView() returned`);
    }
  }
  const off: Array<() => void> = [];
  for (const scope of views) {
    const say = (spec: string, description: string, priority: number): void => {
      off.push(router.describe(spec, { description, priority, scope }));
    };
    say(']', __`next hunk`, 2);
    say('[', __`previous hunk`, 2);
    say('w', __`wrap`, 1);
    say('up', __`scroll`, 0);
    say('down', __`scroll`, 0);
    say('left', __`scroll sideways`, 0);
    say('right', __`scroll sideways`, 0);
  }
  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
