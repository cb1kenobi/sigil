/**
 * A paginator: page arithmetic over a signal, and the indicator that says where
 * you are.
 *
 * For content that is genuinely in pages -- a wizard, a result set, a help
 * browser -- as opposed to a long list that scrolls, which is what `prompt.ts`'s
 * window and `ScrollBox` are for. The two are separate on purpose: a window's
 * position follows a cursor and moves a row at a time, while a page is a unit the
 * reader steps between, so one counter cannot serve both without one of them
 * lying about what it is.
 */

import { ansi as defaultAnsi } from '../ansi/index.js';
import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { unicodeSupported } from './note.js';

/** How the position is written: one dot per page, `2/5`, or both. */
export type PageIndicatorStyle = 'both' | 'dots' | 'numeric';

export interface PageIndicatorOptions extends StyledOptions {
  /** The dot for the current page. Defaults to `●`, or `*` where `ascii` is on. */
  active?: string;
  /**
   * Draw with ASCII only. Defaults to what `unicodeSupported()` says of `env` and
   * `platform`, since the default dots are not safe where box drawing is not.
   */
  ascii?: boolean;
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * How the numeric form is written, given the page **counting from one** and
   * how many there are. Defaults to `2/5`, which is not prose and so is not in
   * the catalog; this is where `Page 2 of 5` in another language goes.
   */
  format?: (page: number, pages: number) => string;
  /** The dot for every other page. Defaults to `○`, or `.` where `ascii` is on. */
  inactive?: string;
  /**
   * The most pages that are drawn as dots. Defaults to 10.
   *
   * Past it there is no row of dots that fits beside anything, and one that
   * wrapped would be a different shape on every terminal width, so the indicator
   * is the number alone -- whatever `style` said.
   */
  maxDots?: number;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /** Defaults to `dots`. */
  style?: PageIndicatorStyle;
}

export interface PaginatorOptions {
  /** The page to start on, counting from zero. Defaults to 0. */
  page?: number;
  /** How many items a page holds, at least 1. Defaults to 10. */
  perPage?: number;
  /** How many items there are in all. Defaults to 0. */
  total?: number;
}

/**
 * What a paginator reads, as signals.
 *
 * These are the whole of the state. Everything else -- the number of pages, where
 * the current one starts, whether there is a next -- is a function of the three,
 * so a view that reads them cannot disagree with the facade over them.
 */
export interface PaginatorState {
  /** The current page, counting from zero. May be written past the end; reads clamp it. */
  page: State<number>;
  perPage: State<number>;
  total: State<number>;
}

export interface Paginator {
  /** The index after the last item on the current page. */
  readonly end: number;
  /** Goes to the first page. Returns whether that moved. */
  first(): boolean;
  /** The indicator as a string. */
  indicator(opts?: PageIndicatorOptions): string;
  /** Goes to a page, counting from zero, clamped. Returns whether that moved. */
  goTo(page: number): boolean;
  /** Goes to the last page. Returns whether that moved. */
  last(): boolean;
  /** Goes to the next page, if there is one. Returns whether that moved. */
  next(): boolean;
  /** Whether this is the first page. */
  readonly onFirstPage: boolean;
  /** Whether this is the last page. There is always at least one. */
  readonly onLastPage: boolean;
  /** The current page, counting from zero. Assigning clamps it. */
  page: number;
  /** How many pages there are, at least 1. */
  readonly pages: number;
  /** How many items a page holds. Assigning keeps the first item on screen. */
  perPage: number;
  /** Goes to the previous page, if there is one. Returns whether that moved. */
  previous(): boolean;
  /** The items on the current page. */
  slice<T>(items: readonly T[]): T[];
  /** The index of the first item on the current page. */
  readonly start: number;
  /** The signals behind it, for a view to read. */
  readonly state: PaginatorState;
  /** How many items there are in all. Assigning keeps the page in range. */
  total: number;
}

/** The glyphs for a page, and for the pages that are not. */
const GLYPHS = { ascii: ['*', '.'], unicode: ['●', '○'] } as const;

/**
 * @param value - Anything.
 * @returns It as a count: a whole number, never below zero.
 */
function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * @param value - Anything.
 * @returns It as a page size: a whole number, never below one.
 */
function size(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

/**
 * How many pages there are.
 *
 * Never fewer than one, for the reason `Math.ceil(0 / n)` is the wrong answer: a
 * result set with nothing in it is still a screen, and `1/1` is what it reads as.
 *
 * @param total - How many items.
 * @param perPage - How many to a page.
 * @returns The pages.
 */
export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(count(total) / size(perPage)));
}

/**
 * Puts a page in range.
 *
 * @param page - A page, counting from zero.
 * @param pages - How many pages there are.
 * @returns The page, between 0 and the last.
 */
export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(1, count(pages)) - 1, count(page));
}

/**
 * Where a page sits among the items.
 *
 * @param page - The page, counting from zero.
 * @param perPage - How many to a page.
 * @param total - How many items there are.
 * @returns The first item's index and the end, which is exclusive.
 */
export function pageBounds(
  page: number,
  perPage: number,
  total: number
): { end: number; start: number } {
  const each = size(perPage);
  const start = clampPage(page, pageCount(total, each)) * each;

  return { end: Math.min(count(total), start + each), start };
}

/**
 * The signals for a paginator.
 *
 * @param opts - Where to start, and how much there is.
 * @returns The state.
 */
export function paginatorState(opts: PaginatorOptions = {}): PaginatorState {
  const perPage = size(opts.perPage ?? 10);
  const total = count(opts.total ?? 0);

  return {
    page: new State(clampPage(opts.page ?? 0, pageCount(total, perPage))),
    perPage: new State(perPage),
    total: new State(total),
  };
}

/**
 * Page state as a signal, with the arithmetic done.
 *
 * Every read goes through the signals, so one made inside an effect or a
 * computed is tracked and a view of it redraws when the page turns. Writes keep
 * the page in range: a `total` that shrinks takes the page with it, once, rather
 * than leaving a stored page past the end that a later growth would spring back
 * to. A `perPage` that changes keeps the **first item on the page** on screen,
 * which is the page that item is on now.
 *
 * @param opts - Where to start, and how much there is.
 * @returns The paginator.
 */
export function createPaginator(opts: PaginatorOptions = {}): Paginator {
  const state = paginatorState(opts);

  const pages = (): number => pageCount(state.total.get(), state.perPage.get());
  const current = (): number => clampPage(state.page.get(), pages());

  function goTo(next: number): boolean {
    const before = current();
    state.page.set(clampPage(next, pages()));

    return current() !== before;
  }

  const paginator: Paginator = {
    get end() {
      return pageBounds(current(), state.perPage.get(), state.total.get()).end;
    },

    first: () => goTo(0),
    goTo,

    indicator: (indicatorOpts) => pageIndicator(current(), pages(), indicatorOpts),

    last: () => goTo(pages() - 1),
    next: () => goTo(current() + 1),

    get onFirstPage() {
      return current() === 0;
    },

    get onLastPage() {
      return current() === pages() - 1;
    },

    get page() {
      return current();
    },

    set page(next: number) {
      goTo(next);
    },

    get pages() {
      return pages();
    },

    get perPage() {
      return state.perPage.get();
    },

    set perPage(next: number) {
      // read before it is written: the first item is where the old size put it
      const first = paginator.start;
      state.perPage.set(size(next));
      state.page.set(clampPage(Math.floor(first / state.perPage.get()), pages()));
    },

    previous: () => goTo(current() - 1),

    slice<T>(items: readonly T[]): T[] {
      const start = paginator.start;

      return items.slice(start, start + state.perPage.get());
    },

    get start() {
      return pageBounds(current(), state.perPage.get(), state.total.get()).start;
    },

    state,

    get total() {
      return state.total.get();
    },

    set total(next: number) {
      state.total.set(count(next));
      state.page.set(current());
    },
  };

  return paginator;
}

/** The four runs an indicator is made of, each its own text so each can be its own role. */
interface Slots {
  /** The dots after the current page, with a space before the first. */
  readonly after: string;
  /** The dots before the current page, with a space after the last. */
  readonly before: string;
  /** The current page's dot. */
  readonly dot: string;
  /** The number, with a space before it when dots come first. */
  readonly numeric: string;
}

/**
 * What an indicator says, as the runs it is drawn in.
 *
 * One function for the string and for the live view, so the two cannot disagree
 * about where a space goes or when a row of dots gives way to a number.
 *
 * @param page - The page, counting from zero.
 * @param pages - How many there are.
 * @param opts - The style and the glyphs.
 * @returns The four runs; one that is not drawn is empty.
 */
function slotsFor(page: number, pages: number, opts: PageIndicatorOptions): Slots {
  const style = opts.style ?? 'dots';
  const ascii = opts.ascii ?? !unicodeSupported(opts.env, opts.platform);
  const [active, inactive] = ascii ? GLYPHS.ascii : GLYPHS.unicode;
  const total = Math.max(1, count(pages));
  const at = clampPage(page, total);
  const dots = style !== 'numeric' && total <= Math.max(0, count(opts.maxDots ?? 10));
  const numeric = !dots || style === 'both';
  const row = (n: number): string =>
    Array(n)
      .fill(opts.inactive ?? inactive)
      .join(' ');
  const after = total - at - 1;

  return {
    after: dots && after > 0 ? ` ${row(after)}` : '',
    before: dots && at > 0 ? `${row(at)} ` : '',
    dot: dots ? (opts.active ?? active) : '',
    numeric: numeric
      ? `${dots ? ' ' : ''}${(opts.format ?? ((n, of) => `${n}/${of}`))(at + 1, total)}`
      : '',
  };
}

/** The runs of an indicator as text nodes, in the order they are drawn. */
interface Nodes {
  readonly after: Element;
  readonly before: Element;
  readonly dot: Element;
  readonly numeric: Element;
}

/**
 * Writes the runs into the nodes.
 *
 * A text drops the whitespace at the end of its last line, so a run of dots and
 * the space that separates it from the next is nothing at all unless it is given
 * the room it stands for: `pre` keeps the space and the width holds it.
 *
 * @param nodes - What to write into.
 * @param slots - What to write.
 */
function apply(nodes: Nodes, slots: Slots): void {
  for (const name of ['before', 'dot', 'after', 'numeric'] as const) {
    const run = slots[name];
    nodes[name].setText(run);
    nodes[name].setProps({ display: run === '' ? 'none' : 'flex', width: stringWidth(run) });
  }
}

/**
 * The text nodes and the row around them.
 *
 * @returns The tree, and the nodes to keep it up to date through.
 */
function build(): { element: Element; nodes: Nodes } {
  const run = (kind: string, role: string): Element =>
    textNode('', {
      class: `sigil-paginator-${kind}${role}`,
      'flex-shrink': 0,
      'white-space': 'pre',
    });

  const nodes: Nodes = {
    after: run('dots', ' sigil-paginator-inactive sigil-muted'),
    before: run('dots', ' sigil-paginator-inactive sigil-muted'),
    dot: run('dots', ' sigil-paginator-active sigil-accent'),
    numeric: run('numeric', ''),
  };

  return {
    element: box({ class: 'sigil-paginator' }, nodes.before, nodes.dot, nodes.after, nodes.numeric),
    nodes,
  };
}

/**
 * Builds the element tree for an indicator that is already decided.
 *
 * @param page - The page, counting from zero.
 * @param pages - How many pages there are.
 * @param opts - The style and the glyphs.
 * @returns The tree, and the room it takes.
 */
export function pageIndicatorView(
  page: number,
  pages: number,
  opts: PageIndicatorOptions = {}
): { element: Element; width: number } {
  const slots = slotsFor(page, pages, opts);
  const { element, nodes } = build();
  apply(nodes, slots);

  return {
    element,
    width: Math.max(
      1,
      stringWidth(slots.before + slots.dot + slots.after) + stringWidth(slots.numeric)
    ),
  };
}

/**
 * Where you are in a run of pages: `● ○ ○`, `2/5`, or both.
 *
 * Dots are one per page, the current one in the accent role and the rest muted,
 * so the position survives without colour as the filled dot against the hollow
 * ones. Past `maxDots` pages the dots give way to the number, because a row of
 * forty dots says nothing a number does not say better.
 *
 * Like `table()` it returns a string and the caller does the writing.
 *
 * @param page - The current page, counting from zero.
 * @param pages - How many pages there are.
 * @param opts - The style and the glyphs.
 * @returns The indicator, with no trailing newline.
 */
export function pageIndicator(
  page: number,
  pages: number,
  opts: PageIndicatorOptions = {}
): string {
  const { element, width } = pageIndicatorView(page, pages, opts);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    colorScheme: opts.colorScheme,
    width,
  });
}

/**
 * An indicator that follows a paginator, as an element tree.
 *
 * It reads the state inside an effect, so it redraws when the page turns, when
 * the total changes the number of pages, and when the page size does -- and, being
 * a function of the signals alone, it cannot show a page the paginator is not on.
 *
 * @param state - What it reads.
 * @param opts - The style and the glyphs.
 * @returns The tree.
 */
export function paginatorView(state: PaginatorState, opts: PageIndicatorOptions = {}): Element {
  const { element, nodes } = build();

  createEffect(() => {
    const pages = pageCount(state.total.get(), state.perPage.get());
    apply(nodes, slotsFor(clampPage(state.page.get(), pages), pages, opts));
  });

  return element;
}
