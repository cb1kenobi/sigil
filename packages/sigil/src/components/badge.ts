import { type ColorLevel } from '../ansi/index.js';
import {
  box,
  type Element,
  type ElementProps,
  renderToString,
  text as textNode,
} from '../element/index.js';
import { createEffect } from '../renderer/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { colorLevelOf } from './color-level.js';
import { labelLine } from './note.js';

/** Which role a badge takes its colour from. */
export type BadgeVariant = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export interface BadgeOptions extends StyledOptions {
  /**
   * Which role colours the badge. Defaults to `neutral`, which is no role at all
   * -- the terminal's own foreground, inverted.
   */
  variant?: BadgeVariant;
}

/**
 * The role class a variant takes its colour from.
 *
 * `warning` is `warn` so that every variant lands on a role the framework sheet
 * already declares, the way `note()` does it, and `neutral` is absent because it
 * is the one variant that is no role.
 */
const ROLES: Record<Exclude<BadgeVariant, 'neutral'>, string> = {
  error: 'sigil-error',
  info: 'sigil-info',
  success: 'sigil-success',
  warning: 'sigil-warn',
};

/** What a badge draws, as `badgeView()` and `Badge()` both need it. */
interface BadgeParts {
  /** The label, with nothing around it: `''` for no badge. */
  body: string;
  /** The classes each form carries, as separate names. */
  classes: string[];
}

/** The two forms a badge holds, and what each says. */
interface BadgeForms {
  /** The label in brackets, which the sheet shows at colour level 0. */
  bracketed: string;
  /** The label with a column each side, which the sheet shows above it. */
  padded: string;
}

/**
 * Works out what a badge says and which classes it wears.
 *
 * The one place that decides it, so the static view and the live component cannot
 * disagree about the label or the role.
 *
 * @param label - The label, as the caller wrote it.
 * @param variant - Which role colours it.
 * @returns The label and the classes.
 */
function badgeParts(label: string, variant: BadgeVariant): BadgeParts {
  const classes = ['sigil-badge', `sigil-badge-${variant}`];
  if (variant !== 'neutral') {
    classes.push(ROLES[variant]);
  }
  return { body: labelLine(label), classes };
}

/**
 * What each of a badge's two forms says.
 *
 * An empty label is no badge, rather than a coloured gap two columns wide.
 *
 * @param body - The label.
 * @returns The padded form and the bracketed one.
 */
function badgeForms(body: string): BadgeForms {
  return body === ''
    ? { bracketed: '', padded: '' }
    : { bracketed: `[${body}]`, padded: ` ${body} ` };
}

/** One of a badge's two forms, as a `nowrap` text. */
function formText(which: 'bracketed' | 'padded'): Element {
  return textNode('', {
    class: `sigil-badge-${which}`,
    'flex-shrink': 0,
    'white-space': 'nowrap',
  });
}

/**
 * Writes what a badge says into its two texts, and swaps their classes.
 *
 * @param forms - The padded text and the bracketed one.
 * @param parts - The label and the classes.
 * @param worn - The classes the last call put on, which a change takes off.
 * @returns The classes it put on, for the next call.
 */
function dressForms(
  forms: Record<'bracketed' | 'padded', Element>,
  { body, classes }: BadgeParts,
  worn: readonly string[]
): string[] {
  const said = badgeForms(body);
  for (const which of ['bracketed', 'padded'] as const) {
    const text = forms[which];
    text.setText(said[which]);
    for (const name of worn) {
      if (!classes.includes(name)) {
        text.removeClass(name);
      }
    }
    for (const name of classes) {
      text.addClass(name);
    }
  }
  return classes;
}

/**
 * Builds the element tree for a badge.
 *
 * Two `nowrap` texts in a row, and the sheet shows one of them. The padding is
 * part of the text: a `text` drops the whitespace at the end of a line unless it
 * is `nowrap`, and padding paints nothing -- the paint pass fills the cells of a
 * glyph and not the empty ones around it -- so a column either side of the label
 * has to be a space in the label for the inverse to reach it.
 *
 * What a badge is at colour level 0 is decided by the sheet, by the level the
 * renderer draws at: which characters are drawn is content, but the level is not
 * one this function can know, because a view is built before whatever draws it.
 * With no colour the inverse is gone and a padded `PASS` is just `PASS` with
 * spaces around it, so the other text holds brackets and is the one drawn there --
 * and the label is still set apart. Both are two columns, so the width does not
 * depend on the level. A cascade without the framework's sheet draws both
 * (SIG-644).
 *
 * @param label - The label. Escape sequences and line breaks are dropped.
 * @param opts - The variant.
 * @returns The tree, and how wide it is.
 */
export function badgeView(
  label: string,
  opts: BadgeOptions = {}
): { element: Element; width: number } {
  const parts = badgeParts(label, opts.variant ?? 'neutral');
  const forms = { bracketed: formText('bracketed'), padded: formText('padded') };
  dressForms(forms, parts, []);

  return {
    element: box({ 'flex-direction': 'row', 'flex-shrink': 0 }, forms.padded, forms.bracketed),
    width: stringWidth(badgeForms(parts.body).padded),
  };
}

/**
 * Where a live badge's label or variant comes from.
 *
 * The value itself, anything with a `get()` -- a `State` or a `Computed`, which is
 * enough because a badge only reads it -- or a function. A signal or a function is
 * read inside an effect, so the badge redraws when what it read changes. The
 * shape `ChartSource` takes, for the same reason.
 */
export type BadgeSource<T> = T | { get(): T } | (() => T);

export interface BadgeProps {
  /** Extra classes for the badge's box. The variant's classes are on the two texts inside it. */
  class?: string;
  /**
   * Not read. Padding or brackets is decided by the level the renderer draws at, by
   * the framework's sheet, so a badge follows it whatever it was built at (SIG-644).
   * Kept so a caller that passed it still type-checks.
   */
  colorLevel?: ColorLevel;
  /** The label. Escape sequences and line breaks are dropped, and an empty one draws nothing. */
  label: BadgeSource<string>;
  /** The badge's own props: a margin, a flex factor. They win over the defaults, and are on its box. */
  props?: ElementProps;
  /** Which role colours the badge. Defaults to `neutral`. */
  variant?: BadgeSource<BadgeVariant>;
}

/** Reads a source once, which inside an effect is what subscribes it. */
function read<T>(source: BadgeSource<T>): T {
  if (typeof source === 'function') {
    return (source as () => T)();
  }
  if (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as { get?: unknown }).get === 'function'
  ) {
    return (source as { get(): T }).get();
  }
  return source as T;
}

/**
 * A badge whose label and variant follow signals.
 *
 * `badgeView()` builds a fixed tree, and a badge that changes -- a trend, a build
 * status -- would otherwise be rebuilt by the app and swapped into its parent. This
 * is the one element, written to in place:
 *
 * ```js
 * import { Badge } from '@ttylabs/sigil/components/badge';
 *
 * Badge({
 *   label: () => `${change.get() > 0 ? '+' : ''}${change.get()}%`,
 *   variant: () => (change.get() >= 0 ? 'success' : 'error'),
 * });
 * ```
 *
 * Each of `label` and `variant` is a value, a `State` or a `Computed`, or a
 * function of signals. Plain values build the element once and start no effect, so
 * a badge that never changes costs what `badgeView()` does. What is drawn is
 * `badgeView()`'s own, from the same function, so the padding, the level 0
 * brackets and the role classes are the same.
 *
 * @param props - The label, the variant, and the element's own props.
 * @returns The badge: a row holding the padded text and the bracketed one, of which
 * the sheet shows one by the level the renderer draws at.
 * @throws If `variant` is not one of the five, when it is first read. A signal that
 * later holds one that is not is reported by the effect, which keeps what the badge
 * last drew until a valid one arrives.
 */
export function Badge(props: BadgeProps): Element {
  const live = (source: unknown): boolean =>
    typeof source === 'function' ||
    (typeof source === 'object' &&
      source !== null &&
      typeof (source as { get?: unknown }).get === 'function');

  /** What the sources say now, validated. */
  const parts = (): BadgeParts => {
    const variant = (props.variant === undefined ? undefined : read(props.variant)) ?? 'neutral';
    if (variant !== 'neutral' && !Object.hasOwn(ROLES, variant)) {
      throw new TypeError(
        `Expected a badge variant to be neutral, success, warning, error or info, not ${String(variant)}`
      );
    }
    return badgeParts(String(read(props.label) ?? ''), variant);
  };

  const forms = { bracketed: formText('bracketed'), padded: formText('padded') };
  const element = box(
    { 'flex-direction': 'row', 'flex-shrink': 0, ...props.props },
    forms.padded,
    forms.bracketed
  );
  /** The classes the sources gave the texts, so the next change can take them off. */
  let worn: string[] = [];
  const dress = (next: BadgeParts): void => {
    worn = dressForms(forms, next, worn);
  };

  if (live(props.label) || live(props.variant)) {
    createEffect(() => dress(parts()));
  } else {
    dress(parts());
  }
  for (const name of String(props.class ?? '')
    .split(/\s+/)
    .filter(Boolean)) {
    element.addClass(name);
  }
  return element;
}

/**
 * A short coloured status label, as a string.
 *
 * A facade over `badgeView()`, the way `note()` is over `noteView()`: the tree is
 * laid out and painted onto a grid of its own and what comes back is the grid read
 * as a line. It returns a string and the caller does the writing, so it ignores
 * `--quiet` -- a badge is part of a line that is a result or a status, and
 * silencing it is the caller's statement about its own `write()`.
 *
 * To put one in a `table()`, hand the table `badgeView()` and not this: a string
 * cell has its escape sequences dropped, which is what a styled string is, and a
 * view is the one cell form that keeps its own styling.
 *
 * @param label - The label. Escape sequences and line breaks are dropped.
 * @param opts - The variant, and the colour level.
 * @returns The badge, or an empty string for an empty label.
 */
export function badge(label: string, opts: BadgeOptions = {}): string {
  const { element, width } = badgeView(label, opts);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: colorLevelOf(opts),
    colorScheme: opts.colorScheme,
    width,
  });
}
