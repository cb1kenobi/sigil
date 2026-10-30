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
 * Nothing here wraps differently from `wrap()`: it *calls* it, over the whole of
 * the line being built each time, and returns the lines that cannot change. Wrap
 * is greedy, so every line but the last of a wrap is final however much text
 * follows it -- which is the one fact the incremental version rests on, and the
 * reason it is a thin layer over `wrap()` rather than a second wrapper whose idea
 * of a break could drift from the first's. The cost is that a very long line is
 * re-wrapped once per chunk; a paragraph is hundreds of characters, and a line
 * ends at a newline.
 */

import { matcher, strip } from '../ansi/strip.js';
import { createSgrState, isSgr, tokenize, wrap } from '../wrap/index.js';

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
    out +=
      token.type === 'sequence'
        ? isSgr(token.text)
          ? token.text
          : ''
        : token.text.replaceAll(/\p{Cc}/gu, (c) => (c === '\t' ? c : ''));
  }

  return out;
}

/**
 * A wrapper for chunks.
 *
 * @param width - The column to wrap at, or `Infinity` for no wrapping, in which
 *   case a line ends where the text says it does.
 * @returns The wrapper.
 */
export function createStreamWrapper(width: number): StreamWrapper {
  // the styling in effect where `line` starts: every finished line is walked
  // over it, so that a colour opened on one line is open on the next
  const state = createSgrState();
  // the source of the line being built, which is everything after the last
  // newline, held back or not
  let line = '';
  // how many of its wrapped lines have been handed out
  let given = 0;

  /** The wrapped lines of the text, opened from the styling carried in. */
  const lines = (text: string): string[] => wrap(state.open() + clean(text), { width }).split('\n');

  /** Ends the line being built: styling carries on, and the count starts over. */
  const finish = (): string[] => {
    const wrapped = lines(line);
    const out = wrapped.slice(given);

    for (const token of tokenize(clean(line))) {
      if (token.type === 'sequence') {
        state.apply(token.text);
      }
    }

    line = '';
    given = 0;
    return out;
  };

  return {
    end() {
      // text that is only whitespace, or only sequences, is not a line: a stream
      // that ends on its newline has nothing after it, and a final reset is not
      // a blank row
      if (strip(clean(line)).trim() === '') {
        return [];
      }
      return finish();
    },

    push(chunk) {
      const out: string[] = [];
      line += chunk;

      for (let newline = line.indexOf('\n'); newline !== -1; newline = line.indexOf('\n')) {
        const rest = line.slice(newline + 1);
        // a carriage return is half of a CRLF and not a column of the line
        line = line.slice(0, newline).replace(/\r$/, '');
        out.push(...finish());
        line = rest;
      }

      if (width === Infinity) {
        return out;
      }

      // wrap only what is settled: up to the last space before an unfinished
      // sequence. What follows is a word that may still be growing
      const whole = line.slice(0, incompleteAt(line));
      const settled = Math.max(whole.lastIndexOf(' '), whole.lastIndexOf('\t')) + 1;

      if (settled > 0) {
        const wrapped = lines(line.slice(0, settled));
        // the last line may yet take another word, so it is not final
        out.push(...wrapped.slice(given, wrapped.length - 1));
        given = Math.max(given, wrapped.length - 1);
      }

      return out;
    },
  };
}
