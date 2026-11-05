import { sgrRows } from './sgr.ts';

/**
 * What a terminal block draws: rows of styled spans.
 *
 * **One element per row**, which is the whole reason this is rows rather than a
 * string with newlines in it. The design canvas relied on newlines inside a
 * `<pre>` and lost them, so the seal's banner rows ran together; a row that is
 * its own block with `white-space: pre` cannot be joined to the next one by
 * anything, and it is also what lets one row take a different line height --
 * which a run of block characters needs (see `tighten()`).
 *
 * A span says what it is by **token name**, never by colour: `className` holds
 * Tailwind utilities over the tokens in `globals.css` (`text-term-green`,
 * `font-bold`), so the hex values stay in the one file `check-contrast.ts`
 * reads. The two exceptions are `color` and `background`, which only a 256-colour
 * or truecolor sequence produces -- a colour the program named exactly and the
 * design has no token for.
 *
 * Two producers fill these: `sgr.ts` from what a program really printed, and
 * `glyphRows()` below from a transcript written by hand. Both end in
 * `tighten()`, because which rows join up is a fact about the characters and
 * not about where their colour came from.
 */

/** A run of text with one style. */
export interface Span {
  /** Tailwind utilities over the site's tokens. */
  readonly className?: string;
  /** An exact background, from a 256-colour or truecolor sequence. */
  readonly background?: string;
  /** An exact foreground, from a 256-colour or truecolor sequence. */
  readonly color?: string;
  readonly text: string;
}

/** One line of the terminal. */
export interface Row {
  /** What was typed, on a row that echoes a command. */
  readonly command?: string;
  readonly spans: readonly Span[];
  /**
   * Drawn at a line height of about 1.1 rather than the block's own, so that a
   * run of half blocks joins into one picture. See `tighten()`.
   */
  readonly tight?: boolean;
}

/** Block Elements: `█ ▀ ▄ ▌ ▐ ░ ▒ ▓` and the eighths. */
const BLOCK = /[▀-▟]/u;

/**
 * Marks the rows of block characters that have to touch.
 *
 * A half-block banner, a QR code or a large-text heading is a picture drawn one
 * text row per two pixel rows, and it only reads as a picture when each row
 * meets the next. At the body's line height of 1.65 they are separated by a gap
 * of more than half a row, which is what made the seal unreadable on the canvas.
 *
 * Only a **run** of two or more such rows is tightened. A single row with a
 * block in it is a progress bar or a sparkline, which sits among ordinary lines
 * and should keep their spacing; the joining is between rows, so a lone row has
 * nothing to join to.
 *
 * @param rows - The rows.
 * @returns The same rows, with `tight` set on every row in a run.
 */
export function tighten(rows: readonly Row[]): Row[] {
  const blocky = rows.map((row) => row.spans.some((span) => BLOCK.test(span.text)));

  return rows.map((row, at) => {
    const tight = blocky[at] && (blocky[at - 1] === true || blocky[at + 1] === true);
    return tight ? { ...row, tight: true } : row;
  });
}

/**
 * The text a block holds, without any of its styling.
 *
 * What a reader copying a terminal block gets: spans carry their colour in a
 * class name, so the text is exactly the text, and rows are lines.
 *
 * @param rows - The rows.
 * @returns The text, one line per row.
 */
export function plainText(rows: readonly Row[]): string {
  return rows.map((row) => row.spans.map((span) => span.text).join('')).join('\n');
}

/** The prompt a command row is drawn with. */
export const PROMPT = '$';

/**
 * One command, as the row a shell would echo it on.
 *
 * In a **transcript** the `$` and the command are both `dim`, which is the
 * ticket's reading: the output is what the block is showing, and the command
 * that produced it is its caption. In a **script** -- a ```` ```sh ```` block,
 * which is commands and nothing else -- the command is the content, so only the
 * prompt is dim and the command is the terminal's own text.
 *
 * @param command - What was typed, without the prompt.
 * @param echo - Whether this is a transcript's echo, rather than a script's line.
 * @returns The row.
 */
export function commandRow(command: string, echo = true): Row {
  return {
    command,
    spans: [
      { className: 'text-dim', text: `${PROMPT} ` },
      echo ? { className: 'text-dim', text: command } : { text: command },
    ],
  };
}

/**
 * The glyphs that open a status line, and what each is drawn in.
 *
 * These are the symbols sigil's own components print -- the log's `ℹ ✔ ⚠ ✖`,
 * a prompt's `?` and `›`, the intro's `◆` -- plus the `▲` the design names for a
 * warning. Only the glyph is coloured: the message after it is the program's
 * text, and a hand-written transcript claiming a colour for it would be claiming
 * more than a reader can check.
 */
const GLYPHS: readonly [RegExp, string][] = [
  [/^[✔✓]/u, 'text-term-green'],
  [/^[✖✗]/u, 'text-term-red'],
  [/^[▲⚠]/u, 'text-term-yellow'],
  [/^ℹ/u, 'text-term-blue'],
  // the spinner's frames are Braille
  [/^(?:\?(?= )|[›◆◇❯]|[⠀-⣿])/u, 'text-term-accent'],
];

/** A section heading, as help prints one: `Commands:` alone on its line. */
const HEADING = /^[A-Z][\w -]*:$/u;

/** The usage line, whose heading has the usage after it. */
const USAGE = /^Usage:(?= )/u;

/** A `key=value` field, as a log line carries them. */
const FIELD = /(?<![\w=])[\w.-]+=(?:"[^"]*"|\S+)/gu;

/**
 * One line of a hand-written transcript, coloured by what it starts with.
 *
 * @param line - The line.
 * @returns The row.
 */
function glyphRow(line: string): Row {
  if (line.startsWith(`${PROMPT} `)) {
    return commandRow(line.slice(PROMPT.length + 1));
  }

  // `...` is an elision written into a transcript, and drawing it dim says
  // that it is not something the program printed
  if (line.trim() === '...') {
    return { spans: [{ className: 'text-dim', text: line }] };
  }

  if (HEADING.test(line)) {
    return { spans: [{ className: 'font-bold text-fg-strong', text: line }] };
  }

  const spans: Span[] = [];
  let rest = line;

  const usage = USAGE.exec(rest);
  if (usage) {
    spans.push({ className: 'font-bold text-fg-strong', text: usage[0] });
    rest = rest.slice(usage[0].length);
  } else {
    const indent = /^ */u.exec(rest)![0];
    const after = rest.slice(indent.length);
    const glyph = GLYPHS.find(([pattern]) => pattern.test(after));

    if (glyph) {
      // one grapheme: every glyph above is a single code point
      const symbol = [...after][0]!;
      if (indent) {
        spans.push({ text: indent });
      }
      spans.push({ className: glyph[1], text: symbol });
      rest = after.slice(symbol.length);
    }
  }

  let at = 0;
  for (const match of rest.matchAll(FIELD)) {
    if (match.index > at) {
      spans.push({ text: rest.slice(at, match.index) });
    }
    spans.push({ className: 'text-dim', text: match[0] });
    at = match.index + match[0].length;
  }
  if (at < rest.length) {
    spans.push({ text: rest.slice(at) });
  }

  return { spans };
}

/**
 * A transcript written by hand, coloured by its glyphs.
 *
 * The fallback for a ```` ```console ```` block nobody captured: a `$` line is a
 * command, a line that opens with a status glyph has the glyph coloured, a help
 * heading is bold, and a `key=value` field is dim. Nothing else is coloured,
 * because nothing else can be read off the text.
 *
 * @param text - The transcript.
 * @returns The rows.
 */
export function glyphRows(text: string): Row[] {
  return tighten(text.split('\n').map(glyphRow));
}

/**
 * A script of commands, as the rows a shell would echo them on.
 *
 * What a ```` ```sh ```` block is: every line is something to type, so every
 * line gets a prompt -- except a comment, which is drawn dim with none, and a
 * line continuing the one before it with a trailing `\`, which a shell shows
 * without a prompt too. A continuation is not a row of its own to `copiedText()`,
 * which is why a script's Copy button is handed the script itself.
 *
 * @param text - The script.
 * @returns The rows.
 */
export function shellRows(text: string): Row[] {
  const lines = text.split('\n');

  return lines.map((line, at) => {
    if (line.trim() === '') {
      return { spans: [] };
    }
    if (/^\s*#/u.test(line)) {
      return { spans: [{ className: 'text-dim', text: line }] };
    }
    if (at > 0 && lines[at - 1]!.endsWith('\\')) {
      return { spans: [{ text: line }] };
    }
    return commandRow(line, false);
  });
}

/** What a captured transcript is asked for: the command, and what it printed. */
export type Lookup = (command: string, output: string) => string | undefined;

/**
 * A ```` ```console ```` block, in real colour wherever it can be.
 *
 * The block is read the way `packages/cli/test/guides.ts` reads it: a `$` line
 * and the lines under it, up to the next `$`. Each of those is handed to
 * `lookup`, which answers with what the program **really** printed -- with its
 * escape sequences -- when there is a capture of that command whose text is
 * exactly the block's. A run with a capture is drawn from it; one without is
 * drawn by `glyphRows()`. So a block is never coloured from output that says
 * something different from what the page shows.
 *
 * @param text - The transcript.
 * @param lookup - The captures.
 * @returns The rows.
 */
export function consoleRows(text: string, lookup: Lookup): Row[] {
  const rows: Row[] = [];

  for (const chunk of text.split(/^(?=\$ )/mu)) {
    if (!chunk.startsWith(`${PROMPT} `)) {
      rows.push(...glyphRows(chunk.replace(/\n$/u, '')));
      continue;
    }

    const [first = '', ...rest] = chunk.replace(/\n$/u, '').split('\n');
    const command = first.slice(PROMPT.length + 1);
    const output = rest.join('\n');
    const captured = lookup(command, output);

    rows.push(commandRow(command));
    if (captured !== undefined) {
      rows.push(...sgrRows(captured));
    } else if (rest.length > 0) {
      rows.push(...glyphRows(output));
    }
  }

  return tighten(rows);
}

/**
 * What the Copy button on a terminal block puts on the clipboard.
 *
 * The **commands**, without their prompts, whenever the block has any: a reader
 * copying a transcript wants to run it, and pasting `$ my-cli --help` and the
 * help screen under it into a shell runs neither. A block with no command in it
 * is output alone, and copying it gets the output.
 *
 * A selection is different and is left alone: selecting across the rows gets
 * the block as it reads, prompts and output together, because a reader who
 * drags over a transcript is quoting it rather than running it.
 *
 * @param rows - The rows.
 * @returns The text to copy.
 */
export function copiedText(rows: readonly Row[]): string {
  const commands = rows.flatMap((row) => (row.command === undefined ? [] : [row.command]));
  return commands.length > 0 ? commands.join('\n') : plainText(rows);
}
