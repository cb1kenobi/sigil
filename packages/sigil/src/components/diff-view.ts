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
import type { DescribeOptions, KeyEvent } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { State, untrack } from '../signals/index.js';
import { diffBlocks, type DiffLayout, type DiffViewContent, diffView } from './diff.js';
import { unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import type { Highlighter } from './prompt.js';
import { ScrollBox, scrollControl, type ScrollControl } from './scroll-box.js';

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
   * nearest that is when the content changes, and by `]` and `[`.
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
  /** `diffView()`'s `layout`: side by side where the width allows it. */
  layout?: DiffLayout;
  /** `diffView()`'s `lineNumbers`. */
  lineNumbers?: boolean;
  /** The host box's own props: a size, a border, a class. */
  props?: ElementPropsWithout<'onKey'>;
  /** Whether to draw a scrollbar. Defaults to `true`. */
  scrollbar?: boolean;
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
}

/** The hosts `DiffView()` built, so `describeDiffView()` can refuse anything else. */
const HOSTS = new WeakSet<Element>();

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
 * scroll, as a scroll box's do.
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
  const current = props.current instanceof State ? props.current : new State(props.current ?? 0);
  const glyph = (props.ascii ?? !unicodeSupported()) ? '>' : '▌';

  /** The width the layout gave the rows, or 0 before it has. */
  let width = 0;
  /** Every row of the view, each a mark and what it marks. */
  let lines: Element[] = [];
  let drawn: Drawn[] = [];
  /** The stop whose marks are lit, or -1. */
  let lit = -1;
  /** A reveal asked for before there was a layout to measure it against. */
  let pending = false;

  const scroll = ScrollBox({
    // the view holds the focus and every key, so the box inside it holds neither
    onResize: (control) => resized(control),
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
   * Draws every row again, for the width there is and the content as it is.
   *
   * @param content - What to draw.
   */
  const draw = (content: DiffViewContent<T>): void => {
    const room = Math.max(1, width - 1);
    const rows: Element[] = [];
    const marks: Element[] = [];
    const stops: { first: number; last: number }[] = [];
    const push = (row: Element): void => {
      const mark = text(' ', {
        class: 'sigil-diff-view-mark sigil-accent',
        'flex-shrink': 0,
        width: 1,
      });
      marks.push(mark);
      rows.push(
        box(
          { class: 'sigil-diff-view-line', 'flex-direction': 'row', 'flex-shrink': 0, height: 1 },
          mark,
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
        layout: props.layout,
        lineNumbers: props.lineNumbers,
        width: room,
      });
      const offset = rows.length;
      // a copy, since each row is moved out of the tree into a line of the view's
      for (const row of tree.element.children.slice()) {
        push(row);
      }
      for (const hunk of tree.hunks) {
        stops.push({ first: offset + hunk.first, last: offset + hunk.end - 1 });
      }
    }

    lines = rows;
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
    if (drawn.length === 0) {
      // nothing to keep in view, so what is drawn is shown from its start
      viewport.scrollTo(0, 0);
    }
    reveal();
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
    return pending ? reveal() : false;
  }

  host.onKey = (event: KeyEvent): void => {
    const k = event.key;
    if (!event.paste && !k.ctrl && !k.meta && (k.name === ']' || k.name === '[')) {
      // nothing to move over: the key is not ours, and reaches the pane around
      if (drawn.length === 0) {
        return;
      }
      const at = untrack(() => current.get());
      const next = nearest(nearest(at) + (k.name === ']' ? 1 : -1));
      if (next !== at) {
        current.set(next);
      }
      // claimed at an end as well, the way Home is at the top
      event.stop();
      return;
    }
    // the scroll box is not focusable, so its keys are handed on from here
    scroll.onKey?.(event);
  };

  createEffect(() => {
    const content = read(props.content);
    if (width > 0) {
      draw(content);
    }
  });
  createEffect(() => {
    const at = current.get();
    untrack(() => {
      light(at);
      reveal();
    });
  });

  return host;
}

/**
 * Describes a diff view's keys to a router, for a key-help footer: `]` and `[`
 * for the hunks, and the arrows for scrolling.
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
    say('up', __`scroll`, 0);
    say('down', __`scroll`, 0);
  }
  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
