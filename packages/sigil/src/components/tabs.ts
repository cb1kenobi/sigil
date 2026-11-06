/**
 * Tabs: a row of labels with one active, and the panel that follows it.
 *
 * Textual's `TabbedContent`, and in a full-screen app it is how one screen holds
 * several views -- logs, settings, a summary -- without the app writing a `Show`
 * and a key map for each. {@link Tabs} owns the row and the panels; {@link
 * tabRowView} is the row alone, for an app that draws the panels itself.
 *
 * ```js
 * import { Tabs } from '@ttylabs/sigil/components';
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
 * another is showing, and is not in the focus ring. `AGENTS.md` has the reasons
 * under "Tabs".
 */

import { box, type Element, type ElementProps, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { DescribeOptions } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { stringWidth } from '../width/index.js';
import { truncate } from '../wrap/index.js';
import { labelLine, unicodeSupported } from './note.js';

/** One tab: its label, and the panel it shows. */
export interface Tab {
  /**
   * The panel, built once when the tabs are, whether this is the active tab or not.
   * A tab with no panel is a label only, which is what {@link tabRowView} takes.
   */
  children?: () => Element;
  /** What the tab says. One line: escape sequences and line breaks are taken out. */
  label: string;
}

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
  /** The tabs, in order. At least one. */
  tabs: readonly Tab[];
}

export interface TabRowProps {
  /** As {@link TabsProps.active}. */
  active?: number | State<number>;
  /** As {@link TabsProps.ascii}. */
  ascii?: boolean;
  /** The labels, in order. At least one. */
  labels: readonly string[];
  /** The row's own props. */
  props?: ElementProps;
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
  if (!Array.isArray(props.labels) || props.labels.length === 0) {
    throw new TypeError(__`Expected tab labels to be a non-empty array of strings`);
  }
  if (props.labels.some((label) => typeof label !== 'string')) {
    throw new TypeError(__`Expected tab labels to be a non-empty array of strings`);
  }
  if (
    props.active !== undefined &&
    typeof props.active !== 'number' &&
    !(props.active instanceof State)
  ) {
    throw new TypeError(__`Expected tabs active to be a number or a State`);
  }

  const labels = props.labels.map(labelLine);
  const count = labels.length;
  const full = labels.map((label) => stringWidth(label) + 2);
  const active = props.active instanceof State ? props.active : new State(props.active ?? 0);
  const marks = (props.ascii ?? !unicodeSupported()) ? MARKS.ascii : MARKS.unicode;

  /** The active index, kept inside the tabs whatever the app wrote. */
  const current = (): number => {
    const value = Math.trunc(active.get());
    return Number.isNaN(value) ? 0 : Math.min(Math.max(value, 0), count - 1);
  };

  const tabs = labels.map((label, i) => {
    const tab = textNode(` ${label} `, {
      class: 'sigil-tabs-tab sigil-muted',
      'flex-shrink': 0,
      width: full[i],
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
  });

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

  const host = box({ ...props.props, 'flex-direction': 'column', focusable: true });
  // added rather than written into the props, so an app's own `class` is kept
  host.addClass('sigil-tabs-row');
  host.append(labelRow, ruleLine);
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
   * Works out which tabs are drawn, and draws them.
   *
   * @returns Whether the tree changed, which is what `onResize` owes a frame.
   */
  const sync = (): boolean => {
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

  host.onResize = (element): boolean => {
    const size = element.content ?? element.box;
    room = size === undefined ? undefined : size.width;
    return sync();
  };

  createEffect(() => {
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
  if (!Array.isArray(props.tabs) || props.tabs.length === 0) {
    throw new TypeError(__`Expected tabs to be a non-empty array`);
  }
  for (const tab of props.tabs) {
    if (typeof tab?.label !== 'string') {
      throw new TypeError(__`Expected every tab to have a label that is a string`);
    }
    if (tab.children !== undefined && typeof tab.children !== 'function') {
      throw new TypeError(__`Expected tab children to be a function that builds the panel`);
    }
  }

  const row = tabRowView({
    active: props.active,
    ascii: props.ascii,
    labels: props.tabs.map((tab) => tab.label),
  });
  const active = ACTIVE.get(row) as State<number>;
  const count = props.tabs.length;

  const panels = props.tabs.map((tab) => {
    const panel = box({
      class: 'sigil-tabs-panel',
      'flex-direction': 'column',
      'flex-grow': 1,
    });
    if (tab.children) {
      panel.append(tab.children());
    }
    return panel;
  });
  const body = box(
    { class: 'sigil-tabs-panels', 'flex-direction': 'column', 'flex-grow': 1 },
    ...panels
  );

  const host = box({ ...props.props, 'flex-direction': 'column' });
  host.addClass('sigil-tabs');
  host.append(row, body);
  ROWS.set(host, row);
  ACTIVE.set(host, active);

  createEffect(() => {
    const value = Math.trunc(active.get());
    const now = Number.isNaN(value) ? 0 : Math.min(Math.max(value, 0), count - 1);
    for (const [i, panel] of panels.entries()) {
      panel.setProps({ display: i === now ? 'flex' : 'none' });
      panel.toggleClass('is-active', i === now);
    }
  });

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
