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
 *
 * A line may carry fields -- `deployed host=a ms=412` -- and a logger may stamp
 * each line with the time. Both are for the reader of a file as much as of a
 * screen, which is why they are plain text in a fixed shape.
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

/**
 * The key-value pairs a line carries after its message.
 *
 * Written in insertion order, and a value that is `undefined` is left out, so
 * `{ host: opts.host }` says nothing when there is no host rather than
 * `host=undefined`.
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * How a line is stamped.
 *
 * - `true` or `'time'`: the local time, `18:50:17`.
 * - `'iso'`: the instant in UTC, `2026-10-30T18:50:17.547Z`, which is what a
 *   file that is read on another machine wants.
 * - A function: whatever it returns, with line breaks and control characters
 *   replaced by a space so that a stamp cannot start a second line.
 */
export type LogTimestamp = boolean | 'iso' | 'time' | ((date: Date) => string);

export interface LogOptions extends StyledOptions {
  /** Use `LOG_SYMBOLS_ASCII`. Defaults to false. */
  ascii?: boolean;
  /** The clock the timestamps read. Defaults to the system's. */
  now?: () => Date;
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
  /** Stamp every line with the time. Off by default. */
  timestamp?: LogTimestamp;
}

export interface LogMessageOptions {
  /** Fields to write after the message. */
  fields?: LogFields;
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
  error(message: string, fields?: LogFields): void;
  /** Something worth knowing that is not progress. */
  info(message: string, fields?: LogFields): void;
  /** A line with no level of its own. */
  message(message: string, opts?: LogMessageOptions): void;
  /** The start of a stage of the work. */
  step(message: string, fields?: LogFields): void;
  /** Something finished. */
  success(message: string, fields?: LogFields): void;
  /**
   * Status lines whose text has not all arrived yet: an LLM's answer, a
   * subprocess's output.
   */
  readonly stream: LogStream;
  /** Something is off but the run goes on. Written even when the run is quiet. */
  warn(message: string, fields?: LogFields): void;
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

/** A key or value that can stand bare: no blank, quote, `=`, backslash or control. */
const BARE = /^[^\s"=\\\p{Cc}\p{Zl}\p{Zp}]+$/u;

/** What cannot be written as itself inside quotes. */
const UNSAFE = /["\\\p{Cc}\p{Zl}\p{Zp}]/gu;

const ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '"': '\\"',
  '\\': '\\\\',
};

/**
 * One key or one value, quoted when it has to be.
 *
 * A bare word is written as it is. Anything with a blank, a quote, an `=`, a
 * backslash or a control character is quoted, and inside the quotes everything
 * that could end the line or move the cursor is written as an escape -- the line
 * feed as `\n`, the rest as `\uXXXX`. That is the rule a field cannot forge a
 * second line by: a value is one token on one line whatever it holds, and a
 * U+2028 is as much a line break to some readers as a `\n` is.
 *
 * @param value - The text.
 * @returns The token.
 */
function token(value: string): string {
  if (value !== '' && BARE.test(value)) {
    return value;
  }

  return `"${value.replace(
    UNSAFE,
    (char) => ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  )}"`;
}

/** A value of any type, as the text that is quoted. `undefined` is `undefined`. */
function fieldText(value: unknown): string | undefined {
  switch (typeof value) {
    case 'undefined':
      return undefined;
    case 'string':
      return value;
    case 'object': {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
      }
      if (value instanceof Error) {
        return value.message;
      }
      try {
        // a value with a `toJSON()` of its own is trusted to say what it is
        return JSON.stringify(value) ?? String(value);
      } catch {
        // a cycle, or a BigInt inside: what it prints as is better than a throw
        // from a status line
        return String(value);
      }
    }
    default:
      return String(value);
  }
}

/**
 * Fields as `key=value` pairs separated by a space.
 *
 * Quoting is `token()`'s, applied to the key as well as the value, so a key
 * cannot carry a line break either. A value that is not a string is written the
 * way it would be in JSON where that is a thing -- an object, an array -- and as
 * `String()` otherwise. An empty result is the empty string, so a caller can ask
 * whether there was anything to write.
 *
 * @param fields - The pairs.
 * @returns The text, one line.
 */
export function formatLogFields(fields: LogFields | undefined): string {
  const pairs: string[] = [];

  for (const [key, value] of Object.entries(fields ?? {})) {
    const written = fieldText(value);
    if (written !== undefined) {
      pairs.push(`${token(key)}=${token(written)}`);
    }
  }

  return pairs.join(' ');
}

/** The stamp for one line, or `undefined` for none. */
function stamp(option: LogTimestamp | undefined, date: Date): string | undefined {
  if (!option) {
    return undefined;
  }

  if (typeof option === 'function') {
    return String(option(date))
      .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
      .trim();
  }

  if (option === 'iso') {
    return date.toISOString();
  }

  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

/** What goes around a message: the time before it and the fields after it. */
export interface LogExtras {
  /** The fields, already written by `formatLogFields()`. */
  fields?: string;
  /** The stamp. */
  time?: string;
  /** The width the line is laid out in, which decides whether the fields fit beside the text. */
  width?: number;
}

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
export function logView(
  message: string,
  symbol: string | undefined,
  role?: string,
  extras: LogExtras = {}
): Element {
  // one node per line of the caller's text: the layout collapses a newline, and
  // a blank line is a node of its own so that it survives
  const lines = message.split(/\r?\n/).map((line) => textNode(line, { class: 'sigil-log-text' }));
  const children: Element[] = [...lines];

  if (extras.fields) {
    const last = message.split(/\r?\n/).at(-1) ?? '';
    const beside =
      extras.width === undefined ||
      stringWidth(last) + 1 + stringWidth(extras.fields) <= extras.width;
    const written = textNode(extras.fields, {
      class: 'sigil-log-fields sigil-muted',
      'flex-shrink': 1,
      ...(beside ? { 'margin-left': 1 } : {}),
    });

    if (beside) {
      // the fields belong to the last line of the text, which stays a node of its
      // own so that it is measured the way it was
      children.pop();
      children.push(
        box(
          { class: 'sigil-log-line', 'flex-direction': 'row' },
          lines[lines.length - 1] as Element,
          written
        )
      );
    } else {
      // too wide to share a row: under the text, which is still one line of
      // fields rather than a pair per row, so it reads as one record
      children.push(written);
    }
  }

  const body = box(
    { class: 'sigil-log-body', 'flex-direction': 'column', 'flex-shrink': 1 },
    ...children
  );
  const columns: Element[] = [];

  if (extras.time) {
    columns.push(
      textNode(extras.time, {
        class: 'sigil-log-time sigil-muted',
        'flex-shrink': 0,
        'margin-right': 1,
      })
    );
  }

  if (symbol) {
    columns.push(
      textNode(symbol, {
        class: `sigil-log-symbol sigil-symbol${role ? ` ${role}` : ''}`,
        'flex-shrink': 0,
        'margin-right': 1,
      })
    );
  }

  return box({ class: 'sigil-log' }, ...columns, body);
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

  function write(
    level: Level | undefined,
    message: string,
    symbol: string | undefined,
    given?: LogFields
  ): void {
    if (silenced(level)) {
      return;
    }

    // after the quiet check, so a line that is dropped never reads the clock or
    // runs a getter on a field
    const fields = formatLogFields(given);
    const time = stamp(opts.timestamp, (opts.now ?? (() => new Date()))());
    const gutter = (time ? stringWidth(time) + 1 : 0) + (symbol ? stringWidth(symbol) + 1 : 0);

    detected ??= createAnsi({ stream: terminal.stderr });
    const colorLevel = opts.colorLevel ?? (opts.ansi ?? detected).level;

    // a log file is not wrapped for a screen: the reader has a pager, and a line
    // cut at 80 columns is one that cannot be grepped whole
    const columns = screenWidth();
    const rows = message.split(/\r?\n/).map((line) => stringWidth(line));
    // the fields share the last row when they fit, so a file -- which has no
    // limit -- always has them there
    const beside = fields ? stringWidth(fields) + 1 : 0;
    const last = rows.length - 1;
    const widest = Math.max(...rows.slice(0, last), (rows[last] ?? 0) + beside);
    const width = columns ?? widest + gutter + 1;
    const view = logView(message, symbol, level && ROLE[level], {
      fields,
      time,
      width: width - gutter,
    });

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
    error: (message, fields) => write('error', message, symbols.error, fields),
    info: (message, fields) => write('info', message, symbols.info, fields),
    message: (message, o = {}) => write(undefined, message, o.symbol, o.fields),
    step: (message, fields) => write('step', message, symbols.step, fields),
    stream: {
      error: (source) => stream('error', source, symbols.error),
      info: (source) => stream('info', source, symbols.info),
      message: (source, o = {}) => stream(undefined, source, o.symbol),
      step: (source) => stream('step', source, symbols.step),
      success: (source) => stream('success', source, symbols.success),
      warn: (source) => stream('warn', source, symbols.warn),
    },
    success: (message, fields) => write('success', message, symbols.success, fields),
    warn: (message, fields) => write('warn', message, symbols.warn, fields),
  };
}

/** The process's logger, writing through the process's terminal. */
export const log: Log = createLog();
