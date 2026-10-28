import { ansi as defaultAnsi, strip } from '../ansi/index.js';
import { box, type Element, renderToString, text as textNode } from '../element/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { terminalWidth, truncate } from '../wrap/index.js';

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
 * What closes a title.
 *
 * A text drops the whitespace at the end of its last line when it wraps, so a
 * title ending in a space would lose it and the rule would run into the word. A
 * no-break space is not whitespace to the wrapper, takes one column, and is put
 * back to an ordinary space when the block is read out as a string.
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
 * A string as the grid will draw it, on one line.
 *
 * @param value - The title.
 * @returns The title with its escape sequences and line breaks gone.
 */
function oneLine(value: string): string {
  return strip(value).replaceAll(/\s+/g, ' ').trim();
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

  const heading = opts.title === undefined ? '' : oneLine(opts.title);
  let minWidth: number | undefined;
  // a title needs a rule cell and a corner on each side of its spaces, and one
  // column of its own; where there is not that much room the block goes without
  if (heading !== '' && room >= MIN_WIDTH + 4) {
    // a space either side keeps the corner and the rule from running into the
    // words, and is part of the text because padding paints nothing: a cell with
    // no content would leave the border character showing through
    const label = ` ${truncate(heading, room - 6, 'ellipsis')}${NBSP}`;
    const align = opts.titleAlign ?? 'left';
    // the label has to fit between the corners with a rule cell left each side
    minWidth = stringWidth(label) + 4;
    children.push(
      textNode(label, {
        class: 'sigil-note-title sigil-heading',
        position: 'absolute',
        top: -1,
        ...(align === 'left'
          ? { left: 1 }
          : align === 'right'
            ? { right: 1 }
            : { left: 0, right: 0, 'text-align': 'center' }),
        'white-space': 'nowrap',
      })
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
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    colorScheme: opts.colorScheme,
    width,
  }).replaceAll(NBSP, ' ');
}
