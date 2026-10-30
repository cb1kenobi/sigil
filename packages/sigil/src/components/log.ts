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

import { type Ansi, createAnsi, strip } from '../ansi/index.js';
import { box, type Element, renderToLines, text as textNode } from '../element/index.js';
import { resolveOutput } from '../style/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';
import { createStreamWrapper } from './log-stream.js';
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

/**
 * Where a stream's text comes from.
 *
 * Chunks may be cut anywhere -- inside a word, inside an escape sequence, inside
 * a multi-byte character -- because that is how a model's tokens and a
 * subprocess's pipe arrive. A `Uint8Array` is decoded as UTF-8, with a character
 * split across two chunks put back together. A bare string is one chunk.
 */
export type LogSource = string | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>;

/**
 * The same six lines as `Log`, fed from a source rather than a string.
 *
 * Each returns a promise that settles when the source has been drained and the
 * last line written. A line is written as soon as it is final -- wrapped at the
 * terminal's width, so the last, still-growing line is held until it is full,
 * the text says it ended, or the stream does.
 */
export interface LogStream {
  error(source: LogSource): Promise<void>;
  info(source: LogSource): Promise<void>;
  message(source: LogSource, opts?: LogMessageOptions): Promise<void>;
  step(source: LogSource): Promise<void>;
  success(source: LogSource): Promise<void>;
  warn(source: LogSource): Promise<void>;
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
  /**
   * Status lines whose text has not all arrived yet: an LLM's answer, a
   * subprocess's output.
   */
  readonly stream: LogStream;
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

  /** Whether this level is dropped, asked now rather than at construction. */
  function silenced(level: Level | undefined): boolean {
    // asked now rather than frozen at construction: `log` is built at module
    // scope, before `main()` has read argv, so a level frozen there could never
    // see `--quiet`
    return (
      !SURVIVES_QUIET.has(level) &&
      resolveOutput({
        live: terminal.isTTY && !terminal.closed,
        quiet: opts.quiet,
        reducedMotion: opts.reducedMotion,
      }) === 'quiet'
    );
  }

  /** The width of stderr when it is a screen, and `undefined` for a file. */
  function screenWidth(): number | undefined {
    const columns = terminal.stderr.columns;
    return terminal.stderr.isTTY === true && typeof columns === 'number' && columns > 0
      ? Math.floor(columns)
      : undefined;
  }

  function write(level: Level | undefined, message: string, symbol: string | undefined): void {
    if (silenced(level)) {
      return;
    }

    detected ??= createAnsi({ stream: terminal.stderr });
    const colorLevel = opts.colorLevel ?? (opts.ansi ?? detected).level;
    const view = logView(message, symbol, level && ROLE[level]);

    // a log file is not wrapped for a screen: the reader has a pager, and a line
    // cut at 80 columns is one that cannot be grepped whole
    const columns = screenWidth();
    const widest = Math.max(...message.split(/\r?\n/).map((line) => stringWidth(line)));
    const width = columns ?? widest + (symbol ? stringWidth(symbol) + 1 : 0) + 1;

    const lines = renderToLines(view, {
      cascade: themedCascade(opts),
      colorLevel,
      width: Math.max(1, width),
    });

    send(lines);
  }

  /**
   * Writes finished lines to stderr, above whatever is repainting.
   *
   * A carriage return goes with every line feed on a screen, for the reason
   * `crlf()` in the canvas backend gives: whether the line discipline is
   * translating a bare one is not something this can see, and raw mode turns it
   * off. A file keeps the plain line feeds it would have had.
   */
  function send(lines: string[]): void {
    const eol = terminal.stderr.isTTY === true ? '\r\n' : '\n';
    terminal.writeStatus(`${lines.join(eol)}${eol}`);
  }

  async function stream(
    level: Level | undefined,
    source: LogSource,
    symbol: string | undefined
  ): Promise<void> {
    // a silenced stream is still drained: whatever is producing the text (a
    // model, a child process) is waiting to be read, and stopping reading is not
    // the same as it having nothing to say
    const quiet = silenced(level);
    const columns = screenWidth();
    const gutter = symbol ? stringWidth(symbol) + 1 : 0;
    const wrapper = createStreamWrapper(
      columns === undefined ? Infinity : Math.max(1, columns - gutter)
    );
    const decoder = new TextDecoder();

    detected ??= createAnsi({ stream: terminal.stderr });
    const colorLevel = opts.colorLevel ?? (opts.ansi ?? detected).level;

    // the glyph is drawn through the theme like any other, and leads the first
    // line only; the rest sit under the first one's text
    let lead =
      symbol && !quiet
        ? `${renderToLines(
            textNode(symbol, {
              class: `sigil-log-symbol sigil-symbol${level ? ` ${ROLE[level]}` : ''}`,
            }),
            { cascade: themedCascade(opts), colorLevel, width: stringWidth(symbol) }
          ).join('')} `
        : '';
    const hang = ' '.repeat(gutter);

    const flush = (lines: string[]): void => {
      if (lines.length === 0 || quiet) {
        return;
      }

      send(
        lines.map((line, index) => {
          const bare = colorLevel === 0 ? strip(line) : line;
          const front = index === 0 ? lead : hang;
          // no trailing blanks on a row with nothing in it
          return bare === '' ? front.trimEnd() : front + bare;
        })
      );
      lead = hang;
    };

    try {
      for await (const chunk of typeof source === 'string' ? [source] : source) {
        flush(
          wrapper.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
        );
      }
      flush(wrapper.push(decoder.decode()));
    } catch (error) {
      // what arrived was real, and a reader who was shown half of an answer
      // should be shown all of that half before being told it stopped
      flush(wrapper.end());
      throw error;
    }

    flush(wrapper.end());
  }

  return {
    error: (message) => write('error', message, symbols.error),
    info: (message) => write('info', message, symbols.info),
    message: (message, o = {}) => write(undefined, message, o.symbol),
    step: (message) => write('step', message, symbols.step),
    stream: {
      error: (source) => stream('error', source, symbols.error),
      info: (source) => stream('info', source, symbols.info),
      message: (source, o = {}) => stream(undefined, source, o.symbol),
      step: (source) => stream('step', source, symbols.step),
      success: (source) => stream('success', source, symbols.success),
      warn: (source) => stream('warn', source, symbols.warn),
    },
    success: (message) => write('success', message, symbols.success),
    warn: (message) => write('warn', message, symbols.warn),
  };
}

/** The process's logger, writing through the process's terminal. */
export const log: Log = createLog();
