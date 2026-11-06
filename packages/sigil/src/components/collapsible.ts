/**
 * A collapsible: a section with a title that opens and closes what is under it.
 *
 * Textual's `Collapsible`, and in a CLI it is the long details of a result -- a
 * stack behind "show stack" -- or the advanced half of a form. An accordion is
 * several of them in one {@link collapsibleGroup}, with one open at a time.
 *
 * ```js
 * import { Collapsible, collapsibleGroup } from '@ttylabs/sigil/components';
 * import { text } from '@ttylabs/sigil/element';
 *
 * const details = Collapsible({
 *   title: 'Show stack',
 *   children: () => text(err.stack),
 * });
 * ```
 *
 * The title is focusable. Enter and Space flip it, Right opens it and Left closes
 * it, and a left click on it flips it. The body is built once and hidden with
 * `display: none` while closed, so whatever is inside it -- a scroll offset, a
 * field's contents -- is still there when it opens again.
 *
 * Opening and closing is instant. A height animation was considered and refused:
 * `AGENTS.md` has the reasons under "A collapsible".
 */

import { box, type Element, type ElementProps, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { DescribeOptions } from '../input/index.js';
import { createEffect, onCleanup } from '../renderer/index.js';
import { State } from '../signals/index.js';
import { unicodeSupported } from './note.js';

/**
 * An exclusive group: opening one member closes every other.
 *
 * Opaque, because the members are each collapsible's own `open` signal and the
 * group is only the rule between them -- there is no second record of which one
 * is open for the two to disagree about.
 */
export interface CollapsibleGroup {
  /** Closes every member. */
  closeAll(): void;
}

export interface CollapsibleProps {
  /**
   * Draw the marker with ASCII only, `>` and `v`. Defaults to what
   * `unicodeSupported()` says, which is the rule `outline()` and the charts keep.
   */
  ascii?: boolean;
  /** The body. Built once, whether the section starts open or not. */
  children?: () => Element;
  /**
   * An exclusive group to belong to.
   *
   * Opening a member closes the others, whether it was opened by a key, a click
   * or a `set(true)` on its signal. Closing the open one leaves none open.
   */
  group?: CollapsibleGroup;
  /**
   * Whether the section is open.
   *
   * A boolean is where it starts. A `State<boolean>` is the state itself: the
   * keys and the mouse write it, and an app that writes it opens or closes the
   * section, which is the shape `keyHelp()`'s `expanded` already has. Defaults to
   * closed.
   */
  open?: boolean | State<boolean>;
  /** The host box's own props: a class, a margin, a width. */
  props?: ElementProps;
  /** What the title says. */
  title: string;
}

/** Where a section's keys are described, which is the whole of what is asked of a router. */
export interface CollapsibleDescriber {
  describe(keys: string, opts: DescribeOptions): () => void;
}

/** The marker in front of the title, open and closed. */
const MARKS = {
  ascii: { closed: '>', open: 'v' },
  unicode: { closed: '▸', open: '▾' },
} as const;

/** Each group's members: their `open` signals, which are the truth. */
const MEMBERS = new WeakMap<CollapsibleGroup, Set<State<boolean>>>();

/** Each section's title, which is what is focused and what keys are described on. */
const TITLES = new WeakMap<Element, Element>();

/**
 * Makes an exclusive group, which is what an accordion is.
 *
 * @returns The group, to pass as `group` to each member.
 */
export function collapsibleGroup(): CollapsibleGroup {
  const members = new Set<State<boolean>>();
  const group: CollapsibleGroup = {
    closeAll(): void {
      for (const member of members) {
        member.set(false);
      }
    },
  };
  MEMBERS.set(group, members);
  return group;
}

/**
 * Builds a collapsible section.
 *
 * @param props - The title, whether it is open, the body, and the host's props.
 * @returns The host element.
 */
export function Collapsible(props: CollapsibleProps): Element {
  if (typeof props.title !== 'string') {
    throw new TypeError(__`Expected a collapsible title to be a string`);
  }
  if (props.children !== undefined && typeof props.children !== 'function') {
    throw new TypeError(__`Expected collapsible children to be a function that builds the body`);
  }
  if (
    props.open !== undefined &&
    typeof props.open !== 'boolean' &&
    !(props.open instanceof State)
  ) {
    // a truthy string would read as open and then never compare equal to `true`
    // again, which is the hole `toggle()` refuses its `initial` over
    throw new TypeError(__`Expected collapsible open to be a boolean or a State`);
  }

  const members = props.group === undefined ? undefined : MEMBERS.get(props.group);
  if (props.group !== undefined && members === undefined) {
    throw new TypeError(__`Expected collapsible group to come from collapsibleGroup()`);
  }

  const open = props.open instanceof State ? props.open : new State(props.open ?? false);
  const marks = (props.ascii ?? !unicodeSupported()) ? MARKS.ascii : MARKS.unicode;

  const marker = textNode('', {
    class: 'sigil-collapsible-marker sigil-accent',
    'flex-shrink': 0,
    'margin-right': 1,
    'white-space': 'nowrap',
  });
  const label = textNode(props.title, { class: 'sigil-collapsible-label' });
  // the title is what the ring stops on, rather than the host: a key typed into
  // something focused inside the body bubbles through the host, and Enter there
  // belongs to that something rather than to the section around it
  const title = box(
    { class: 'sigil-collapsible-title', 'flex-direction': 'row', focusable: true },
    marker,
    label
  );
  // the focus role on the title itself, which is the one part that says the keys
  // go here: inverted while focused, so a Tab onto it does not look like a Tab
  // that did nothing
  title.onFocusChange = (_, focused): void => {
    title.toggleClass('sigil-focus', focused);
  };
  // indented by the marker and its margin, so the body hangs under the title's
  // text rather than under the triangle
  const body = box({
    class: 'sigil-collapsible-body',
    'flex-direction': 'column',
    'padding-left': 2,
  });
  if (props.children) {
    body.append(props.children());
  }

  const host = box({ ...props.props, 'flex-direction': 'column' });
  // added rather than written into the props, so an app's own `class` is kept,
  // which is the rule `ScrollBox` keeps
  host.addClass('sigil-collapsible');
  host.append(title, body);
  TITLES.set(host, title);

  if (members) {
    members.add(open);
    // a section built inside a component leaves its group when the component
    // goes; one built outside any owner stays a member, and closing a section
    // nobody can see costs nothing
    onCleanup(() => members.delete(open));
  }

  createEffect(() => {
    const now = open.get();
    body.setProps({ display: now ? 'flex' : 'none' });
    marker.setText(now ? marks.open : marks.closed);
    host.toggleClass('is-open', now);

    if (now && members) {
      // here rather than in the key handler, so that an app opening a member by
      // writing its signal closes the others too
      for (const other of members) {
        if (other !== open) {
          other.set(false);
        }
      }
    }
  });

  title.onKey = (event): void => {
    const k = event.key;
    // a paste is not a keystroke: a pasted line ending in a newline is not an
    // Enter on whatever happened to be focused. A modifier makes it another key
    if (event.paste || k.ctrl || k.meta || k.shift) {
      return;
    }

    switch (k.name) {
      case 'enter':
      case 'space': {
        open.set(!open.get());
        break;
      }
      // the arrows are claimed only where they change something, so an arrow
      // that would do nothing reaches the pane around the section
      case 'right': {
        if (open.get()) {
          return;
        }
        open.set(true);
        break;
      }
      case 'left': {
        if (!open.get()) {
          return;
        }
        open.set(false);
        break;
      }
      default: {
        return;
      }
    }

    event.stop();
  };

  title.onMouse = (event): void => {
    // the click rather than the press, so the press keeps its default action --
    // focusing the title -- and a press dragged off the title toggles nothing.
    // A wheel is left to bubble to whatever scrolls
    if (event.kind !== 'click' || event.button !== 'left') {
      return;
    }
    open.set(!open.get());
    event.stop();
  };

  return host;
}

/**
 * Describes a section's keys to a router, for a key-help footer.
 *
 * Scoped to the title, which is the one element whose focus makes the keys
 * apply. A helper rather than an option because a router is built from the tree
 * the section is in, so it does not exist yet while the section is being built.
 *
 * @param router - What to describe the keys to.
 * @param sections - Hosts that `Collapsible()` returned.
 * @returns Takes every description back off.
 */
export function describeCollapsible(
  router: CollapsibleDescriber,
  ...sections: readonly Element[]
): () => void {
  const titles = sections.map((section) => {
    const found = TITLES.get(section);
    if (found === undefined) {
      throw new TypeError(__`Expected an element that Collapsible() returned`);
    }
    return found;
  });

  const off: Array<() => void> = [];
  for (const scope of titles) {
    off.push(
      router.describe('enter', { description: __`toggle`, priority: 1, scope }),
      router.describe('space', { description: __`toggle`, priority: 1, scope }),
      router.describe('right', { description: __`open`, scope }),
      router.describe('left', { description: __`close`, scope })
    );
  }

  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
