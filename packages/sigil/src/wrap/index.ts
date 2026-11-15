import { stringWidth } from '../width/index.js';
import { isBreakSpace } from './breaks.js';
import { createSgrState, isSgr, type SgrState } from './sgr-state.js';
import { type Token, tokenize } from './tokens.js';

export { isBreakSpace } from './breaks.js';
export { createSgrState, isSgr, type SgrState } from './sgr-state.js';
export { type Token, tokenize } from './tokens.js';

/** What a terminal is assumed to be when there is no terminal to ask. */
export const DEFAULT_WIDTH = 80;

/**
 * How wide generated output is allowed to get.
 *
 * A line of prose is hard to read much past this, and a maximized window on a
 * wide display is three times it -- so a terminal's width is a ceiling on how
 * much room there is, not an instruction to use all of it.
 */
export const MAX_WIDTH = 100;

export interface TerminalWidthOptions {
  /** The environment to read `COLUMNS` from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** What to use when there is nothing to ask. Defaults to 80. */
  fallback?: number;
  /** The widest result. Defaults to 100; pass `Infinity` for no cap. */
  max?: number;
  /** The stream to measure. Defaults to `process.stdout`. */
  stream?: { columns?: number };
}

/**
 * How many columns there are to write into.
 *
 * `process.stdout.columns` is the answer when there is a terminal. When there is
 * not -- a pipe, a file, a CI log -- there is no width to detect, and 80 is the
 * convention for what to assume.
 *
 * `COLUMNS` is read first, because it is how a caller says what to use when the
 * stream cannot be asked, and how a test says it without a pseudo-terminal.
 *
 * @param opts - Where to read the width from.
 * @returns The number of columns.
 */
export function terminalWidth(opts: TerminalWidthOptions = {}): number {
  const env = opts.env ?? process.env;
  const stream = 'stream' in opts ? opts.stream : process.stdout;

  // a cap or a fallback that is not a width is no instruction at all, and
  // carrying it through would come back out as the answer
  const max = opts.max !== undefined && opts.max > 0 ? opts.max : MAX_WIDTH;
  const fallback = positive(opts.fallback) ?? DEFAULT_WIDTH;

  const columns = positive(env.COLUMNS) ?? positive(stream?.columns) ?? fallback;

  return Math.min(columns, max);
}

/**
 * A column count, or `undefined` for anything that is not one. A stream that is
 * not a terminal reports no columns at all, and `COLUMNS` is whatever some shell
 * happened to export.
 *
 * @param value - The value to read.
 * @returns The count, when it is one.
 */
function positive(value: string | number | undefined): number | undefined {
  if (typeof value === 'string') {
    // the whole string, not as much of it as parses: `COLUMNS=12junk` is not
    // somebody saying twelve
    return /^\s*\d+\s*$/.test(value) ? positive(Number(value)) : undefined;
  }

  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export interface WrapOptions {
  /**
   * Whether the text is what is left of a longer one after a row that ended where
   * `wrapRows()` said it did, rather than a text of its own. Off by default.
   *
   * Its first line is then the next row of that wrap and not the first line of
   * anything: it has the room and the hanging indent a row after the first has,
   * and the blanks in front of its first word are not indentation, since what
   * dropped the ones a break leaves behind was the break. Without it the same
   * text wraps as a new one would -- a row that starts with something that takes
   * no columns, and a blank run after it, is a line of indentation.
   *
   * It is for an end inside a paragraph. An end past a newline starts a new one,
   * whose blanks *are* indentation and which `continued` would drop: see
   * `WrappedRows.ends`.
   */
  continued?: boolean;
  /**
   * Whether to break a word too long for a line of its own. On by default: a
   * path or a URL longer than the terminal is wide is the case that makes this
   * matter, and letting it run past the edge is what wrapping was supposed to
   * prevent. Off, such a word overflows on a line of its own.
   */
  hard?: boolean;
  /**
   * Added to every line after the first, on top of `indent`. This is the
   * hanging indent a two-column list is made of: the first line carries the
   * term, and what wraps under it lines up with the definition.
   *
   * The first line means the first line of the output, not the first line of
   * each paragraph. The term it hangs from is printed once, so everything
   * under it lines up -- including what follows a newline already in the text.
   */
  hangingIndent?: number | string;
  /** Added to the front of every line. Counts against the width. */
  indent?: number | string;
  /** The column to wrap at. Defaults to `terminalWidth()`. */
  width?: number;
}

/**
 * Wraps text to a column count, keeping the styling and the characters intact.
 *
 * Three things make this more than splitting on spaces:
 *
 * - A break may not fall inside an escape sequence or inside a grapheme
 *   cluster. Both are found rather than assumed, so a flag emoji and a
 *   `ESC[38;2;...m` each come out whole.
 * - A style open at a break is closed at the end of that line and opened again
 *   on the next, so nothing bleeds into an indent or into whatever reads the
 *   output a line at a time.
 * - A column is not a character. `日本語` is three characters and
 *   six columns, and wrapping to the wrong one of those is how a table stops
 *   lining up.
 *
 * Newlines already in the text are kept, each line wrapped on its own, and the
 * styling carries across them. A tab is treated as one space: how wide a tab is
 * depends on the column it lands in, and wrapping is the thing that moves it.
 *
 * Trailing whitespace is dropped from every line, including a line that did not
 * need wrapping. A terminal draws nothing for it, it is what a break at a space
 * would leave behind anyway, and leaving it makes a measured line wider than
 * what anybody can see. Leading whitespace is kept: that is indentation. The
 * one exception is indentation that leaves no room for the line's first
 * character, which is dropped rather than written out as a line of nothing but
 * spaces, wider than the width.
 *
 * A width that is `NaN`, zero or negative holds nothing, so the answer is the
 * empty string, which is what `truncate()` answers too. `Infinity` wraps nothing.
 *
 * @param text - The text to wrap.
 * @param opts - The width to wrap at, or the options.
 * @returns The wrapped text.
 */
export function wrap(text: string, opts: WrapOptions | number = {}): string {
  return layout(text, opts).join('\n');
}

/** The rows of a wrap, and where in the text each one stopped. */
export interface WrappedRows {
  /**
   * For each row, the offset into the text where the next row's input begins:
   * just past everything the row took **and** the blanks the break after it
   * dropped, so `text.slice(ends[i])` is what is left to wrap and starts on the
   * first thing row `i + 1` takes. A row that ends where a newline was ends
   * past the newline, and the last row ends at `text.length`.
   *
   * A word too long for a line is broken between clusters, so a row can end
   * inside a word. The sequences a row passed -- among its own text, and in the
   * blanks dropped after it -- are all before its end, so applying every
   * sequence in `text.slice(0, ends[i])` to a `createSgrState()` gives the
   * styling row `i + 1` opens with.
   *
   * What follows an end wraps as the rest of this wrap when it is wrapped from the
   * styling that was in effect, with `continued: true` -- unless the end is past a
   * newline (`text[ends[i] - 1] === '\n'`). That is a paragraph of its own, whose
   * leading blanks are indentation, so it is wrapped with `continued` off, which is
   * exact when there is no `hangingIndent` (apart from a line that is nothing but
   * blanks while a style is open, which comes out as the style and not as an empty
   * row). With a `hangingIndent` neither is exact -- `continued` loses the
   * indentation and the other takes the first line's room and indent -- so wrap
   * the whole text, or cut inside a paragraph.
   */
  ends: number[];
  /** The rows, exactly as `wrap()` joins them: `rows.join('\n') === wrap(text, opts)`. */
  rows: string[];
}

/**
 * Wraps text like `wrap()` and says where in the text each row stopped.
 *
 * The same walk with its offsets kept rather than thrown away, so there is one
 * wrapper and the answer to "where did that row end" cannot disagree with where
 * it was broken. What it is for is text that arrives in pieces: a row that is not
 * the last can no longer change, so everything before its `end` can be dropped
 * and the rest wrapped on its own, in a time that does not grow with how much has
 * come before.
 *
 * Only `text.slice(ends[i])` wrapped afresh agrees with the rest of this wrap
 * when the blanks dropped at a break carried nothing but styling. A sequence
 * `wrap()` cannot reopen -- an OSC 8 hyperlink -- travels with the word after the
 * break, and resuming at the word leaves it behind. Nor can a row be started at a sequence
 * that follows a cluster wider than the room (`日` where one column is all there
 * is): the sequences are written on the row after it, in the word, and a text
 * that starts with them reads them as indentation.
 *
 * @param text - The text to wrap.
 * @param opts - The width to wrap at, or the options.
 * @returns The rows and the offset each one ends at.
 */
export function wrapRows(text: string, opts: WrapOptions | number = {}): WrappedRows {
  const ends: number[] = [];
  const rows = layout(text, opts, ends);

  return { ends, rows };
}

/**
 * The rows `wrap()` joins, optionally with where each one ended.
 *
 * @param text - The text to wrap.
 * @param opts - The width to wrap at, or the options.
 * @param ends - Where to record each row's end, when a caller wants them.
 * @returns The rows, indentation included.
 */
function layout(text: string, opts: WrapOptions | number, ends?: number[]): string[] {
  const settings = typeof opts === 'number' ? { width: opts } : opts;
  const { continued = false, hard = true, hangingIndent = 0, indent = 0 } = settings;

  const first = prefix(indent);
  const rest = first + prefix(hangingIndent);
  const limit = settings.width ?? terminalWidth();

  // `NaN` fails every comparison below, so it walked straight through: the room
  // came out as `NaN`, no word ever fit beside another, and none was ever too
  // long to break -- one word a line, at no width at all. A width that is not a
  // number is not a width, and nor is one that holds nothing, so both are
  // answered the way `truncate()` answers them
  if (!(limit > 0)) {
    ends?.push(text.length);
    return [''];
  }

  // an indent as wide as the width leaves nowhere to put the text, and one
  // column is the least that can hold anything
  const firstRoom = Math.max(limit - stringWidth(first), 1);
  const restRoom = Math.max(limit - stringWidth(rest), 1);

  // the styling carries across the newlines already in the text, so one state
  // walks the whole thing rather than one per line
  const state = createSgrState();
  const lines: string[] = [];

  // the lines are what `split(/\r?\n/)` would give, found by hand so that each
  // one's offset is known: a `\r` is half of a line break only in front of `\n`
  for (let base = 0; ;) {
    // only the first of them is where the text was cut, and it is where the room
    // and the indentation of a row after the first apply
    const resumed = continued && lines.length === 0;
    const newline = text.indexOf('\n', base);
    const stop = newline === -1 ? text.length : newline;
    const lineEnd = newline !== -1 && stop > base && text[stop - 1] === '\r' ? stop - 1 : stop;

    wrapLine(
      tokenize(text.slice(base, lineEnd)),
      lines.length === 0 && !continued ? firstRoom : restRoom,
      restRoom,
      hard,
      state,
      lines,
      ends && { base, ends, next: newline === -1 ? text.length : newline + 1 },
      !resumed
    );

    if (newline === -1) {
      break;
    }
    base = newline + 1;
  }

  return lines.map((line, index) =>
    line === '' ? '' : (index === 0 && !continued ? first : rest) + line
  );
}

/**
 * Wraps one line of the input into one or more output lines.
 *
 * A sequence takes effect on the state when it is committed to a line rather
 * than when it is read, which is what keeps a break honest. Reading ahead and
 * applying as it went would mean closing a line with the styling from further
 * along it: a word carrying `ESC[39m` would have turned the foreground off
 * before the line that still has it open got to close it.
 *
 * @param tokens - The line's tokens.
 * @param first - The room on the first output line.
 * @param rest - The room on the lines after it.
 * @param hard - Whether to break a word too long for a line.
 * @param state - The styling in effect, carried in and out.
 * @param lines - The output lines to append to.
 * @param marks - Where the line sits in the text and where to record each row's
 *   end, for a caller that wants them: `base` is the offset of its first
 *   character, `next` the offset where the line after it begins, and `ends`
 *   the list to append to.
 * @param atStart - Whether the line starts a paragraph, so that its leading
 *   blanks are indentation.
 */
function wrapLine(
  tokens: Token[],
  first: number,
  rest: number,
  hard: boolean,
  state: SgrState,
  lines: string[],
  marks: { base: number; ends: number[]; next: number } | undefined,
  atStart: boolean
): void {
  let room = first;
  let used = 0;
  let content = '';
  // whether the output line being built is also the start of the input line.
  // Leading spaces there are the text's own indentation and are kept; the same
  // spaces after a break are what the break left behind, and are dropped.
  let atLineStart = atStart;
  // captured when the line takes its first token, because that is when the
  // styling it has to reopen is known. A line with no content opens nothing and
  // closes nothing.
  let opened = '';
  let started = false;

  // read but not committed: the spaces between two words, and any sequences
  // among them. A break here drops the spaces; an SGR sequence is dropped from
  // the output too, because opening the next line from the state is what puts
  // it back. Anything else travels with the word -- see `dropPending()`.
  let pending: Token[] = [];
  let pendingWidth = 0;

  // the word being read. Sequences inside it travel with it, so a word that
  // moves to the next line takes its own styling along.
  let word: Token[] = [];
  let wordWidth = 0;
  // the offset of the token being read, and of the word's first cluster: where
  // the next row starts when the word moves down, and the base of the walk
  // through it when it is broken
  let at = marks?.base ?? 0;
  let wordAt = at;

  /** Writes tokens to the current line, and lets their styling take effect. */
  const emit = (list: Token[]) => {
    for (const token of list) {
      if (!started) {
        opened = state.open();
        started = true;
      }
      content += token.text;
      used += token.width;
      if (token.type === 'sequence') {
        state.apply(token.text);
      }
    }
  };

  /**
   * Ends the current line, closing whatever it left open.
   *
   * @param next - The offset where the line after it begins.
   */
  const endLine = (next: number) => {
    marks?.ends.push(next);
    lines.push(started ? opened + content + state.close() : '');
    content = '';
    opened = '';
    started = false;
    used = 0;
    room = rest;
    atLineStart = false;
  };

  /**
   * Throws away the pending run, keeping the effect of the sequences in it: the
   * text they styled is not being written here, but they still happened.
   *
   * A sequence the state does not model is handed back instead of dropped.
   * Nothing puts one back the way `open()` puts an attribute back -- a
   * hyperlink passes through untouched, and untouched only happens when it is
   * written out -- so deleting it deletes what it said: an OSC 8 open in the gap
   * before a word that wrapped took the link away, and the close after one left
   * every later line, and anything concatenated onto the result, inside the
   * hyperlink.
   *
   * @returns The sequences that have to be written on the next line.
   */
  const dropPending = (): Token[] => {
    const carried: Token[] = [];

    for (const token of pending) {
      if (token.type !== 'sequence') {
        continue;
      }
      if (isSgr(token.text)) {
        state.apply(token.text);
      } else {
        carried.push(token);
      }
    }

    pending = [];
    pendingWidth = 0;
    return carried;
  };

  /** Writes a word too long for one line, breaking between clusters. */
  const emitBroken = () => {
    let here = wordAt;

    for (const token of word) {
      if (used > 0 && used + token.width > room) {
        endLine(here);
      }
      emit([token]);
      here += token.text.length;
    }
  };

  /** The columns the word's first cluster takes, which is the least of it a line can hold. */
  const firstWidth = (): number => word.find((token) => token.type === 'cluster')?.width ?? 0;

  const placeWord = () => {
    if (word.length === 0) {
      return;
    }

    if (used + pendingWidth + wordWidth <= room) {
      emit(pending);
      emit(word);
    } else if (used > 0) {
      // there is something to break away from, so the word moves down whole.
      // What the gap carried that the state cannot reopen goes down with it,
      // in front of the word it applies to
      endLine(wordAt);
      emit(dropPending());
      if (hard && wordWidth > room) {
        emitBroken();
      } else {
        emit(word);
      }
    } else if (atLineStart && hard && pendingWidth > 0 && pendingWidth + firstWidth() <= room) {
      // the spaces in front of the first word of the input line are the text's
      // own indentation, so they are kept even though the word does not fit
      // beside them -- as long as some of it does. Indentation that leaves no
      // room for the word's first cluster is dropped instead, by the branch
      // below: written out, it was a line of nothing but spaces, wider than the
      // width and ended at once by the break that followed it. A word that may
      // not be broken is the unit that has to fit, and the branch above has
      // already found that it does not
      emit(pending);
      pending = [];
      pendingWidth = 0;
      if (hard && used + wordWidth > room) {
        emitBroken();
      } else {
        emit(word);
      }
    } else {
      // already at the start of a line, or at the start of one whose own
      // indentation left no room: no break will help, so the word is either
      // split or allowed to run over. Dropping the indentation keeps the
      // effect of any styling among it, as a break does
      emit(dropPending());
      if (hard && wordWidth > room) {
        emitBroken();
      } else {
        emit(word);
      }
    }

    pending = [];
    pendingWidth = 0;
    word = [];
    wordWidth = 0;
  };

  for (const token of tokens) {
    const here = at;
    at += token.text.length;

    if (token.type === 'sequence') {
      if (word.length === 0) {
        pending.push(token);
      } else {
        word.push(token);
      }
      continue;
    }

    if (isBreakSpace(token.text)) {
      placeWord();
      // a tab counts as one space and is written as one, so that what was
      // measured is what comes out
      pending.push({ text: ' ', type: 'cluster', width: 1 });
      pendingWidth += 1;
      continue;
    }

    if (word.length === 0) {
      wordAt = here;
    }
    word.push(token);
    wordWidth += token.width;
  }

  placeWord();

  // the sequences that came after the last word. They are written as they were
  // and they are not closed: they are how the text ends, and closing them would
  // be inventing something the text never said. Dropping them would be worse --
  // a caller joining wrapped pieces would lose the styling the next piece was
  // meant to inherit.
  const trailing = pending
    .filter((token) => token.type === 'sequence')
    .map((token) => token.text)
    .join('');

  // read before the trailing sequences take effect, because they are written
  // after it: the close is only for what they do not turn off themselves, and a
  // text ending in its own close does not need a second one
  const closing = state.close();
  dropPending();

  marks?.ends.push(marks.next);
  lines.push(
    started || trailing !== '' ? opened + content + (state.active ? closing : '') + trailing : ''
  );
}

/**
 * Reads an indent, which may be a count of spaces or the string to use.
 *
 * @param indent - The count or the string.
 * @returns The prefix.
 */
function prefix(indent: number | string): string {
  return typeof indent === 'number' ? ' '.repeat(Math.max(indent, 0)) : indent;
}

/**
 * Where the ellipsis goes when a line does not fit.
 *
 * The same four `text-overflow` accepts, because this is what honours it: one
 * reader of the property and one implementation of what cutting a line means.
 */
export type TruncateMode = 'clip' | 'ellipsis' | 'ellipsis-start' | 'ellipsis-middle';

/** The character a cut line is marked with. One column, and drawn everywhere. */
export const ELLIPSIS = '…';

/**
 * Cuts text down to a width, in columns, marking where it was cut.
 *
 * By grapheme cluster rather than by character: slicing in the middle of a
 * surrogate pair leaves half a code point, and slicing before a combining mark
 * leaves the mark to attach itself to whatever follows. A cluster that would
 * straddle the edge is dropped rather than half drawn, so the result is never
 * *wider* than asked for -- it may be one column narrower, which is what a wide
 * character costs.
 *
 * `clip` cuts and marks nothing, which is the CSS default and what a caller
 * wants when the edge itself says there is more. The other three keep one column
 * back for the ellipsis, so a width of one is the ellipsis alone.
 *
 * @param text - The text.
 * @param width - The most columns it may take.
 * @param mode - Where the mark goes. `ellipsis` by default.
 * @returns The text, no wider than `width`.
 */
export function truncate(text: string, width: number, mode: TruncateMode = 'ellipsis'): string {
  // `NaN` fails every comparison below, so it walked straight through and handed
  // back the whole string with an ellipsis on the end -- wider than any width
  // and marked as cut. A width that is not a number is not a width
  if (!(width > 0)) {
    return '';
  }
  if (stringWidth(text) <= width) {
    return text;
  }

  const { head, marker, tail } = cutAt(width, mode);

  return cut(tokenize(text), head, marker, tail);
}

/**
 * How the columns of a line too wide for its box are divided.
 *
 * The head keeps the first `head` columns and the tail the last `tail`, with
 * `marker` between them -- so `head + stringWidth(marker) + tail` is the whole
 * budget and a `tail` of zero is a cut at the end.
 */
export interface Cut {
  /** Columns kept from the start. */
  head: number;
  /** What marks the cut, or `''` where nothing does. */
  marker: string;
  /** Columns kept from the end. */
  tail: number;
}

/**
 * Where a line too wide for its box is cut, and what marks the cut.
 *
 * The whole of what `text-overflow` *means*, with no text in it -- and it is a
 * function of its own because two things honour that property and neither one's
 * walk is the other's. `truncate()` walks grapheme clusters, because slicing a
 * string in the middle of a surrogate pair leaves half a code point. The decrypt
 * component walks **cells**, because a cell is not a cluster -- `ASCII.wide` hides
 * one two-column character with two narrow glyphs -- so there is no
 * cluster-to-cell correspondence to map an answer about clusters back through.
 *
 * What the two must not disagree about is the arithmetic, and this is the
 * arithmetic: which columns survive and what goes between them. Written once for
 * the reason `readRoutes()` and `isSgr()` are -- two readers of one rule is how
 * the two come to answer differently, and here they would answer differently
 * about where `ellipsis-middle` puts its odd column, which nothing in a build
 * catches.
 *
 * `clip` cuts and marks nothing, which is CSS's default and what a caller wants
 * when the edge itself says there is more. The other three keep one column back
 * for the ellipsis, so a width of one is the ellipsis alone -- and a width that is
 * no width keeps nothing at all, which is what makes this safe to ask before
 * anything has checked.
 *
 * @param width - The most columns the line may take.
 * @param mode - Where the mark goes. `ellipsis` by default.
 * @returns How to divide the budget.
 */
export function cutAt(width: number, mode: TruncateMode = 'ellipsis'): Cut {
  // `NaN` fails every comparison, so it is asked about first rather than falling
  // through to a head of `NaN` columns: the rule `truncate()` already records
  if (!(width > 0)) {
    return { head: 0, marker: '', tail: 0 };
  }
  if (mode === 'clip') {
    return { head: width, marker: '', tail: 0 };
  }
  if (width === 1) {
    return { head: 0, marker: ELLIPSIS, tail: 0 };
  }
  if (mode === 'ellipsis-start') {
    return { head: 0, marker: ELLIPSIS, tail: width - 1 };
  }
  if (mode === 'ellipsis-middle') {
    // the head keeps the odd column, because the beginning of a path or an
    // identifier is what says which one it is
    const tail = Math.floor((width - 1) / 2);
    return { head: width - 1 - tail, marker: ELLIPSIS, tail };
  }

  return { head: width - 1, marker: ELLIPSIS, tail: 0 };
}

/**
 * Lays the kept head, the marker and the kept tail end to end, over tokens.
 *
 * Over tokens rather than clusters because a cut through an escape sequence is
 * not a cut through text: segmenting the raw string made `[`, `3`, `1` and `m`
 * into one-column characters, so the walk that `stringWidth()` had just measured
 * as SGR-aware cut SGR-unaware, and `truncate('\u001b[31mabcdef', 3, 'clip')`
 * handed back `'\u001b[31'` -- an unterminated CSI, which eats whatever is
 * written after it. A sequence occupies no columns, so every one of them is kept,
 * the dropped run's included: the close at the end of a styled or linked run is
 * what stops its state leaking past the cut, and dropping it is the leak `wrap()`
 * records for a hyperlink. The marker goes where the first hidden cluster was,
 * after the sequences in front of it, so it takes the state of the text it stands
 * for -- the rule the decrypt component's `cutRow()` already follows.
 *
 * @param tokens - The text, tokenized.
 * @param head - Columns kept from the start.
 * @param marker - What marks the cut.
 * @param tail - Columns kept from the end.
 * @returns The cut text.
 */
function cut(tokens: Token[], head: number, marker: string, tail: number): string {
  // where the clusters are, so both walks count clusters and step over the
  // sequences between them
  const clusters: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if ((tokens[i] as Token).type === 'cluster') {
      clusters.push(i);
    }
  }

  // a cluster that would straddle either edge is dropped rather than half drawn
  let headEnd = 0;
  for (let used = 0; headEnd < clusters.length; headEnd++) {
    const w = (tokens[clusters[headEnd] as number] as Token).width;
    if (used + w > head) {
      break;
    }
    used += w;
  }

  let tailStart = clusters.length;
  for (let used = 0; tailStart > headEnd; tailStart--) {
    const w = (tokens[clusters[tailStart - 1] as number] as Token).width;
    if (used + w > tail) {
      break;
    }
    used += w;
  }

  // the caller only cuts text wider than its budget, so at least one cluster is
  // hidden and the marker has somewhere to go; the fallback is for a caller that
  // did not check
  const firstHidden = clusters[headEnd] ?? tokens.length;
  const lastHidden = tailStart > headEnd ? (clusters[tailStart - 1] as number) : -1;
  let out = '';

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (i === firstHidden) {
      out += marker;
    }
    if (token.type === 'sequence' || i < firstHidden || i > lastHidden) {
      out += token.text;
    }
  }

  return firstHidden === tokens.length ? out + marker : out;
}
