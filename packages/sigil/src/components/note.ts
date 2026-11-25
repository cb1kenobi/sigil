import { strip, stripWellFormed } from '../ansi/index.js';
import {
  box,
  type Element,
  renderToString,
  text as textNode,
  toDisplayLine,
} from '../element/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { terminalWidth } from '../wrap/index.js';
import { borderLabel, borderLabelText } from './border-label.js';
import { colorLevelOf } from './color-level.js';

/** Which role a block takes its colour from. */
export type NoteVariant = 'note' | 'info' | 'success' | 'warning' | 'error';

/** Where the title sits in the top border. */
export type NoteTitleAlign = 'left' | 'center' | 'right';

/** The border character sets a note may be drawn with. */
export type NoteBorder = 'single' | 'double' | 'round' | 'bold' | 'ascii';

export interface NoteOptions extends StyledOptions {
  /**
   * The border's character set. Defaults to `round`, or `ascii` where
   * `unicodeSupported()` says the terminal cannot be trusted with box drawing.
   */
  border?: NoteBorder;
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** How far the whole block is indented. Defaults to 0. */
  indent?: number;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /** A heading set into the top border. */
  title?: string;
  /** Where the title sits. Defaults to `left`. */
  titleAlign?: NoteTitleAlign;
  /**
   * Which role colours the border, the title and the message. Defaults to `note`,
   * which is no role at all -- the terminal's own foreground.
   */
  variant?: NoteVariant;
  /** The widest the block may be, and never under 5. Defaults to `terminalWidth()`. */
  width?: number;
}

/** A border and a column of padding each side, and one column inside. */
const MIN_WIDTH = 5;

/**
 * A no-break space, which `note()` puts back to an ordinary one.
 *
 * A message may hold one, and a block read out as a string should hold none.
 */
const NBSP = '\u00A0';

/**
 * The role class a variant takes its colour from.
 *
 * `warning` is `warn` so that every variant lands on one of the four roles the
 * framework sheet already declares, rather than a class of its own that a theme
 * would have to be told about.
 */
const ROLES: Record<Exclude<NoteVariant, 'note'>, string> = {
  error: 'sigil-error',
  info: 'sigil-info',
  success: 'sigil-success',
  warning: 'sigil-warn',
};

/**
 * Whether a terminal can be trusted with box-drawing characters.
 *
 * The same heuristic `is-unicode-supported` has made the convention: off
 * Windows, everything but the Linux virtual console and a `dumb` terminal draws
 * them; on Windows, only the terminals known to (Windows Terminal, the VS Code
 * and JetBrains consoles, and anything that says it is `xterm`-alike). Read off
 * the environment rather than asked of the terminal, because a string being
 * built has no terminal to ask.
 *
 * @param env - The environment to read. Defaults to `process.env`.
 * @param platform - The platform to detect for. Defaults to `process.platform`.
 * @returns Whether box-drawing characters are safe.
 */
export function unicodeSupported(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform
): boolean {
  if (platform !== 'win32') {
    return env.TERM !== 'linux' && env.TERM !== 'dumb';
  }

  return (
    Boolean(env.WT_SESSION) ||
    Boolean(env.TERMINUS_SUBLIME) ||
    env.ConEmuTask === '{cmd::Cmder}' ||
    env.TERM_PROGRAM === 'Terminus-Sublime' ||
    env.TERM_PROGRAM === 'vscode' ||
    env.TERM === 'xterm-256color' ||
    env.TERM === 'alacritty' ||
    env.TERMINAL_EMULATOR === 'JetBrains-JediTerm'
  );
}

/**
 * A label as the grid will draw it, on one line: its escape sequences gone and
 * every run of whitespace one space.
 *
 * A component's colour is a role on the component, so a sequence a caller put
 * in a label has nowhere to go on a cell grid; and a label sits on one line of
 * a border, a row or a bar, so a line break in one has nowhere to go either.
 * One function for the note's title, a badge, a rule's label, a tab and a
 * chart's labels, which each wrote it out -- and the chart's copy said its
 * escape sequences were gone while leaving them in. `String()` first, because a
 * label reaches here from an app's JavaScript as readily as from its types.
 *
 * Published from the barrel for the reason `unicodeSupported()` is: an ejected
 * component imports its siblings from `@ttylabs/sigil/components`.
 *
 * @param value - The label.
 * @returns The label as one line of plain text.
 */
export function labelLine(value: string): string {
  return strip(String(value)).replaceAll(/\s+/g, ' ').trim();
}

/**
 * What a caller's `format()` wrote, as it will be drawn (SIG-686, SIG-694, SIG-698).
 *
 * A chart's `format(value)` and a page indicator's `format(page, pages)` answer
 * with a string that is measured and then drawn, and the two have to be the same
 * string. They were not, in three ways, and this is the one place that says all
 * three:
 *
 * - a tab is drawn as a space and measured as nothing, so the string goes through
 *   `toDisplayLine()`, in its single-line form because a line break would push
 *   every row after it down by one;
 * - an escape sequence is drawn as the text of its parameters, since the tree
 *   drops the `ESC` byte and keeps `[31m`, and a bar is then sized against that
 *   longer word and loses columns. The style is dropped, as `labelLine()` drops
 *   it and a tooltip and a line chart's crosshair readout already do, so it goes
 *   through `strip()` first;
 * - `String()` is applied first, because a `format` from JavaScript may answer
 *   with the number itself, which has always been drawn and which
 *   `toDisplayLine()` would throw on;
 * - what is removed is a **whole** sequence and not whatever `strip()` would
 *   (SIG-710). `strip()` reads a lone `ESC` or C1 character as the start of a
 *   sequence that never ends and takes the text after it, so `'caf\u009F rest'`
 *   drew `caf`. A string a caller wrote may well hold one -- text decoded as
 *   Latin-1 when it was UTF-8 is full of them -- so this goes through
 *   `stripWellFormed()`, which keeps the text and draws the introducer as `\uFFFD`,
 *   the way `printable()` draws a control character.
 *
 * Not `labelLine()`: that collapses every run of whitespace to one space and
 * trims, which is right for a label and would change a `format()` result that
 * had no escape in it. This leaves such a result as it was, a tab apart.
 *
 * It lives beside `labelLine()` and is published from the same subpath, because
 * a component that ejects imports its siblings by a subpath and `chart` and
 * `paginator` are two that do.
 *
 * @param format - The caller's `format()`, or the default.
 * @param args - What it is given: a number for a chart, a page and a count for a
 *   page indicator.
 * @returns What is drawn for it, as one line of plain text.
 */
export function formatLine<Args extends unknown[]>(
  format: (...args: Args) => string,
  ...args: Args
): string {
  return toDisplayLine(stripWellFormed(String(format(...args)), '\uFFFD'));
}

/**
 * Builds the element tree for a note.
 *
 * The block is a bordered box that shrinks to its content, inside a wrapper that
 * is as wide as the room there is -- so a short message is a short box and a
 * long one is wrapped at the terminal. The title is an out-of-flow text set one
 * row up, over the border: the paint pass draws a border as a whole and has no
 * notion of a title, and an absolutely placed text is how a box lays something
 * across its own edge without taking space from what is inside it.
 *
 * The message is wrapped here rather than by the text element, and that is the
 * one place this hand-sizes anything: a `normal` text collapses the indentation
 * of a command or a list, and `pre` keeps it but does not wrap. `wrap()` keeps
 * both and counts display columns, so the lines handed to the layout already fit
 * and the box is exactly as wide as the longest of them.
 *
 * @param message - The message. Escape sequences are dropped; colour is a role's.
 * @param opts - The title, the variant, and the room.
 * @returns The tree, and the room it was built for.
 */
export function noteView(
  message: string,
  opts: NoteOptions = {}
): { element: Element; width: number } {
  const variant = opts.variant ?? 'note';
  const indent = Math.max(0, Math.floor(opts.indent ?? 0));
  // a border and a column of padding each side leave one column for the message,
  // and a block narrower than that has nowhere to put anything, so that is the
  // floor rather than a width the message silently disappears into
  const room = Math.max(
    MIN_WIDTH,
    Math.floor(opts.width ?? terminalWidth({ env: opts.env })) - indent
  );
  const border = opts.border ?? (unicodeSupported(opts.env, opts.platform) ? 'round' : 'ascii');

  const children: Element[] = [textNode(strip(message), { class: 'sigil-note-body' })];

  const heading = opts.title === undefined ? '' : labelLine(opts.title);
  let minWidth: number | undefined;
  // a title needs a rule cell and a corner on each side of its spaces, and one
  // column of its own; where there is not that much room the block goes without
  if (heading !== '' && room >= MIN_WIDTH + 4) {
    // the label has to fit between the corners with a rule cell left each side:
    // a border row is `room` wide, less a corner and a rule cell at each end
    const label = borderLabelText(heading, room - 4);
    // and has to fit whole, so the box is at least as wide as it
    minWidth = stringWidth(label) + 4;
    children.push(
      borderLabel(
        label,
        'top',
        { align: opts.titleAlign ?? 'left' },
        'sigil-note-title sigil-heading'
      )
    );
  }

  const role = variant === 'note' ? '' : ` ${ROLES[variant]}`;

  return {
    element: box(
      {
        'align-items': 'flex-start',
        class: 'sigil-note-frame',
        'flex-direction': 'column',
        'padding-left': indent,
      },
      box(
        {
          'border-style': border,
          class: `sigil-note sigil-note-${variant}${role}`,
          'flex-direction': 'column',
          'flex-shrink': 0,
          ...(minWidth === undefined ? {} : { 'min-width': Math.min(minWidth, room) }),
          'max-width': room,
          'padding-left': 1,
          'padding-right': 1,
          position: 'relative',
        },
        ...children
      )
    ),
    width: room + indent,
  };
}

/**
 * Frames a message so it stands out from the output around it.
 *
 * A facade over `noteView()`, the way `table()` is over `tableView()`: the tree
 * is laid out and painted onto a grid of its own, and what comes back is the grid
 * read as lines. It returns a string and the caller does the writing, which is
 * also why it ignores `--quiet`: it is a result, on `table()`'s side of that
 * line, and silencing it is the caller's statement about its own `write()`.
 *
 * @param message - The message. Line breaks are kept.
 * @param opts - The title, the variant, and the room.
 * @returns The block, with no trailing newline.
 */
export function note(message: string, opts: NoteOptions = {}): string {
  const { element, width } = noteView(message, opts);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: colorLevelOf(opts),
    colorScheme: opts.colorScheme,
    width,
  }).replaceAll(NBSP, ' ');
}
