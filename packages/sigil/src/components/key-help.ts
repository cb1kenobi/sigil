import { box, type Element, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { BindingInfo } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import type { State } from '../signals/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { stringWidth } from '../width/index.js';

/**
 * Where a footer reads its keys from.
 *
 * A type and not the router's module, so that importing the footer does not put
 * the key router behind it: `InputRouter.bindings()` is the whole of what it
 * asks.
 */
export interface KeyHelpSource {
  bindings(): readonly BindingInfo[];
}

export interface KeyHelpOptions {
  /**
   * Whether to list every binding under its group, one to a line.
   *
   * A signal reads on every render, so an app wires `?` to `.set()` and the footer
   * follows. A plain boolean is a footer that never changes shape.
   */
  expanded?: boolean | State<boolean>;
  /**
   * The terminal whose width the short form is fitted to before the layout has
   * said how wide its box is. A frame tells the footer after its layout and before
   * it paints, so this is a guess no frame draws.
   */
  terminal?: { readonly width: number };
  /**
   * How many columns the short form may use, where the app would rather say than
   * let the layout decide.
   *
   * Left out, the footer is fitted to the box the layout gives it and fitted again
   * whenever that box changes size, which is a terminal resize as much as anything.
   * Given, the layout is not asked: a number is that many columns for good, and a
   * function is asked again whenever the bindings or the focus change -- and not
   * on a resize unless it reads a signal the resize writes.
   */
  width?: number | (() => number);
}

/** One line of help: a key, or several that do the same thing, and what they do. */
export interface KeyHelpEntry {
  readonly description: string;
  readonly group: string | undefined;
  /** Every key spelling that does it, ready to print. */
  readonly label: string;
  readonly priority: number;
}

/** What each name is printed as, where it is not the name. */
const ARROWS: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  down: '↓',
  left: '←',
  right: '→',
  up: '↑',
});

/**
 * Prints one key the way a reader would say it.
 *
 * Arrows are glyphs, which need no translation, and the names that are words go
 * through `__` -- each a literal, because the tag keys on its literal parts and
 * `__`${name}`` would key on `{0}`. A catalog can therefore say `Eingabe` for
 * `enter`. The modifiers nest one at a time, so that `ctrl-{0}` and `alt-{0}`
 * are the same two messages the prompts already carry and a translator who
 * writes `Strg+{0}` has written it once.
 *
 * @param name - The key's name as the decoder gives it.
 * @returns What to print for it.
 */
function nameLabel(name: string): string {
  const glyph = ARROWS[name];
  if (glyph) {
    return glyph;
  }

  switch (name) {
    case 'backspace':
      return __`backspace`;
    case 'delete':
      return __`delete`;
    case 'end':
      return __`end`;
    case 'enter':
      return __`enter`;
    case 'escape':
      return __`esc`;
    case 'home':
      return __`home`;
    case 'pagedown':
      return __`pgdn`;
    case 'pageup':
      return __`pgup`;
    case 'space':
      return __`space`;
    case 'tab':
      return __`tab`;
    default:
      return name;
  }
}

/**
 * Prints a key spelled the way `formatKey()` spells it.
 *
 * Read back off the canonical spelling rather than off a `KeyPattern`, because
 * the spelling is what the router publishes and is fixed: modifiers first, in an
 * order, then the name. A name is never one that contains a `+` unless it is the
 * `+` key itself, which `ctrl++` leaves as the last character.
 *
 * @param spec - One key, canonically spelled.
 * @returns The printed key.
 */
function keyLabelOf(spec: string): string {
  let rest = spec;
  const mods = new Set<string>();
  for (const mod of ['ctrl', 'alt', 'shift']) {
    if (rest.startsWith(`${mod}+`) && rest.length > mod.length + 1) {
      mods.add(mod);
      rest = rest.slice(mod.length + 1);
    }
  }

  let label = nameLabel(rest);
  if (mods.has('shift')) {
    label = __`shift-${label}`;
  }
  if (mods.has('alt')) {
    label = __`alt-${label}`;
  }
  if (mods.has('ctrl')) {
    label = __`ctrl-${label}`;
  }
  return label;
}

/**
 * Prints a binding's keys, which may be a sequence.
 *
 * @param keys - The canonical spelling of one key or several, space separated.
 * @returns The printed keys, a space between each of a sequence.
 */
export function keyLabel(keys: string): string {
  return keys
    .split(' ')
    .filter((spec) => spec !== '')
    .map((spec) => keyLabelOf(spec))
    .join(' ');
}

/**
 * Turns the router's bindings into lines of help.
 *
 * Bindings that do the same thing under the same group are one line --
 * `↑/↓ move` is two `bind()` calls with one description -- and the line sits
 * where the first of them did and takes the highest priority of the set, since a
 * line is as important as the most important key on it. Two bindings of one key
 * and one description are one key rather than `q/q`.
 *
 * @param infos - What `InputRouter.bindings()` returned.
 * @returns The lines, in the order the bindings were given.
 */
export function keyHelpEntries(infos: readonly BindingInfo[]): KeyHelpEntry[] {
  const lines = new Map<
    string,
    { description: string; group: string | undefined; labels: string[]; priority: number }
  >();

  for (const info of infos) {
    // whitespace folded, so that a description with a newline in it cannot make
    // the one-line form two lines
    const description = info.description.replace(/\s+/g, ' ').trim();
    if (description === '') {
      continue;
    }
    // a record separator no description will contain, rather than a delimiter that
    // could be part of one
    const id = `${info.group ?? ''}\u001f${description}`;
    const label = keyLabel(info.keys);
    const line = lines.get(id);
    if (line === undefined) {
      lines.set(id, {
        description,
        group: info.group,
        labels: [label],
        priority: info.priority,
      });
    } else {
      if (!line.labels.includes(label)) {
        line.labels.push(label);
      }
      line.priority = Math.max(line.priority, info.priority);
    }
  }

  return [...lines.values()].map((line) => ({
    description: line.description,
    group: line.group,
    label: line.labels.join('/'),
    priority: line.priority,
  }));
}

/** Columns a line takes: the key, a space, and what it does. */
function lineWidth(entry: KeyHelpEntry): number {
  return stringWidth(entry.label) + 1 + stringWidth(entry.description);
}

/** The ` · ` between two lines, and the ` …` that says some were left out. */
const SEPARATOR_WIDTH = 3;
const MORE_WIDTH = 2;

/**
 * Chooses which lines fit on one row.
 *
 * Lowest priority goes first, and among equals the one furthest along, so the
 * row loses its tail before it loses its head. Whole lines only: a binding cut
 * in half is a key with half a sentence, which is worse than the key missing.
 * When anything was dropped the row ends in an ellipsis, and its two columns are
 * paid for before the fit is judged rather than after, or a row that just fit
 * would overflow by the mark that explains it.
 *
 * @param entries - The lines, in order.
 * @param width - Columns available.
 * @returns What survives, in its original order, and whether anything did not.
 */
export function fitKeyHelp(
  entries: readonly KeyHelpEntry[],
  width: number
): { shown: KeyHelpEntry[]; truncated: boolean } {
  const room = Number.isFinite(width) ? Math.floor(width) : Number.MAX_SAFE_INTEGER;
  const kept = [...entries];

  const total = (): number =>
    kept.reduce((sum, entry) => sum + lineWidth(entry), 0) +
    SEPARATOR_WIDTH * Math.max(0, kept.length - 1);

  if (total() <= room) {
    return { shown: kept, truncated: false };
  }

  // an ellipsis is owed from here on, so the budget shrinks by its width
  const budget = room - MORE_WIDTH;
  while (kept.length > 0 && total() > budget) {
    let drop = 0;
    for (const [i, entry] of kept.entries()) {
      // `<=` so that a tie goes to the later one
      if (entry.priority <= (kept[drop] as KeyHelpEntry).priority) {
        drop = i;
      }
    }
    kept.splice(drop, 1);
  }

  return { shown: kept, truncated: true };
}

/** Whether the footer is in its long form right now. */
function isExpanded(expanded: KeyHelpOptions['expanded']): boolean {
  return typeof expanded === 'object' ? expanded.get() : expanded === true;
}

/** The short form: one row, truncated to fit. */
function shortRows(entries: readonly KeyHelpEntry[], width: number): Element[] {
  const { shown, truncated } = fitKeyHelp(entries, width);
  const out: Element[] = [];

  for (const [i, entry] of shown.entries()) {
    if (i > 0) {
      out.push(
        textNode('·', {
          class: 'sigil-key-help-sep sigil-muted',
          'flex-shrink': 0,
          'margin-left': 1,
          'margin-right': 1,
          'white-space': 'nowrap',
        })
      );
    }
    out.push(
      textNode(entry.label, {
        class: 'sigil-key-help-key sigil-accent',
        'flex-shrink': 0,
        'white-space': 'nowrap',
      }),
      textNode(entry.description, {
        class: 'sigil-key-help-desc sigil-muted',
        'flex-shrink': 0,
        'margin-left': 1,
        'white-space': 'nowrap',
      })
    );
  }

  // alone it takes one column, and none at all where there is no room: a row
  // that overflows by the mark meant to say it was cut is worse than silence
  if (truncated && (shown.length > 0 || width >= 1)) {
    out.push(
      textNode('…', {
        class: 'sigil-key-help-more sigil-muted',
        'flex-shrink': 0,
        'margin-left': shown.length > 0 ? 1 : 0,
        'white-space': 'nowrap',
      })
    );
  }

  return out;
}

/** The long form: a column of groups, a row to a binding. */
function longRows(entries: readonly KeyHelpEntry[]): Element[] {
  const keyWidth = entries.reduce((most, entry) => Math.max(most, stringWidth(entry.label)), 0);

  // groups in the order they first appear, and ungrouped lines first of all with
  // no heading: they are the app's own, and a heading called "undefined" is not
  // anything
  const groups = new Map<string | undefined, KeyHelpEntry[]>();
  groups.set(undefined, []);
  for (const entry of entries) {
    const list = groups.get(entry.group);
    if (list) {
      list.push(entry);
    } else {
      groups.set(entry.group, [entry]);
    }
  }

  const out: Element[] = [];
  for (const [group, list] of groups) {
    if (list.length === 0) {
      continue;
    }
    if (group !== undefined) {
      out.push(
        textNode(group, {
          class: 'sigil-key-help-group sigil-heading',
          'margin-top': out.length > 0 ? 1 : 0,
          'white-space': 'nowrap',
        })
      );
    }
    for (const entry of list) {
      out.push(
        box(
          { class: 'sigil-key-help-row', 'white-space': 'nowrap' },
          textNode(entry.label, {
            class: 'sigil-key-help-key sigil-accent',
            'flex-shrink': 0,
            'margin-right': 2,
            'text-overflow': 'clip',
            'white-space': 'nowrap',
            width: keyWidth,
          }),
          textNode(entry.description, {
            class: 'sigil-key-help-desc sigil-muted',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          })
        )
      );
    }
  }

  return out;
}

/** Columns the short form asks for: every line, and the separators between them. */
function naturalWidth(entries: readonly KeyHelpEntry[]): number {
  return (
    entries.reduce((sum, entry) => sum + lineWidth(entry), 0) +
    SEPARATOR_WIDTH * Math.max(0, entries.length - 1)
  );
}

/**
 * A footer listing the keys that are live, read from the bindings themselves.
 *
 * `↑/↓ move · enter select · q quit` cannot drift from what the keys do because
 * it is not written anywhere else: it is `InputRouter.bindings()`, read inside
 * an effect, so it follows the focus -- the focused element's `describe()`d keys
 * and its ancestors', after the app-wide ones -- and follows `bind()` and its
 * disposer. A binding with no description is not shown.
 *
 * The short form is one row and never wraps: what does not fit goes, lowest
 * priority first, and the row ends in `…`. The long form lists every binding
 * under its group.
 *
 * The room the short form fits into is the width the layout gives the footer,
 * learned through `onResize` the way `TextField` and the tabs row learn theirs, so
 * a resize refits it. It asks the layout for the width of every line rather than
 * of the ones it kept -- with a `max-width` of its container and no minimum -- so
 * the box it is given never depends on what it last chose to show: a footer in a
 * row is squeezed by what is beside it and offered the room back when there is
 * some, and one in a column is never wider than the column.
 *
 * @param router - Where the bindings come from.
 * @param opts - Which form, and how wide.
 * @returns The footer.
 */
export function keyHelp(router: KeyHelpSource, opts: KeyHelpOptions = {}): Element {
  const terminal = opts.terminal ?? defaultTerminal;
  const root = box({ class: 'sigil-key-help' });
  /** Whether the layout decides the width, which it does unless the app said. */
  const laidOut = opts.width === undefined;

  /** The columns the layout gave the footer, once it has. */
  let room: number | undefined;
  /** What was drawn last, so that a draw that would change nothing does nothing. */
  let drawn: string | undefined;

  /**
   * Fits the bindings to the room, and rebuilds the children if that changed them.
   *
   * @returns Whether the tree changed, which is what `onResize` owes a frame.
   */
  const draw = (): boolean => {
    const entries = keyHelpEntries(router.bindings());
    const expanded = isExpanded(opts.expanded);
    const columns = Math.max(
      0,
      typeof opts.width === 'function' ? opts.width() : (opts.width ?? room ?? terminal.width)
    );

    // the long form has no width to fit to: its descriptions are cut by the
    // layout's own ellipsis, so it is the same tree at any room
    const natural = laidOut && !expanded ? naturalWidth(entries) : undefined;
    const fitted = expanded ? undefined : fitKeyHelp(entries, columns);
    const signature = JSON.stringify([
      expanded,
      natural,
      expanded ? entries : fitted?.shown,
      fitted?.truncated,
      // the mark alone is drawn only where there is a column for it
      !expanded && columns >= 1,
    ]);
    if (signature === drawn) {
      return false;
    }
    drawn = signature;

    // a copy, because `removeChild` edits the array being walked
    // eslint-disable-next-line unicorn/no-useless-spread
    for (const child of [...root.children]) {
      root.removeChild(child);
    }
    root.setProps({
      class: expanded ? 'sigil-key-help is-expanded' : 'sigil-key-help',
      'flex-direction': expanded ? 'column' : 'row',
      // what it asks for is every line, whatever it kept, and what it is given is
      // what it fits to: asking for what it kept would size the box by the last
      // fit, and a footer that once dropped a binding would never be offered the
      // room to show it again
      ...(laidOut && {
        'max-width': natural === undefined ? undefined : '100%',
        'min-width': 0,
        width: natural,
      }),
    });
    root.append(...(expanded ? longRows(entries) : shortRows(entries, columns)));
    return true;
  };

  if (laidOut) {
    root.onResize = (element): boolean => {
      const size = element.content ?? element.box;
      room = size?.width;
      return draw();
    };
  }

  createEffect(() => {
    draw();
  });

  return root;
}
