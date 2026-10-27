/**
 * Leveled status lines: a glyph, a colour, and a message.
 *
 * **This is not `src/debug/`.** That logger is `DEBUG`-driven developer output
 * and says nothing unless somebody asks it to; this is what a command tells the
 * person running it -- `Installed 3 packages`, `Config not found, using
 * defaults` -- and says it by default. They share a word and nothing else.
 *
 * Every line goes to stderr. A command's `run()` returns data and a serializer
 * prints it to stdout, so a status line on stdout would arrive in the middle of
 * `mycli --format json | jq`. The data is stdout's and the commentary is
 * stderr's, whichever level it is.
 */

import { type Ansi, createAnsi } from '../ansi/index.js';
import { box, type Element, renderToLines, text as textNode } from '../element/index.js';
import { resolveOutput } from '../style/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { PROMPT_SYMBOLS } from './prompt.js';
import { OUTCOME_SYMBOLS } from './spinner.js';

/** The glyph in front of each kind of line. */
export interface LogSymbols {
  readonly error: string;
  readonly info: string;
  readonly step: string;
  readonly success: string;
  readonly warn: string;
}

/**
 * The default glyphs.
 *
 * The four that mean what a spinner's settled mark means are the spinner's, and
 * a step is the prompts' pointer: a log line and the spinner that preceded it
 * should agree about what a warning looks like. Shared by reading the same
 * constants rather than by repeating them.
 */
export const LOG_SYMBOLS: LogSymbols = Object.freeze({
  error: OUTCOME_SYMBOLS.error,
  info: OUTCOME_SYMBOLS.info,
  step: PROMPT_SYMBOLS.cursor,
  success: OUTCOME_SYMBOLS.success,
  warn: OUTCOME_SYMBOLS.warn,
});

/**
 * Glyphs for a terminal that cannot be trusted with anything but ASCII.
 *
 * Chosen by the caller, the way `LINE` is for a spinner: nothing in here can
 * tell a Latin-1 console from a terminal that draws a checkmark, and a guess
 * that is wrong prints `?` where a status was.
 */
export const LOG_SYMBOLS_ASCII: LogSymbols = Object.freeze({
  error: 'x',
  info: 'i',
  step: '>',
  success: '+',
  warn: '!',
});

export interface LogOptions extends StyledOptions {
  /** Use `LOG_SYMBOLS_ASCII`. Defaults to false. */
  ascii?: boolean;
  /**
   * Whether this is progress rather than the answer.
   *
   * `true` silences `info`, `success`, `step` and `message`; **`warn` and
   * `error` are never silenced**, because they are not progress. `false` opts
   * out of the process-wide `--quiet` request altogether. Left unset, that
   * request decides.
   */
  quiet?: boolean;
  /** Glyphs to use in place of the defaults, one at a time. */
  symbols?: Partial<LogSymbols>;
  /** The terminal to write through. Defaults to the process's. */
  terminal?: Terminal;
}

export interface LogMessageOptions {
  /** A glyph of the caller's own. Without one the text starts at the margin. */
  symbol?: string;
}

export interface Log {
  /** A failure. Written even when the run is quiet. */
  error(message: string): void;
  /** Something worth knowing that is not progress. */
  info(message: string): void;
  /** A line with no level of its own. */
  message(message: string, opts?: LogMessageOptions): void;
  /** The start of a stage of the work. */
  step(message: string): void;
  /** Something finished. */
  success(message: string): void;
  /** Something is off but the run goes on. Written even when the run is quiet. */
  warn(message: string): void;
}

type Level = 'error' | 'info' | 'step' | 'success' | 'warn';

/** The theme role each level's glyph is drawn in. */
const ROLE: Record<Level, string> = {
  error: 'sigil-error',
  info: 'sigil-info',
  step: 'sigil-accent',
  success: 'sigil-success',
  warn: 'sigil-warn',
};

/** The levels a quiet run still says. */
const SURVIVES_QUIET: ReadonlySet<Level | undefined> = new Set(['error', 'warn']);

/**
 * One status line as an element tree.
 *
 * The glyph is its own column and the message a column beside it, so a message
 * that wraps or has several lines of its own keeps its continuation lines under
 * the first one's text rather than back at the margin. That is the box model
 * doing the indent rather than a count of spaces that has to agree with the
 * glyph's width.
 *
 * @param message - The text.
 * @param symbol - The glyph, or nothing for a bare message.
 * @param role - The theme role the glyph is drawn in.
 * @returns The tree.
 */
export function logView(message: string, symbol: string | undefined, role?: string): Element {
  // one node per line of the caller's text: the layout collapses a newline, and
  // a blank line is a node of its own so that it survives
  const lines = message.split(/\r?\n/).map((line) => textNode(line, { class: 'sigil-log-text' }));
  const body = box(
    { class: 'sigil-log-body', 'flex-direction': 'column', 'flex-shrink': 1 },
    ...lines
  );

  if (!symbol) {
    return box({ class: 'sigil-log' }, body);
  }

  return box(
    { class: 'sigil-log' },
    textNode(symbol, {
      class: `sigil-log-symbol sigil-symbol${role ? ` ${role}` : ''}`,
      'flex-shrink': 0,
      'margin-right': 1,
    }),
    body
  );
}

/**
 * A logger over a terminal.
 *
 * @param opts - Where to write, how it looks, and whether quiet silences it.
 * @returns The logger.
 */
export function createLog(opts: LogOptions = {}): Log {
  const symbols: LogSymbols = {
    ...(opts.ascii ? LOG_SYMBOLS_ASCII : LOG_SYMBOLS),
    ...opts.symbols,
  };
  const terminal = opts.terminal ?? defaultTerminal;
  // stderr's own level, since one of the two being redirected says nothing about
  // the other: `mycli > out.json` leaves these lines on the screen in colour
  let detected: Ansi | undefined;

  function write(level: Level | undefined, message: string, symbol: string | undefined): void {
    // asked now rather than frozen at construction: `log` is built at module
    // scope, before `main()` has read argv, so a level frozen there could never
    // see `--quiet`
    if (
      !SURVIVES_QUIET.has(level) &&
      resolveOutput({
        live: terminal.isTTY && !terminal.closed,
        quiet: opts.quiet,
        reducedMotion: opts.reducedMotion,
      }) === 'quiet'
    ) {
      return;
    }

    const screen = terminal.stderr.isTTY === true;
    detected ??= createAnsi({ stream: terminal.stderr });
    const colorLevel = opts.colorLevel ?? (opts.ansi ?? detected).level;
    const view = logView(message, symbol, level && ROLE[level]);

    // a log file is not wrapped for a screen: the reader has a pager, and a line
    // cut at 80 columns is one that cannot be grepped whole
    const columns = terminal.stderr.columns;
    const widest = Math.max(...message.split(/\r?\n/).map((line) => stringWidth(line)));
    const width =
      screen && typeof columns === 'number' && columns > 0
        ? Math.floor(columns)
        : widest + (symbol ? stringWidth(symbol) + 1 : 0) + 1;

    const lines = renderToLines(view, {
      cascade: themedCascade(opts),
      colorLevel,
      width: Math.max(1, width),
    });

    // a carriage return with every line feed on a screen, for the reason
    // `crlf()` in the canvas backend gives: whether the line discipline is
    // translating a bare one is not something this can see, and raw mode turns
    // it off. A file keeps the plain line feeds it would have had
    terminal.writeStatus(`${lines.join(screen ? '\r\n' : '\n')}${screen ? '\r\n' : '\n'}`);
  }

  return {
    error: (message) => write('error', message, symbols.error),
    info: (message) => write('info', message, symbols.info),
    message: (message, o = {}) => write(undefined, message, o.symbol),
    step: (message) => write('step', message, symbols.step),
    success: (message) => write('success', message, symbols.success),
    warn: (message) => write('warn', message, symbols.warn),
  };
}

/** The process's logger, writing through the process's terminal. */
export const log: Log = createLog();
