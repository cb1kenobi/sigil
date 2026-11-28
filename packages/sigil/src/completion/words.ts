/**
 * A typed line as the words a shell would split it into, and a word back into a
 * line.
 *
 * A REPL that runs commands through the parser has to turn
 * `deploy --tag "release 1" 'it'\''s'` into the argv a shell would have handed
 * `main()`, and the completion of what is being typed needs the same splitter
 * run the other way: where the word under the cursor starts, whether it is inside
 * a quote that is still open, and how to write a candidate holding a space back
 * into the line. So the result is a list of words each carrying the range it was
 * read from and how it began, and a plain argv is one `.map()` away.
 *
 * ## The grammar is POSIX `sh` word splitting, and nothing is expanded
 *
 * - **Outside quotes** a space, tab, newline or carriage return ends a word, and
 *   a backslash makes the next character part of the word, whatever it is. A
 *   backslash before a newline is a line continuation and says nothing. A
 *   carriage return ends a word too, which `sh` does not do: a line pasted with
 *   CRLF endings should not carry one into its last word.
 * - **Single quotes** hold everything literally up to the next single quote.
 * - **Double quotes** hold everything literally except that a backslash before
 *   `"`, `\`, `$` or a backtick takes the backslash away, and a backslash before
 *   a newline is a continuation. Before anything else a backslash is itself.
 * - **`$'...'`** is the form bash, zsh, ksh and POSIX.1-2024 read for a string
 *   with escapes in it. It is read because `quoteWord()` writes it -- it is the
 *   one way to spell a control character without printing it -- and it is a
 *   quote, not an expansion: `\n`, `\t`, `\e` and the rest of the single
 *   character escapes, `\xNN` and `\NNN` as a byte, `\uNNNN` and `\UNNNNNNNN` as
 *   a code point, and a run of bytes is read as the UTF-8 it is, across adjacent
 *   `$'...'` parts too. An escape this does not know -- `\cX`, and zsh's `\C-` and
 *   `\M-` -- stays as typed, where each shell has its own answer for it.
 *
 * What is **not** done is every expansion: `$HOME`, `${x}`, `~`, `*` and `?`, a
 * command substitution, `#` as a comment and `| ; & < >` as operators are all
 * ordinary characters of a word. The REPL is not a shell, and expanding any of
 * them would make a line mean one thing here and another in a terminal.
 *
 * It is one grammar on every platform. `cmd.exe` and PowerShell quote
 * differently, and the REPL is the app's own prompt rather than the platform's
 * shell.
 *
 * ## An unterminated quote is a word still being typed
 *
 * `splitWords()` says which quote the line ends inside, and the word it ends in
 * holds what had been typed of it. Whether that is an error or a continuation
 * line is the caller's: a splitter that decided would decide for every prompt.
 *
 * The column numbers are indices into the string, as `String.prototype.slice()`
 * reads them.
 */

import { escapeControls } from '../util/escape-controls.js';
import { ansiCBody, isUnsafeChar, SAFE_PUNCTUATION, shQuote } from './quote.js';

/** A quote that can hold a word's text: `'`, `"` or the `$'` of an escaped string. */
export type WordQuote = "'" | '"' | "$'";

/**
 * What a line can be left inside: a quote, or a backslash with nothing after it.
 */
export type Unfinished = WordQuote | '\\';

/** One word of a line. */
export interface Word {
  /** The word as a shell would hand it to a program: the quotes and escapes taken off. */
  value: string;
  /** Where the word starts in the line, at its first character or its opening quote. */
  start: number;
  /** Where the word ends, one past its last character or its closing quote. */
  end: number;
  /** The quote the word opens with, or `undefined` for one that starts bare. */
  quote: WordQuote | undefined;
}

/** What `splitWords()` returns. */
export interface Split {
  /** The words, in order. */
  words: Word[];
  /**
   * What the line ends inside, or `undefined` when it ends in the clear. Only the
   * last word can be unfinished, and it holds the text typed so far.
   */
  open: Unfinished | undefined;
}

/** What `wordAt()` returns. */
export interface WordAt {
  /** The whole word under the cursor, as `splitWords()` would read it. */
  value: string;
  /** What of it was typed before the cursor, read the same way: the text a candidate has to match. */
  before: string;
  /** Where the word starts in the line. */
  start: number;
  /** Where the word ends, which is past the cursor when the cursor is inside it. */
  end: number;
  /**
   * Where a replacement starts. It runs from here to the cursor, and what follows
   * the cursor stays: just after the opening quote when the cursor is inside the
   * quote the word opened with, and the word's `start` otherwise.
   */
  from: number;
  /**
   * The quote the cursor is inside and the replacement begins just after, so
   * `quoteWord(candidate, quote)` writes the text to put there and the user's own
   * quoting survives. `undefined` is a replacement that is a whole word.
   */
  quote: WordQuote | undefined;
}

/** A word read from a line, with what the reader was left holding. */
interface Scanned {
  word: Word;
  /** Whether anything was read: a lone line continuation reads as nothing. */
  real: boolean;
  open: Unfinished | undefined;
  /** Whether the quote the word opened with is the one still open. */
  inFirst: boolean;
  /** Where the opening quote is, which a line continuation before it puts after the word's start. */
  quoteAt: number;
}

const HEX = /^[0-9A-Fa-f]+/;
const OCTAL = /^[0-7]{1,3}/;

/** The single-character escapes of `$'...'`. */
const SIMPLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['a', '\u0007'],
  ['b', '\b'],
  ['e', '\u001B'],
  ['E', '\u001B'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
  ['\\', '\\'],
  ["'", "'"],
  ['"', '"'],
  ['?', '?'],
]);

const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function isBlank(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * Reads one `$'...'` escape, which starts at a backslash.
 *
 * Bytes are returned as bytes and not as characters so the caller can read a
 * run of them as the UTF-8 they are, which is what a shell in a UTF-8 locale
 * does and what `quoteWord()` writes.
 *
 * @param line - The line.
 * @param at - The index of the backslash.
 * @returns What it reads as, and the index after it.
 */
function readEscape(line: string, at: number): { byte?: number; text?: string; next: number } {
  const char = line.charAt(at + 1);
  if (char === '') {
    return { text: '\\', next: at + 1 };
  }

  const simple = SIMPLE_ESCAPES.get(char);
  if (simple !== undefined) {
    return { text: simple, next: at + 2 };
  }

  if (char === 'x') {
    const digits = HEX.exec(line.slice(at + 2, at + 4));
    if (digits !== null) {
      return { byte: Number.parseInt(digits[0], 16), next: at + 2 + digits[0].length };
    }
  } else if (char === 'u' || char === 'U') {
    const digits = HEX.exec(line.slice(at + 2, at + 2 + (char === 'u' ? 4 : 8)));
    const code = digits === null ? Number.NaN : Number.parseInt(digits[0], 16);
    if (code <= 0x10ffff) {
      return { text: String.fromCodePoint(code), next: at + 2 + (digits?.[0].length ?? 0) };
    }
  } else if (char >= '0' && char <= '7') {
    const digits = OCTAL.exec(line.slice(at + 1, at + 4))!;
    return { byte: Number.parseInt(digits[0], 8) & 0xff, next: at + 1 + digits[0].length };
  }

  // not an escape this knows, so it stays as typed
  const whole = String.fromCodePoint(line.codePointAt(at + 1)!);
  return { text: `\\${whole}`, next: at + 1 + whole.length };
}

/**
 * Reads the word that starts at `start`, up to a blank or the end of the line.
 *
 * @param line - The line, or the part of it that is known.
 * @param start - Where the word starts: the first character, not a blank.
 * @returns The word and the state the reader finished in.
 */
function scanWord(line: string, start: number): Scanned {
  let value = '';
  let i = start;
  let quote: WordQuote | undefined;
  let open: Unfinished | undefined;
  let inFirst = false;
  let quoteAt = start;
  let real = false;
  // bytes read from `$'\xNN'` escapes, waiting to be read as UTF-8
  let bytes: number[] = [];

  const flush = () => {
    if (bytes.length > 0) {
      value += decoder.decode(Uint8Array.from(bytes));
      bytes = [];
    }
  };
  // bytes wait across a closing quote, so `$'\xC3'$'\xA9'` is the one character
  // a shell reads it as, and are decoded when anything else is added
  const add = (text: string) => {
    flush();
    value += text;
  };

  while (i < line.length) {
    const char = line.charAt(i);

    if (open === undefined) {
      if (isBlank(char)) {
        break;
      }
      if (char === '\\') {
        const next = line.charAt(i + 1);
        if (next === '') {
          real = true;
          open = '\\';
          i++;
        } else if (next === '\n') {
          i += 2;
        } else {
          const whole = String.fromCodePoint(line.codePointAt(i + 1)!);
          add(whole);
          i += 1 + whole.length;
          real = true;
        }
        continue;
      }

      const mark: WordQuote | undefined =
        char === "'"
          ? "'"
          : char === '"'
            ? '"'
            : char === '$' && line[i + 1] === "'"
              ? "$'"
              : undefined;
      if (mark !== undefined) {
        if (!real) {
          quote = mark;
          quoteAt = i;
          inFirst = true;
        }
        open = mark;
        real = true;
        i += mark.length;
        continue;
      }

      add(char);
      real = true;
      i++;
      continue;
    }

    // inside a quote
    if (open === "'") {
      if (char === "'") {
        open = undefined;
        inFirst = false;
      } else {
        add(char);
      }
      i++;
    } else if (open === '"') {
      if (char === '"') {
        open = undefined;
        inFirst = false;
        i++;
      } else if (char === '\\') {
        const next = line.charAt(i + 1);
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          add(next);
          i += 2;
        } else if (next === '\n') {
          i += 2;
        } else {
          add('\\');
          i++;
        }
      } else {
        add(char);
        i++;
      }
    } else if (char === "'") {
      open = undefined;
      inFirst = false;
      i++;
    } else if (char === '\\') {
      const escape = readEscape(line, i);
      if (escape.byte === undefined) {
        add(escape.text ?? '');
      } else {
        bytes.push(escape.byte);
      }
      i = escape.next;
    } else {
      add(char);
      i++;
    }
  }

  flush();
  return {
    word: { value, start, end: i, quote },
    real,
    open,
    inFirst: inFirst && open !== undefined,
    quoteAt,
  };
}

/**
 * Splits a line into the words a shell would, with no expansion.
 *
 * The grammar and what it leaves alone are in this module's header. `value` is
 * what a program would be handed; `start` and `end` are where the word is in
 * `line`; `quote` is how it began. The line is left unchanged -- a `Word` is a
 * reading of it, so a caller can put back exactly what was typed.
 *
 * @param line - The line.
 * @returns The words and what the line ends inside.
 */
export function splitWords(line: string): Split {
  const words: Word[] = [];
  let open: Unfinished | undefined;
  let i = 0;
  while (i < line.length) {
    if (isBlank(line.charAt(i))) {
      i++;
      continue;
    }
    const scanned = scanWord(line, i);
    if (scanned.real) {
      words.push(scanned.word);
    }
    open = scanned.open;
    i = scanned.word.end;
  }
  return { words, open };
}

/**
 * The word the cursor is in, and where a completion for it goes.
 *
 * A cursor touching a word -- at its start, inside it, or just after its last
 * character -- is in it; anywhere else it is at the start of a word that has
 * not been typed yet, which is `value` and `before` both `''` with nothing to
 * replace. `before` is the word's text up to the cursor, read the way the whole
 * is, which is what a candidate is matched against: the `\ ` in `two\ w` is a
 * space, as it is for a shell.
 *
 * A replacement runs from `from` to `cursor`. Where the cursor is inside the
 * quote the word opened with, `from` is just after that quote and `quote` names
 * it, so `quoteWord(candidate, quote)` is the text to put there and the user's
 * own quoting is kept. Everywhere else `from` is the start of the word and
 * `quoteWord(candidate)` replaces all of it.
 *
 * @param line - The line.
 * @param cursor - Where the cursor is: an index from `0` to `line.length`.
 * @returns The word under the cursor and its replacement range.
 * @throws {RangeError} When `cursor` is not an index into the line.
 */
export function wordAt(line: string, cursor: number): WordAt {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > line.length) {
    throw new RangeError(
      `Expected cursor to be an integer from 0 to ${line.length}, got ${escapeControls(cursor)}`
    );
  }

  const word = splitWords(line).words.find((w) => w.start <= cursor && cursor <= w.end);
  if (word === undefined) {
    return { value: '', before: '', start: cursor, end: cursor, from: cursor, quote: undefined };
  }

  // the part before the cursor, read on its own, which is how it was typed
  const typed = scanWord(line.slice(0, cursor), word.start);
  const quote = typed.inFirst ? word.quote : undefined;
  return {
    value: word.value,
    before: typed.word.value,
    start: word.start,
    end: word.end,
    from: quote === undefined ? word.start : typed.quoteAt + quote.length,
    quote,
  };
}

const SAFE_WORD = new RegExp(`^[\\p{L}\\p{M}\\p{N}${SAFE_PUNCTUATION}]+$`, 'u');

/**
 * Splits a string into runs that are safe to print and runs that are not.
 *
 * @param value - The string.
 * @returns Each run and whether it is one `isUnsafeChar()` names.
 */
function runsOf(value: string): { text: string; unsafe: boolean }[] {
  const runs: { text: string; unsafe: boolean }[] = [];
  for (const char of value) {
    const unsafe = isUnsafeChar(char);
    const last = runs.at(-1);
    if (last?.unsafe === unsafe) {
      last.text += char;
    } else {
      runs.push({ text: char, unsafe });
    }
  }
  return runs;
}

/**
 * A value as the text that `splitWords()` reads back as that value.
 *
 * With no `context` it is a whole word, and a value that cannot be misread is
 * left bare: a letter, a digit or one of `_@%+=:,./-` is all that is safe, so
 * `deploy` and `--tag=v1.2` are written as they are (a leading `=` is the one
 * exception: zsh expands `=ls` to a path, and the line should read the same there) and `my file`, `~/x`, `a|b`
 * and the empty string are quoted. That class is the one the generated bash
 * script tests a candidate against before it quotes it, and the rest is what
 * `bashQuote()` does: single quotes, with `'` written `'\''`.
 *
 * A character that is a control character or one that draws as nothing -- a
 * bidi override, a zero-width joiner, a variation selector -- is never written
 * raw. It is written as its UTF-8 bytes inside `$'...'`, one `\xNN` each, which
 * is the only way a POSIX-shaped quote has of saying one, and the same spelling
 * the installer prints a path in. A line holding one is therefore the line
 * somebody can read, and one a terminal does not act on.
 *
 * With a `context` the line already holds a quote, opened before this text and
 * not yet closed -- which is what `wordAt()` reports -- and the result is what
 * goes after it. The quote is **left open** at the end, so the caller adds the
 * closing one when the word is final and not when it is only a common prefix.
 * Inside `'` the one thing that cannot be said is `'`, which closes and reopens;
 * inside `"` a backslash, `"`, `$` and a backtick take a backslash; inside `$'`
 * a backslash and `'` do. Anything unsafe steps out into its own `$'...'` and
 * back, so `"` + `quoteWord(x, '"')` + `"` is always the word `x`.
 *
 * @param value - The text to write.
 * @param context - The quote the text goes inside, where there is one.
 * @returns The text to insert.
 * @throws {TypeError} When `context` is not `'`, `"` or `$'`.
 */
export function quoteWord(value: string, context?: WordQuote): string {
  if (context === undefined) {
    if (
      value !== '' &&
      escapeControls(value) === value &&
      SAFE_WORD.test(value) &&
      value[0] !== '='
    ) {
      return value;
    }
    if (value === '') {
      return "''";
    }
    return runsOf(value)
      .map(({ text, unsafe }) => (unsafe ? `$'${ansiCBody(text)}'` : shQuote(text)))
      .join('');
  }

  if (context === "$'") {
    return ansiCBody(value);
  }
  if (context !== "'" && context !== '"') {
    throw new TypeError(`Expected quote to be ', " or $', got ${escapeControls(context)}`);
  }

  return runsOf(value)
    .map(({ text, unsafe }) => {
      if (unsafe) {
        return `${context}$'${ansiCBody(text)}'${context}`;
      }
      return context === "'" ? text.replaceAll("'", "'\\''") : text.replaceAll(/["\\$`]/g, '\\$&');
    })
    .join('');
}
