/**
 * Tabs: a row of labels with one active, and the panel that follows it.
 *
 * Textual's `TabbedContent`, and in a full-screen app it is how one screen holds
 * several views -- logs, settings, a summary -- without the app writing a `Show`
 * and a key map for each. {@link Tabs} owns the row and the panels; {@link
 * tabRowView} is the row alone, for an app that draws the panels itself.
 *
 * ```js
 * import { Tabs } from '@ttylabs/sigil/components/tabs';
 * import { text } from '@ttylabs/sigil/element';
 *
 * const tabs = Tabs({
 *   tabs: [
 *     { label: 'Logs', children: () => logPane() },
 *     { label: 'Settings', children: () => text('...') },
 *   ],
 * });
 * ```
 *
 * The row is focusable. Left and Right move to the previous and next tab, Home and
 * End to the first and last, `1` to `9` to that tab, and a left click on a label
 * picks it. Every panel is built once and the inactive ones are `display: none`,
 * so a panel keeps what is in it -- a scroll offset, a field's contents -- while
 * another is showing, and is not in the focus ring.
 *
 * The tabs can be a `State`, a `Computed` or a function of the list, and a label
 * one of a string, so a tab can be opened, closed or renamed -- a dirty mark on an
 * editor's tab -- while the row is up: a tab's panel is built when the tab first
 * appears and disposed when it goes. `AGENTS.md` has the reasons under "Tabs".
 */

import {
  box,
  type Element,
  type ElementProps,
  type ElementPropsWithout,
  text as textNode,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { DescribeOptions } from '../input/index.js';
import { createEffect, For } from '../renderer/index.js';
import { Computed, State } from '../signals/index.js';
import { stringWidth } from '../width/index.js';
import { truncate } from '../wrap/index.js';
import { labelLine, unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';

/**
 * Something read live: anything with a `get()` -- a `State`, a `Computed` -- or a
 * function, read inside an effect so the row follows it.
 */
export type TabsLive<T> = { get(): T } | (() => T);

/** One tab: its label, and the panel it shows. */
export interface Tab {
  /**
   * The panel, built once, when the tab first appears, whether it is the active tab
   * or not, and disposed when the tab is taken out of a live list. A tab with no
   * panel is a label only, which is what {@link tabRowView} takes.
   */
  children?: () => Element;
  /**
   * What the tab says. One line: escape sequences and line breaks are taken out.
   * A `State`, a `Computed` or a function is read live, so the label can change --
   * a mark coming and going -- without the tabs being built again.
   */
  label: string | TabsLive<string>;
}

/** What a row reads its labels from: an array, or a live one, which may be empty. */
export type TabLabels = readonly string[] | TabsLive<readonly string[]>;

export interface TabsProps {
  /**
   * Which tab is active, as a zero-based index.
   *
   * A number is where it starts. A `State<number>` is the state itself: the keys
   * and the mouse write it, and an app that writes it switches the tab -- the shape
   * `Collapsible`'s `open` has. An index past either end is read as the nearest
   * tab rather than refused, since an app writes it. Defaults to the first.
   */
  active?: number | State<number>;
  /**
   * Draw the row with ASCII only. Defaults to what `unicodeSupported()` says, which
   * is the rule `Collapsible` and the charts keep.
   */
  ascii?: boolean;
  /** The host box's own props: a class, a margin, a width, a height. */
  props?: ElementProps;
  /**
   * The tabs, in order. An array is at least one, and fixed.
   *
   * A `State`, a `Computed` or a function is read live, and may be empty: a tab
   * that appears has its panel built, one that goes has it removed and disposed,
   * and one kept -- the same object, wherever it moved -- keeps its panel and what
   * is in it. `active` is a position, so an app taking out a tab before the active
   * one writes `active` too, as it would to keep any other position.
   */
  tabs: readonly Tab[] | TabsLive<readonly Tab[]>;
}

export interface TabRowProps {
  /** As {@link TabsProps.active}. */
  active?: number | State<number>;
  /** As {@link TabsProps.ascii}. */
  ascii?: boolean;
  /**
   * The labels, in order. An array is at least one, and fixed; a `State`, a
   * `Computed` or a function is read live and may be empty, and an empty row draws
   * nothing and leaves the focus ring until it has a tab again.
   */
  labels: TabLabels;
  /** The row's own props. */
  props?: ElementPropsWithout<'onFocusChange' | 'onKey' | 'onResize'>;
}

/** Where a row's keys are described, which is the whole of what is asked of a router. */
export interface TabsDescriber {
  describe(keys: string, opts: DescribeOptions): () => void;
}

/** What the row draws with, unicode and ASCII. */
const MARKS = {
  ascii: { active: '=', left: '<', right: '>', rest: '-' },
  unicode: { active: '━', left: '‹', right: '›', rest: '─' },
} as const;

/** Each row's focusable element, which is the row itself; and each `Tabs` host's row. */
const ROWS = new WeakMap<Element, Element>();

/** Each row's and each `Tabs` host's active index. */
const ACTIVE = new WeakMap<Element, State<number>>();

/** Whether a value is read live, rather than being the thing itself. */
function isLive<T>(value: unknown): value is TabsLive<T> {
  return (
    typeof value === 'function' ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { get?: unknown }).get === 'function')
  );
}

/** Reads a value that may be live, inside whatever effect asks. */
function readLive<T>(value: T | TabsLive<T>): T {
  if (typeof value === 'function') {
    return (value as () => T)();
  }
  return isLive<T>(value) ? (value as { get(): T }).get() : (value as T);
}

/** Puts `next` in place of a parent's children if it is not already what they are. */
function setChildren(host: Element, next: readonly Element[]): void {
  const now = host.children;
  if (now.length === next.length && now.every((child, i) => child === next[i])) {
    return;
  }
  // a copy, because taking a child out changes the list being walked
  for (const child of now.slice()) {
    host.removeChild(child);
  }
  host.append(...next);
}

/**
 * Builds the row of tabs on its own.
 *
 * The labels, one line, and under them a rule with the active tab's stretch of it
 * drawn heavy and in the accent. The width is the one the layout gives the row
 * rather than one passed in, learned through `onResize`, so a row that is too
 * narrow for its labels scrolls to keep the active one in view and shows `‹` or
 * `›` on the side that is clipped. A row in a layout that sizes it to its content
 * -- a child of a flex row with no width -- is never too narrow, and shows all of
 * it.
 *
 * @param props - The labels, which is active, and the host's props.
 * @returns The row, which is the focusable element and carries the keys.
 */
export function tabRowView(props: TabRowProps): Element {
  refuseOwnedHooks('tabRowView', props.props, ['onKey', 'onFocusChange', 'onResize']);
  const live = isLive<readonly string[]>(props.labels);
  if (!live && (!Array.isArray(props.labels) || props.labels.length === 0)) {
    throw new TypeError(__`Expected tab labels to be a non-empty array of strings`);
  }
  if (!live && (props.labels as readonly unknown[]).some((label) => typeof label !== 'string')) {
    throw new TypeError(__`Expected tab labels to be a non-empty array of strings`);
  }
  if (
    props.active !== undefined &&
    typeof props.active !== 'number' &&
    !(props.active instanceof State)
  ) {
    throw new TypeError(__`Expected tabs active to be a number or a State`);
  }

  const active = props.active instanceof State ? props.active : new State(props.active ?? 0);
  const marks = (props.ascii ?? !unicodeSupported()) ? MARKS.ascii : MARKS.unicode;

  /** The labels as drawn, one line each. */
  let labels: string[] = [];
  /** How wide each label is drawn whole: its text and a space either side. */
  let full: number[] = [];
  /** One text per label, kept by position, so a label that changes is the same element. */
  const tabs: Element[] = [];
  let count = 0;

  /** The active index, kept inside the tabs whatever the app wrote. */
  const current = (): number => {
    const value = Math.trunc(active.get());
    return Number.isNaN(value) || count === 0 ? 0 : Math.min(Math.max(value, 0), count - 1);
  };

  /** A label's text, which a click on picks the tab in that position. */
  const makeTab = (i: number): Element => {
    const tab = textNode('', {
      class: 'sigil-tabs-tab sigil-muted',
      'flex-shrink': 0,
      'white-space': 'pre',
    });
    // the click rather than the press, so the press keeps its default action --
    // focusing the row -- and a press dragged off the label picks nothing
    tab.onMouse = (event): void => {
      if (event.kind !== 'click' || event.button !== 'left') {
        return;
      }
      active.set(i);
      event.stop();
    };
    return tab;
  };

  const more = (class_: string) =>
    textNode(' ', { class: `sigil-tabs-more sigil-muted ${class_}`, 'flex-shrink': 0, width: 1 });
  const left = more('sigil-tabs-more-left');
  const right = more('sigil-tabs-more-right');
  const filler = textNode('', {
    class: 'sigil-tabs-filler',
    'flex-shrink': 0,
    'white-space': 'pre',
  });

  const rule = (class_: string) =>
    textNode('', { class: `sigil-tabs-rule ${class_}`, 'flex-shrink': 0, 'white-space': 'pre' });
  const before = rule('sigil-muted');
  const lit = rule('sigil-accent');
  const after = rule('sigil-muted');

  const labelRow = box({ class: 'sigil-tabs-labels', 'flex-direction': 'row' });
  const ruleLine = box({ class: 'sigil-tabs-rules', 'flex-direction': 'row' });

  const host = box({ ...props.props, 'flex-direction': 'column', focusable: !live });
  // added rather than written into the props, so an app's own `class` is kept
  host.addClass('sigil-tabs-row');
  host.append(labelRow, ruleLine);
  /** Whether a change of labels has borrowed `onLayout` for the next layout. */
  let borrowed: ((element: Element) => boolean) | undefined;
  ROWS.set(host, host);
  ACTIVE.set(host, active);

  /** The room the layout gave the row, once it has. */
  let room: number | undefined;
  /** The first tab drawn, kept between calls so the row moves only when it must. */
  let first = 0;
  /** What was drawn last, to say whether this call changed the tree. */
  let drawn = '';
  /** Whether the row has the focus, which only the active label shows. */
  let focused = false;
  /** What each text was last given, because a write marks layout even when it is the same. */
  const given = new Map<Element, string>();

  const put = (element: Element, value: string, width = stringWidth(value)): void => {
    const key = `${width}|${value}`;
    if (given.get(element) === key) {
      return;
    }
    given.set(element, key);
    element.setText(value);
    element.setProp('width', width);
  };

  /**
   * Takes a new list of labels: texts are added or dropped at the end and the rest
   * kept, by position, since a label is a string and has no other identity.
   */
  const relabel = (next: readonly unknown[]): void => {
    if (!Array.isArray(next) || next.some((label) => typeof label !== 'string')) {
      throw new TypeError(__`Expected tab labels to be an array of strings`);
    }
    const lines = (next as readonly string[]).map(labelLine);
    if (lines.length === count && lines.every((line, i) => line === labels[i])) {
      return;
    }
    labels = lines;
    full = labels.map((label) => stringWidth(label) + 2);
    while (tabs.length < labels.length) {
      tabs.push(makeTab(tabs.length));
    }
    for (const gone of tabs.splice(labels.length)) {
      given.delete(gone);
    }
    if (count > 0 !== labels.length > 0) {
      // a row with no tabs has nothing for its keys to do, so it is not a stop
      host.setProp('focusable', labels.length > 0);
    }
    count = labels.length;
    // drawn into a room before, or still waiting on a borrow an app's own
    // assignment has since put out of reach, which would otherwise leave the row
    // drawn whole until its size moved
    if (room !== undefined || borrowed !== undefined) {
      // the room the layout last gave may be only what the old labels came to: a
      // row sized to its content is as wide as it drew, so windowing new labels
      // into it would keep it that width for good. So they are drawn whole, as
      // before the first layout, and the next layout says what the room is --
      // through `onLayout`, once, because a row whose size does not move is never
      // told it again through `onResize`. An `onLayout` of the app's own is kept
      room = undefined;
      if (host.onLayout !== borrowed || borrowed === undefined) {
        // whatever is there now, which an app may have set after the row was built
        const own = host.onLayout;
        const hook = (element: Element): boolean => {
          host.onLayout = own;
          borrowed = undefined;
          const theirs = own?.(element) === true;
          return measure(element) || theirs;
        };
        borrowed = hook;
        host.onLayout = hook;
      }
    }
  };

  /**
   * Works out which tabs are drawn, and draws them.
   *
   * @returns Whether the tree changed, which is what `onResize` owes a frame.
   */
  const sync = (): boolean => {
    if (count === 0) {
      // an empty live row draws nothing at all, not a rule under no labels, so
      // it takes no room until a tab is opened
      setChildren(labelRow, []);
      setChildren(ruleLine, []);
      host.toggleClass('is-scrolling', false);
      const changed = drawn !== 'empty';
      drawn = 'empty';
      return changed;
    }
    const now = current();
    const total = full.reduce((sum, w) => sum + w, 0);
    const overflow = room !== undefined && total > room;
    // a cell at each end is kept for the indicators whenever the row scrolls, so a
    // tab does not move one column as an indicator appears
    const avail = overflow ? Math.max(1, (room ?? 0) - 2) : Number.POSITIVE_INFINITY;
    const shown = full.map((w) => Math.min(w, avail));

    const lastFor = (start: number): number => {
      let used = 0;
      let end = start - 1;
      while (end + 1 < count && used + (shown[end + 1] ?? 0) <= avail) {
        used += shown[++end] ?? 0;
      }
      return Math.max(end, start);
    };
    const span = (a: number, b: number): number => {
      let used = 0;
      for (let i = a; i <= b; i++) {
        used += shown[i] ?? 0;
      }
      return used;
    };

    let start = overflow ? Math.min(first, count - 1) : 0;
    if (overflow) {
      if (now < start) {
        start = now;
      }
      while (lastFor(start) < now) {
        start++;
      }
      // the tail of the list uses the room it has rather than leaving it empty
      if (lastFor(start) === count - 1) {
        while (start > 0 && span(start - 1, count - 1) <= avail) {
          start--;
        }
      }
      first = start;
    }
    const end = overflow ? lastFor(start) : count - 1;
    const visible = tabs.slice(start, end + 1);

    for (const [i, tab] of tabs.entries()) {
      const on = i === now;
      tab.toggleClass('sigil-tabs-active', on);
      tab.toggleClass('sigil-accent', on);
      tab.toggleClass('sigil-heading', on);
      tab.toggleClass('sigil-muted', !on);
      tab.toggleClass('sigil-focus', on && focused);
      if (i >= start && i <= end) {
        const cut =
          (shown[i] ?? 0) < (full[i] ?? 0)
            ? ` ${truncate(labels[i] ?? '', Math.max(1, (shown[i] ?? 0) - 2), 'ellipsis')} `
            : ` ${labels[i]} `;
        put(tab, cut, shown[i]);
      }
    }
    host.toggleClass('is-scrolling', overflow);

    const drawnWidth = overflow ? (room ?? 0) : total;
    const used = span(start, end);
    const pad = overflow ? Math.max(0, drawnWidth - 2 - used) : 0;
    put(left, overflow && start > 0 ? marks.left : ' ');
    put(right, overflow && end < count - 1 ? marks.right : ' ');
    put(filler, ' '.repeat(pad), pad);

    // the rule runs under the whole row: the room the layout gave it where there is
    // one, or what the labels come to where they were never asked to fit
    const line = Math.max(room ?? 0, total);
    const lead = (overflow ? 1 : 0) + span(start, now - 1);
    const stretch = shown[now] ?? 0;
    const rest = Math.max(0, (overflow ? drawnWidth : line) - lead - stretch);
    put(before, marks.rest.repeat(lead), lead);
    put(lit, marks.active.repeat(stretch), stretch);
    put(after, marks.rest.repeat(rest), rest);

    setChildren(labelRow, [
      ...(overflow ? [left] : []),
      ...visible,
      ...(overflow ? [filler, right] : []),
    ]);
    setChildren(
      ruleLine,
      [
        [before, lead],
        [lit, stretch],
        [after, rest],
      ].flatMap(([part, width]) => ((width as number) > 0 ? [part as Element] : []))
    );

    const signature = `${room}|${start}|${end}|${now}|${[...given.values()].join(',')}`;
    const changed = signature !== drawn;
    drawn = signature;
    return changed;
  };

  /** Records the room the layout gave the row, and draws what fits it. */
  function measure(element: Element): boolean {
    const size = element.content ?? element.box;
    room = size === undefined ? undefined : size.width;
    return sync();
  }
  host.onResize = measure;

  if (!live) {
    relabel(props.labels as readonly string[]);
  }

  createEffect(() => {
    if (live) {
      relabel(readLive(props.labels));
    }
    active.get();
    sync();
  });

  // the focus role on the active label alone, because the row is what the keys go
  // to and the active label is the one thing they change; moved by `sync()` when
  // the active tab changes under a focused row
  host.onFocusChange = (_, now): void => {
    focused = now;
    tabs[current()]?.toggleClass('sigil-focus', now);
  };

  host.onKey = (event): void => {
    const k = event.key;
    // a paste is not a keystroke, and a modifier makes it another key
    if (event.paste || k.ctrl || k.meta || k.shift) {
      return;
    }

    if (count === 0) {
      return;
    }
    const now = current();
    let target: number;
    switch (k.name) {
      case 'left': {
        target = now - 1;
        break;
      }
      case 'right': {
        target = now + 1;
        break;
      }
      case 'home': {
        target = 0;
        break;
      }
      case 'end': {
        target = count - 1;
        break;
      }
      default: {
        if (!/^[1-9]$/.test(k.name)) {
          return;
        }
        target = Number(k.name) - 1;
        // a number with no tab behind it is not ours
        if (target >= count) {
          return;
        }
        active.set(target);
        event.stop();
        return;
      }
    }

    // the arrows and Home and End are claimed only where they change something, so
    // one that would do nothing reaches the pane around the row
    if (target < 0 || target >= count || target === now) {
      return;
    }
    active.set(target);
    event.stop();
  };

  return host;
}

/**
 * Builds tabs: the row, and the panels it switches.
 *
 * @param props - The tabs, which is active, and the host's props.
 * @returns The host element, a column of the row over the panels.
 */
export function Tabs(props: TabsProps): Element {
  const live = isLive<readonly Tab[]>(props.tabs);
  if (!live && (!Array.isArray(props.tabs) || props.tabs.length === 0)) {
    throw new TypeError(
      __`Expected tabs to be a non-empty array, or a State, a Computed or a function of one`
    );
  }

  /** Refuses a tab that cannot be drawn, which a live list can hand over at any time. */
  const check = (tabs: unknown): readonly Tab[] => {
    if (!Array.isArray(tabs)) {
      throw new TypeError(
        __`Expected tabs to be a non-empty array, or a State, a Computed or a function of one`
      );
    }
    for (const tab of tabs as readonly Tab[]) {
      if (typeof tab?.label !== 'string' && !isLive(tab?.label)) {
        throw new TypeError(
          __`Expected every tab to have a label that is a string, or a State, a Computed or a function of one`
        );
      }
      if (tab.children !== undefined && typeof tab.children !== 'function') {
        throw new TypeError(__`Expected tab children to be a function that builds the panel`);
      }
    }
    return tabs as readonly Tab[];
  };

  // an array is checked here, where a mistake is the caller's to see; a live list
  // every time it is read, which is where it can go wrong
  const fixed = live ? undefined : check(props.tabs);
  const list = fixed ?? new Computed(() => check(readLive(props.tabs)));
  const read = (): readonly Tab[] => fixed ?? (list as Computed<readonly Tab[]>).get();
  const still = fixed !== undefined && fixed.every((tab) => typeof tab.label === 'string');

  const row = tabRowView({
    active: props.active,
    ascii: props.ascii,
    // a fixed list of fixed labels is the row's fixed array, refused there when
    // empty; anything live is the row's live list, read through each label
    labels: still
      ? fixed.map((tab) => tab.label as string)
      : () => read().map((tab) => readLive(tab.label)),
  });
  const active = ACTIVE.get(row) as State<number>;

  // keyed by the tab object, so one kept across a change keeps its panel and what
  // is in it, and one that goes is disposed with everything it built
  const body = For<Tab>({
    children: (tab, index) => {
      const panel = box({
        class: 'sigil-tabs-panel',
        'flex-direction': 'column',
        'flex-grow': 1,
      });
      if (tab.children) {
        panel.append(tab.children());
      }
      createEffect(() => {
        const count = read().length;
        const value = Math.trunc(active.get());
        const now = Number.isNaN(value) ? 0 : Math.min(Math.max(value, 0), count - 1);
        const on = index() === now;
        panel.setProps({ display: on ? 'flex' : 'none' });
        panel.toggleClass('is-active', on);
      });
      return panel;
    },
    each: read,
    props: { class: 'sigil-tabs-panels', 'flex-direction': 'column', 'flex-grow': 1 },
  });

  const host = box({ ...props.props, 'flex-direction': 'column' });
  host.addClass('sigil-tabs');
  host.append(row, body);
  ROWS.set(host, row);
  ACTIVE.set(host, active);

  return host;
}

/**
 * The active tab of a row or of tabs, as the state that holds it.
 *
 * For an app that passed a number, which starts the tabs somewhere and hands the
 * state to nobody: read it with `.get()`, switch tabs with `.set()`.
 *
 * @param host - What `Tabs()` or `tabRowView()` returned.
 * @returns The state.
 */
export function tabsActive(host: Element): State<number> {
  const found = ACTIVE.get(host);
  if (found === undefined) {
    throw new TypeError(__`Expected an element that Tabs() or tabRowView() returned`);
  }
  return found;
}

/**
 * Describes a row's keys to a router, for a key-help footer.
 *
 * Scoped to the row, which is the one element whose focus makes the keys apply.
 * The digits are not described: nine more entries in a footer to say what "1 to 9"
 * says in a README.
 *
 * @param router - What to describe the keys to.
 * @param tabs - Hosts or rows that `Tabs()` or `tabRowView()` returned.
 * @returns Takes every description back off.
 */
export function describeTabs(router: TabsDescriber, ...tabs: readonly Element[]): () => void {
  const scopes = tabs.map((host) => {
    const found = ROWS.get(host);
    if (found === undefined) {
      throw new TypeError(__`Expected an element that Tabs() or tabRowView() returned`);
    }
    return found;
  });

  const off: Array<() => void> = [];
  for (const scope of scopes) {
    off.push(
      router.describe('left', { description: __`previous tab`, scope }),
      router.describe('right', { description: __`next tab`, scope }),
      router.describe('home', { description: __`first tab`, scope }),
      router.describe('end', { description: __`last tab`, scope })
    );
  }

  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
