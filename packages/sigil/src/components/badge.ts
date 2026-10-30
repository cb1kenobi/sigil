import { ansi as defaultAnsi, type ColorLevel, strip } from '../ansi/index.js';
import { type Element, renderToString, text as textNode } from '../element/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';

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

/**
 * A label as the grid will draw it, on one line.
 *
 * @param value - The label.
 * @returns The label with its escape sequences and line breaks gone.
 */
function oneLine(value: string): string {
  return strip(value).replaceAll(/\s+/g, ' ').trim();
}

/**
 * Builds the element tree for a badge.
 *
 * A single `nowrap` text, and the padding is part of it. A `text` drops the
 * whitespace at the end of a line unless it is `nowrap`, and padding paints
 * nothing -- the paint pass fills the cells of a glyph and not the empty ones
 * around it -- so a column either side of the label has to be a space in the
 * label for the inverse to reach it.
 *
 * What a badge is at colour level 0 is decided here and not in the sheet, because
 * which characters are drawn is content: with no colour the inverse is gone and a
 * padded `PASS` is just `PASS` with spaces around it, so the padding becomes
 * brackets and the label is still set apart. Both are two columns, so the width
 * does not depend on the level.
 *
 * @param label - The label. Escape sequences and line breaks are dropped.
 * @param opts - The variant, and the level the brackets are decided at.
 * @returns The tree, and how wide it is.
 */
export function badgeView(
  label: string,
  opts: BadgeOptions = {}
): { element: Element; width: number } {
  const variant = opts.variant ?? 'neutral';
  const level: ColorLevel = opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level;
  const body = oneLine(label);
  // an empty label is no badge, rather than a coloured gap two columns wide
  const [open, close] = body === '' ? ['', ''] : level === 0 ? ['[', ']'] : [' ', ' '];
  const content = `${open}${body}${close}`;
  const role = variant === 'neutral' ? '' : ` ${ROLES[variant]}`;

  return {
    element: textNode(content, {
      class: `sigil-badge sigil-badge-${variant}${role}`,
      'flex-shrink': 0,
      'white-space': 'nowrap',
    }),
    width: stringWidth(content),
  };
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
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    colorScheme: opts.colorScheme,
    width,
  });
}
