import { ansi as defaultAnsi, strip } from '../ansi/index.js';
import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { terminalWidth, truncate } from '../wrap/index.js';
import { unicodeSupported } from './note.js';

/** Where the label sits along the line. */
export type RuleAlign = 'left' | 'center' | 'right';

/** The character sets a rule may be drawn with. */
export type RuleLine = 'single' | 'double' | 'bold' | 'ascii';

/** Which role colours a rule. `none` is the terminal's own foreground. */
export type RuleRole = 'accent' | 'error' | 'info' | 'muted' | 'none' | 'success' | 'warn';

export interface RuleOptions extends StyledOptions {
  /** Where the label sits. Defaults to `center`. */
  align?: RuleAlign;
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Words set into the line. Left out where there is no room for them. */
  label?: string;
  /**
   * The character the line is drawn with. Defaults to `single`, or `ascii` where
   * `unicodeSupported()` says the terminal cannot be trusted with box drawing.
   */
  line?: RuleLine;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /**
   * Which role colours the line. Defaults to `muted`, because a divider is there
   * to separate things and not to be read.
   */
  role?: RuleRole;
  /** How many columns the rule spans. Defaults to `terminalWidth()`. */
  width?: number;
}

/** What each line style is drawn with: the horizontal of the border set of that name. */
const LINES: Record<RuleLine, string> = {
  ascii: '-',
  bold: '━',
  double: '═',
  single: '─',
};

/** The role class each role takes its colour from, if it takes one. */
const ROLES: Record<RuleRole, string | undefined> = {
  accent: 'sigil-accent',
  error: 'sigil-error',
  info: 'sigil-info',
  muted: 'sigil-muted',
  none: undefined,
  success: 'sigil-success',
  warn: 'sigil-warn',
};

/**
 * Line cells kept between the end of a label and the end of the rule: two on the
 * side the label leans towards, so it does not look pressed against the edge,
 * and one on the other, so it does not look like it ends there.
 */
const LEAD = 2;

/** The element tree for a rule, and the room it was drawn for. */
export interface RuleView {
  readonly element: Element;
  readonly width: number;
}

/**
 * A label as it will sit in the line: one line, no escape sequences.
 *
 * @param value - The label.
 * @returns The label with its escape sequences and line breaks gone.
 */
function oneLine(value: string): string {
  return strip(String(value)).replaceAll(/\s+/g, ' ').trim();
}

/**
 * The runs a rule is made of, left to right.
 *
 * @param width - The columns to span.
 * @param opts - The label, where it sits, and the line.
 * @returns Each run's text and whether it is the label.
 */
function runs(width: number, opts: RuleOptions): { label: boolean; text: string }[] {
  const char = LINES[opts.line ?? (unicodeSupported(opts.env, opts.platform) ? 'single' : 'ascii')];
  const align = opts.align ?? 'center';
  const heading = opts.label === undefined ? '' : oneLine(opts.label);

  // a space either side of the words keeps the line from running into them, and
  // the line keeps a cell at the end it leans away from; where that cannot be had
  // the rule goes without its label rather than drawing one over the line's end,
  // and a label cut to nothing but its ellipsis says nothing, so that goes too
  const room = width - 2 - (align === 'center' ? 2 : LEAD + 1);
  if (heading === '' || room < 1 || (room < 2 && stringWidth(heading) > room)) {
    return [{ label: false, text: char.repeat(width) }];
  }

  const label = ` ${truncate(heading, room, 'ellipsis')} `;
  const fill = width - stringWidth(label);
  const before = align === 'left' ? LEAD : align === 'right' ? fill - LEAD : Math.floor(fill / 2);

  return [
    { label: false, text: char.repeat(before) },
    { label: true, text: label },
    { label: false, text: char.repeat(fill - before) },
  ];
}

/**
 * Builds the element tree for a rule.
 *
 * A row of fixed-width texts: the line before the label, the label, the line
 * after it. Each is `white-space: pre` and unshrinkable because the rule has
 * already been fitted to its width, and the label's spaces are part of the text --
 * padding paints nothing, so a space with no content would leave the line showing
 * through. The width is fixed when the tree is built, as it is for every `*View()`
 * here, so an app whose layout resizes builds the rule again.
 *
 * @param opts - The label, where it sits, and the room.
 * @returns The tree, and the room it was built for.
 */
export function ruleView(opts: RuleOptions = {}): RuleView {
  const asked = opts.width === undefined ? NaN : Math.floor(opts.width);
  const width = asked >= 1 ? asked : Math.max(1, terminalWidth({ env: opts.env }));
  const role = ROLES[opts.role ?? 'muted'];
  // a label is a heading, and a colour is the whole rule's -- but the muted role is
  // de-emphasis, and the one piece of a divider meant to be read is its words
  const labelRole = opts.role === undefined || opts.role === 'muted' ? '' : ` ${role ?? ''}`;

  const children = runs(width, opts).map((run) =>
    textNode(run.text, {
      class: run.label
        ? `sigil-rule-label sigil-heading${labelRole}`
        : `sigil-rule-line${role ? ` ${role}` : ''}`,
      'flex-shrink': 0,
      width: stringWidth(run.text),
      'white-space': 'pre',
    })
  );

  return { element: box({ class: 'sigil-rule' }, ...children), width };
}

/**
 * A horizontal divider, with an optional label set into it.
 *
 * A facade over `ruleView()`, the way `note()` is over `noteView()`: the tree is
 * laid out and painted onto a grid of its own and what comes back is the grid read
 * as a line. It returns a string and the caller does the writing, which is also
 * why it ignores `--quiet`.
 *
 * @param opts - The label, where it sits, and the room.
 * @returns The rule, with no trailing newline.
 */
export function rule(opts: RuleOptions = {}): string {
  const { element, width } = ruleView(opts);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    colorScheme: opts.colorScheme,
    width,
  });
}
