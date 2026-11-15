/**
 * Wrapping text that is still arriving.
 *
 * `wrap()` takes a string it has all of. A stream of chunks -- an LLM's tokens, a
 * subprocess's output -- has no such string, and the three things that make
 * wrapping more than splitting on spaces each get harder when the end of the
 * text is not there yet:
 *
 * - **A word may not be finished.** `"hel"` and `"lo"` are one word, and wrapping
 *   the first half decides where a line breaks on a word that is about to be
 *   longer. So only text up to the last space is wrapped, and the word after it
 *   is held until something says it is over: a space, a newline, or the end.
 * - **A sequence may not be finished.** `ESC[3` and `1m` are one SGR, and
 *   measuring the first half counts `[`, `3` as columns and breaks a line in the
 *   middle of a colour. A trailing sequence that has not ended is held too.
 * - **Styling carries across a newline and a chunk.** The state is walked over
 *   each finished line, and the next one is opened from it.
 *
 * What is written is text and colour and nothing else. The source is whatever a
 * subprocess or a model produced, and a terminal obeys what it is handed: a bare
 * `\r` returns the cursor and the next frame of a progress bar overwrites the
 * row, `ESC[2J` clears the screen, and an OSC 52 writes to the clipboard -- all
 * while the status line under a spinner is being repainted by cursor arithmetic
 * this module cannot see. So a line is cleaned before it is measured, which is
 * also why the wrapper does not count a progress frame it is about to drop.
 *
 * Nothing here wraps differently from `wrap()`: it *calls* it, and returns the
 * rows that cannot change. Wrap is greedy, so every row but the last of a wrap is
 * final however much text follows it -- which is the one fact the incremental
 * version rests on, and the reason it is a thin layer over `wrap()` rather than a
 * second wrapper whose idea of a break could drift from the first's. What keeps a
 * long line cheap is that a row handed out is also *cut off*: `wrapRows()` says
 * where each row ended, so what is wrapped next is the row still being built and
 * what has arrived since, with the styling the cut-off rows left in effect carried
 * across. A line costs what its length costs, once, and not once per chunk.
 */

import { matcher, strip } from '../ansi/strip.js';
import {
  createSgrState,
  isBreakSpace,
  isSgr,
  type Token,
  tokenize,
  wrapRows,
} from '../wrap/index.js';

export interface StreamWrapper {
  /**
   * Finishes the stream: whatever was held back is wrapped and returned.
   *
   * @returns The remaining lines.
   */
  end(): string[];
  /**
   * Takes the next chunk.
   *
   * @param chunk - Text, cut anywhere: between words, inside one, inside a
   *   sequence.
   * @returns The lines that are now final, in order. Often none.
   */
  push(chunk: string): string[];
}

const ESC = String.fromCharCode(0x1b);

// What a sequence that has not ended looks like, and what can be added to it
// without ending it. A string sequence (an OSC, a DCS) runs to the end of the
// text until a terminator or something that cancels it arrives, and a CSI takes
// parameter bytes and then intermediate bytes, in that order, until a final byte.
// Built from the characters rather than written as literals, so that no control
// character is in the source and nothing needs a lint suppression to stay there
const STRING_STOPS = '\u0007\u0018\u001a\u001b\u009c';
const CSI = `(?:${ESC}\\[|\u009b)`;
const OPEN_STRING = new RegExp(
  `^(?:${ESC}[\\]P^_X]|[\u009d\u0090\u0098\u009e\u009f])[^${STRING_STOPS}]*$`
);
const ENDS_STRING = new RegExp(`[${STRING_STOPS}]`);
const OPEN_PARAMS = new RegExp(`^${CSI}[0-?]*$`);
const OPEN_INTERMEDIATES = new RegExp(`^${CSI}[0-?]*[ -/]+$`);
const PARAMS = /^[0-?]*$/;
const INTERMEDIATES = /^[ -/]*$/;

/**
 * How much of the end of `text` is a sequence that has not finished.
 *
 * Only the last `ESC` can be unfinished, since a sequence ends before the next
 * one begins; and it is unfinished exactly when the sequence matcher cannot make
 * a match of it.
 *
 * @param text - The text.
 * @returns Where the unfinished sequence starts, or the length of the text.
 */
function incompleteAt(text: string): number {
  const at = text.lastIndexOf(ESC);

  if (at === -1) {
    return text.length;
  }

  const sticky = new RegExp(matcher().source, 'y');
  sticky.lastIndex = at;
  return sticky.test(text) ? text.length : at;
}

/**
 * Whether a token is a blank that is text.
 *
 * A space inside a sequence is part of it -- a window title is `ESC]0;build step
 * one BEL` -- and a break there cuts the sequence in half, so what is wrapped
 * and written is its leftover bytes. A sequence is one token, which is how the
 * wrapper itself tells it from the text around it.
 *
 * @param token - The token.
 * @returns Whether a line may break here.
 */
function isBlank(token: Token): boolean {
  return token.type === 'cluster' && isBreakSpace(token.text);
}

/**
 * One token reduced to text and SGR.
 *
 * @param token - The token, from a line that is whole as far as the caller can
 *   tell.
 * @returns The token if it is an SGR, nothing if it is any other sequence, and
 *   the text with every control character but a tab taken out if it is a cluster.
 */
function cleanToken(token: Token): string {
  return token.type === 'sequence'
    ? isSgr(token.text)
      ? token.text
      : ''
    : token.text.replaceAll(/\p{Cc}/gu, (c) => (c === '\t' ? c : ''));
}

/**
 * A line of source reduced to text and SGR.
 *
 * Done on a line that is whole as far as this call can tell -- never on a chunk,
 * which may end inside a sequence -- so every sequence in it is complete and one
 * that is not (a stream that ended mid-escape) is just a stray `ESC`, which is a
 * control character and goes with the rest. A tab is the one control character
 * that is layout rather than a command.
 *
 * @param text - The text, with no newline in it.
 * @returns The text with every sequence but an SGR removed, and every control
 *   character but a tab.
 */
function clean(text: string): string {
  let out = '';

  for (const token of tokenize(text)) {
    out += cleanToken(token);
  }

  return out;
}

/**
 * Whether a wrapped text can be started again at an offset.
 *
 * A row that breaks inside a word, in front of the sequences that follow it,
 * leaves them to be written on the row after -- inline, in the word they were in.
 * A text that starts with them has them as indentation instead, which `wrap()`
 * opens the row from and does not write, so the rows are the same and their
 * bytes are not. It takes a cluster wider than the room to put a row there, which
 * is a width of one over `日`.
 *
 * @param text - The wrapped text.
 * @param at - The offset.
 * @returns Whether the text from `at` wraps as it would have wrapped in place.
 */
function resumable(text: string, at: number): boolean {
  const first = text.charCodeAt(at);
  return first !== 0x1b && first !== 0x9b;
}

/**
 * A wrapper for chunks.
 *
 * @param width - The column to wrap at, or `Infinity` for no wrapping, in which
 *   case a line ends where the text says it does.
 * @returns The wrapper.
 */
export function createStreamWrapper(width: number): StreamWrapper {
  // the styling in effect where `head` starts: every row handed out is walked
  // over it, so that a colour opened on one row is open on the next
  const state = createSgrState();
  // The line being built is everything after the last newline, and it is kept in
  // three parts so that a chunk costs what the chunk and the row being built
  // cost, not what the line has come to:
  //
  // `head` and `tail` are the *cleaned* text of the tokens already read, from the
  // first one that has not been handed out as part of a row. `head` runs to the
  // last blank, which is as far as anything is wrapped, and `tail` is the word
  // after it, which may still be growing. A row handed out is cut off the front.
  let head = '';
  let tail = '';
  // the source from the last token read on: a chunk can extend that token (a
  // combining mark after a blank is not a blank) or complete a sequence, so it is
  // read again with whatever follows it, and what is before it is final
  let raw = '';
  // the text that was wrapped last time, so that a chunk that settles nothing
  // new wraps nothing. Compared whole and not by length: the text is not only
  // appended to, since a run of blanks keeps its last blank and a sequence that is
  // not finished takes its end back
  let wrapped = '';
  // how many rows of the text being built have been handed out and are still in
  // it, because there was nowhere to cut them off
  let given = 0;
  // whether anything has been cut off the front of this line, which makes what is
  // left the rest of a wrap rather than a text of its own, and whether all of it
  // was blank, which `end()` asks of the whole line
  let cut = false;
  let blankCut = true;
  // The settled text is `head` less the end of a sequence that is only a sequence
  // when the text ends there. `ESC[3 ` followed by a character a CSI cannot
  // contain is the bare `ESC[` and the text `3 `, and its blank is a place to
  // break -- but the text up to that blank, cleaned on its own, ends in the
  // unfinished sequence and loses it, as it always has. How far into a CSI the
  // tokens are, and how many characters of it, as of the token being read and as
  // of the last blank:
  let csi: 0 | 1 | 2 = 0;
  let csiLength = 0;
  let lostAtBlank = 0;
  // How many blanks end `head`, and how many of them are kept: the first `width`
  // and the last. A run of blanks is pending until a word follows, and when it is
  // wider than the room the word moves down and the run is dropped whatever its
  // length, so past that only the last one can matter -- it is the one the next
  // character is beside, and a mark after it joins it into a cluster that is not a
  // blank. Without this a line of blanks is wrapped from its first by each chunk of
  // them, and so is anything that cleans down to one: cursor and erase sequences
  // between spaces. A blank and a colour alternating are not a run of blanks, and
  // are still wrapped each time
  let blanks = 0;
  const room = Math.max(1, Math.ceil(width)) + 1;
  // what the line's raw source is, when it is one sequence that has not ended: a
  // chunk that cannot end it changes nothing, so is not read
  let unfinished: 'string' | 'params' | 'intermediates' | undefined;

  /** The wrapped rows of the text, opened from the styling carried in. */
  const lines = (open: string, text: string) => wrapRows(open + text, { continued: cut, width });

  /**
   * Reads one token's part in a CSI that has not ended: the bare opener, then
   * parameters, then intermediates.
   *
   * @returns How many characters, counting the blank, the text up to this blank
   *   loses to the sequence it would be the end of, or `0`.
   */
  const watch = (token: Token): number => {
    // `ESC[` is a sequence of its own when the CSI after it does not hold, and
    // the single-byte introducer is a control character on its own
    if (token.text === '\u001b[' || token.text === '\u009b') {
      csi = 1;
      csiLength = 0;
      return 0;
    }

    if (token.type === 'sequence') {
      csi = 0;
      csiLength = 0;
      return 0;
    }

    const code = token.text.length === 1 ? token.text.charCodeAt(0) : 0;

    if (csi === 1 && code >= 0x30 && code <= 0x3f) {
      csiLength++;
    } else if (csi !== 0 && code >= 0x20 && code <= 0x2f) {
      csi = 2;
      csiLength++;
    } else {
      csi = 0;
      csiLength = 0;
    }

    return csi !== 0 && code === 0x20 ? csiLength : 0;
  };

  /**
   * Drops the first `at` characters of the text just wrapped: rows that are final
   * and have been handed out. Their styling carries on in `state`, which is
   * what the row after them is opened from.
   */
  const advance = (text: string, at: number): void => {
    const gone = text.slice(0, at);

    for (const token of tokenize(gone)) {
      if (token.type === 'sequence') {
        state.apply(token.text);
      }
    }

    blankCut &&= strip(gone).trim() === '';

    if (at <= head.length) {
      head = head.slice(at);
    } else {
      tail = tail.slice(at - head.length);
      head = '';
    }
    blanks = Math.min(blanks, head.length);
    wrapped = text.slice(at);
    cut = true;
  };

  /** Ends the line being built: styling carries on, and the line starts over. */
  const finish = (rest: string): string[] => {
    const text = head + tail + clean(rest);
    const { rows } = lines(state.open(), text);
    const out = rows.slice(given);

    for (const token of tokenize(text)) {
      if (token.type === 'sequence') {
        state.apply(token.text);
      }
    }

    head = '';
    tail = '';
    raw = '';
    unfinished = undefined;
    blanks = 0;
    wrapped = '';
    given = 0;
    cut = false;
    blankCut = true;
    csi = 0;
    csiLength = 0;
    lostAtBlank = 0;
    return out;
  };

  /**
   * Reads what has arrived of the line and wraps what is settled.
   *
   * Only text up to the last blank is wrapped, and only after the unfinished
   * sequence at its end is left out: what follows a blank is a word that may
   * still be growing. Wrap is greedy, so every row but the last is final however
   * much text follows -- and that is the one fact this rests on. The last row is
   * the only one that can change, so it is where the next call starts: the rows
   * before it are cut off and the rest is wrapped as a text of its own, which is
   * what keeps a long line from being wrapped again from its start by every
   * chunk.
   */
  const read = (chunk: string): string[] => {
    // an unfinished sequence, and nothing in the chunk that ends it or changes
    // what it is: it is still the one token it was, to the end of the text. Read
    // again, an unterminated OSC 52 of a megabyte in small chunks is a megabyte
    // tokenized per chunk
    if (
      (unfinished === 'string' && !ENDS_STRING.test(chunk)) ||
      (unfinished === 'params' && PARAMS.test(chunk)) ||
      (unfinished === 'intermediates' && INTERMEDIATES.test(chunk))
    ) {
      return [];
    }

    const whole = raw.slice(0, incompleteAt(raw));

    if (whole === '') {
      return [];
    }

    const tokens = tokenize(whole);
    const last = tokens[tokens.length - 1] as Token;

    for (const token of tokens.slice(0, -1)) {
      const lost = watch(token);

      if (isBlank(token)) {
        const blank = cleanToken(token);

        if (tail === '' && csi === 0 && blanks >= room) {
          // the run is as long as it needs to be, so this one takes the place of
          // the last. Not inside a CSI that may yet fail, whose blanks are counted
          head = head.slice(0, -1) + blank;
        } else {
          head += tail + blank;
          blanks = tail === '' ? blanks + 1 : 1;
        }
        tail = '';
        lostAtBlank = lost;
      } else {
        tail += cleanToken(token);
      }
    }

    raw = raw.slice(whole.length - last.text.length);
    unfinished = undefined;

    if (last.type === 'sequence' && raw === last.text) {
      if (OPEN_STRING.test(raw)) {
        unfinished = 'string';
      } else if (OPEN_PARAMS.test(raw)) {
        unfinished = 'params';
      } else if (OPEN_INTERMEDIATES.test(raw)) {
        unfinished = 'intermediates';
      }
    }

    // the token being read is a blank as far as anybody can tell, so it is a
    // place to break unless the next chunk says it is not. It is read again with
    // the next chunk, so what it does to the sequence it may be in is undone
    const [before, beforeLength] = [csi, csiLength];
    const lost = watch(last);
    let text = head;
    let lostAtEnd = lostAtBlank;

    if (isBlank(last)) {
      text = head + tail + cleanToken(last);
      lostAtEnd = lost;
    }
    [csi, csiLength] = [before, beforeLength];

    text = text.slice(0, text.length - lostAtEnd);

    if (text === '' || text === wrapped) {
      return [];
    }

    wrapped = text;
    const open = state.open();
    const { ends, rows } = lines(open, text);

    // the last row may yet take another word, so it is not final
    const final = rows.length - 1;
    const out = rows.slice(given, final);
    given = Math.max(given, final);

    // everything before it is cut off, back to the last place the rest can be
    // wrapped from. It starts where the row before it ended, less the styling put
    // in front of the text
    let row = final - 1;
    while (row >= 0 && !resumable(text, (ends[row] as number) - open.length)) {
      row--;
    }

    if (row >= 0) {
      advance(text, (ends[row] as number) - open.length);
      given = final - row - 1;
    }

    return out;
  };

  return {
    end() {
      // text that is only whitespace, or only sequences, is not a line: a stream
      // that ends on its newline has nothing after it, and a final reset is not
      // a blank row
      if (blankCut && strip(head + tail + clean(raw)).trim() === '') {
        return [];
      }
      return finish(raw);
    },

    push(chunk) {
      const out: string[] = [];
      const from = raw.length;
      raw += chunk;

      // what is held has no newline in it, so one is in the chunk -- and a line
      // that has not ended is not searched, which for a width of `Infinity` is
      // all of it
      if (chunk.includes('\n')) {
        for (let newline = raw.indexOf('\n', from); newline !== -1; newline = raw.indexOf('\n')) {
          const rest = raw.slice(newline + 1);
          const line = raw.slice(0, newline);

          // a carriage return is half of a CRLF and not a column of the line --
          // and what kept an unfinished CSI from ending at the end of it, so the
          // sequence it was in is now whole and has no text in it after all
          if (line === '\r' && csi !== 0) {
            const text = head + tail;
            head = text.slice(0, text.length - csiLength);
            tail = '';
          }

          out.push(...finish(line.replace(/\r$/, '')));
          raw = rest;
        }
      }

      if (width !== Infinity) {
        out.push(...read(chunk));
      }

      return out;
    },
  };
}
