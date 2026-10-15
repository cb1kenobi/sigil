import { ESC } from '../ansi/codes.js';
import { cellWidth } from '../canvas/buffer.js';
import { graphemes } from '../width/index.js';
import { cells as wholeCells } from './numbers.js';

/**
 * A terminal screen: scrollback, a viewport, a cursor, and enough of a parser to
 * move one around the other.
 *
 * `test/canvas/fake-terminal.ts` has a model of its own and this is deliberately
 * not it. That one is canvas-relative -- every `apply()` starts from the canvas
 * origin, because that is the only thing the diff's output claims to know about.
 * A backend's whole job is the part that model assumes away: where the canvas
 * sits on a screen whose log is scrolling underneath it. So this one has rows
 * that scroll off the top, a cursor that survives between frames, and an
 * alternate buffer to switch to.
 *
 * Asserting on the bytes a backend emits would pin one implementation of the
 * cursor arithmetic. Replaying them against this pins the claim: after these
 * frames, this is what the user is looking at.
 *
 * ## It reads grapheme clusters, which it did not used to
 *
 * This was `test/canvas/screen.ts` and advanced **one column per code unit**, so
 * a picture over a row holding a wide cluster was not to be trusted: `日` took
 * one column where a terminal gives it two, an astral cluster was written as two
 * lone surrogates, and a combining mark took a cell of its own. The cost was not
 * theoretical -- it is written down in AGENTS.md as a finding, from a prompt test
 * whose CJK row read `日本語 is ihree` after an arrow key, where the frame had
 * changed a style and nothing else: the model had put a character in its own
 * column 9, which the real row holds the previous one in.
 *
 * So a cluster occupies one cell or two, a wide one leaves a `''` continuation
 * beside it, and overwriting either half takes the other with it -- which is
 * `CellBuffer`'s own rule, for `CellBuffer`'s own reason: without it there is no
 * answer to "what is in column 40" for a row holding one wide character, and
 * every read after it is a column out. `cellWidth()` is the width asked for,
 * rather than `graphemeWidth()`, because the grid and the diff both take two as
 * the most a cluster can occupy -- asking what the cluster *contains* puts the
 * model a column right of where the diff says the cursor is.
 *
 * The one place it parts company with the grid is a wide cluster with a single
 * column left. `CellBuffer` **refuses** it and lets a blank take the column,
 * because a grid is a fixed rectangle an app owns and half a glyph is worse than
 * a gap. A terminal has a next row, and every terminal worth the name wraps the
 * cluster onto it, so that is what this does -- the two models answer different
 * questions and this one is about a screen. On a screen one column wide there is
 * no row it fits on at all, and it is dropped.
 *
 * ## What it still does not model
 *
 * Styling, bar reverse video -- see `lastInverse`. So a claim about *colour* is
 * not one to make against this: read the bytes, which is what `report.test.ts`
 * and the canvas diff's own tests do. It also does not rewrap on a resize, for
 * the reason `resize()` records.
 */

/** What the far half of a wide cluster holds, as in `CellBuffer`. */
const CONTINUATION = '';

/** What a cell holds when nothing has been painted into it. */
const BLANK = ' ';

/**
 * A tail that could still become a sequence, so is worth holding for the next
 * chunk: a bare `ESC`, a CSI with no final byte yet, or an unterminated control
 * string. Anchored, because what is being asked is about the end of a chunk.
 */
const PARTIAL = new RegExp(`^${ESC}(?:\\[[\\d;:?]*|[\\]P][^${ESC}\\u0007]*(?:${ESC})?)?$`);

/** A CSI sequence: the parameters, any private marker, and the final byte. */
const CSI = new RegExp(`^${ESC}\\[(\\??)([\\d;:]*)([A-Za-z])`);

/** SGR and anything else that only changes how text looks, which this ignores. */
const OSC = new RegExp(`^${ESC}\\]([^${ESC}\\u0007]*)(?:${ESC}\\\\|\\u0007)`);

interface Buffer {
  /** Rows that have scrolled off the top. The main buffer's only. */
  scrollback: string[][];
  rows: string[][];
}

export class Screen {
  column = 0;
  /** Whether the cursor is hidden, so a test can assert who put it back. */
  cursorHidden = false;
  row = 0;
  /** Whether the alternate buffer is in front. */
  alternate = false;
  /**
   * Whether the last graphic write filled the final column.
   *
   * A terminal writing the last column of a row does not advance past it -- it
   * arms a wrap instead and stays put, and the next graphic character is what
   * moves down. Any cursor movement disarms it. Modelled because a full-width
   * canvas writes that column on every frame, and a model that walked the
   * cursor off the edge would disagree with the row the backend is tracking.
   */
  wrapPending = false;
  /**
   * What OSC 52 put on each selection, and in the order it arrived.
   *
   * Modelled rather than swallowed with the rest of the control strings, because
   * a clipboard write is the one OSC a test has a reason to assert and because
   * the payload is base64: decoding it here is what makes the model say what the
   * *user* would get rather than what the sequence looked like. A real terminal
   * may refuse the write -- several do by default, and tmux needs
   * `set -g set-clipboard on` -- which is exactly the half only
   * `terminal-probe.mjs --clipboard` can settle, so this models a terminal that
   * honours it.
   */
  clipboard: { selection: string; text: string }[] = [];
  /**
   * The cell of the most recent write made with reverse video in effect.
   *
   * The one piece of styling this model keeps, and it is kept because one thing
   * on screen *is* styling and nothing else: a prompt's caret is reverse video
   * over a cluster, so a model that holds characters alone cannot see it at all
   * -- the cell under the caret holds the same character either way. The
   * alternative is a second cursor tracker written inside a test, which is a
   * second model of the thing this one is for.
   *
   * The *most recent* rather than a list, because what a test asks is where the
   * caret is now: a frame repaints, and the caret is the last thing painted in
   * the one tree that draws one. A plain write to the recorded cell clears it,
   * since a cell cannot be both -- but a frame that draws **no** caret anywhere
   * leaves the last one in place, because this model has no notion of a frame to
   * hang a reset on. A test asking whether a caret went away reads the bytes for
   * `ESC[7m` instead.
   *
   * It is the **lead's** cell for a wide cluster, which is the rule a caret
   * already follows: it marks a cluster, and a cluster is where its lead is.
   */
  lastInverse: { column: number; row: number } | undefined;

  /** Columns. */
  width: number;
  /** Rows in the viewport, which is what scrolls. */
  height: number;

  /** Whether reverse video is in effect, which is what `lastInverse` is recorded on. */
  #inverse = false;

  /** A sequence that was cut off by the end of a chunk, waiting for the rest. */
  #held = '';

  #main: Buffer;
  #alt: Buffer;
  /** Where the cursor was on the main screen when the alternate one was entered. */
  #saved: { column: number; row: number } | undefined;

  constructor(width: number, height: number) {
    // refused rather than clamped, and refused by *asking* rather than by
    // comparing: every comparison against `NaN` is false, so a `Math.max(1, …)`
    // would let one through -- and a screen of `NaN` columns builds no rows,
    // places a cluster into an array that grows under it, and reports a column
    // nothing is at
    this.width = wholeCells(width, 'A screen width');
    this.height = wholeCells(height, 'A screen height');
    this.#main = { rows: this.#blank(), scrollback: [] };
    this.#alt = { rows: this.#blank(), scrollback: [] };
  }

  #blank(): string[][] {
    return Array.from({ length: this.height }, () =>
      Array.from({ length: this.width }, () => BLANK)
    );
  }

  get #buffer(): Buffer {
    return this.alternate ? this.#alt : this.#main;
  }

  /** The viewport, trailing spaces trimmed, as a test wants to read it. */
  get viewport(): string[] {
    return this.#buffer.rows.map((row) => row.join('').replace(/\s+$/, ''));
  }

  /** Everything the main buffer has held: what scrolled off, then the viewport. */
  get log(): string[] {
    const buffer = this.#main;
    return [...buffer.scrollback, ...buffer.rows].map((row) => row.join('').replace(/\s+$/, ''));
  }

  /** The log with the blank rows below the last written one dropped. */
  get written(): string[] {
    const lines = this.log;
    while (lines.length > 0 && lines.at(-1) === '') {
      lines.pop();
    }
    return lines;
  }

  /**
   * What one cell holds, which is the only way to ask about a wide cluster.
   *
   * A row read as a string says what the user sees and cannot say which column a
   * cluster starts in -- so the claim "this cluster took two columns" is a claim
   * about a lead and the empty string beside it, and that is what this answers.
   * `''` is the far half of a wide cluster, as in `CellBuffer`.
   *
   * @param column - The column.
   * @param row - The row, counted from the top of the viewport.
   * @returns The cluster, or `undefined` off the screen.
   */
  cellAt(column: number, row: number): string | undefined {
    return this.#buffer.rows[row]?.[column];
  }

  #scroll(): void {
    const buffer = this.#buffer;
    const top = buffer.rows.shift();
    // only the main buffer keeps what scrolls off it; the alternate one has no
    // scrollback, which is the whole reason a full-screen app uses it
    if (top && !this.alternate) {
      buffer.scrollback.push(top);
    }
    buffer.rows.push(Array.from({ length: this.width }, () => BLANK));

    // the rows moved, so the recorded caret's row did too -- and the one that
    // went off the top is on no row at all. Without this it named a fresh blank
    // row one scroll later. Found by review
    if (this.lastInverse) {
      this.lastInverse =
        this.lastInverse.row === 0
          ? undefined
          : { column: this.lastInverse.column, row: this.lastInverse.row - 1 };
    }
  }

  #down(): void {
    if (this.row === this.height - 1) {
      this.#scroll();
    } else {
      this.row++;
    }
  }

  /**
   * Blanks one cell, taking the other half of whatever was there with it.
   *
   * Half a glyph is not a state a screen can be in: overwriting either cell of a
   * wide cluster destroys the cluster, so the cell that is left has to go too or
   * every read of the row after it is a column out. `CellBuffer.#breakCluster()`
   * is the same rule one layer down, and is where the argument for it is.
   *
   * @param row - The row to repair.
   * @param at - The column about to be written.
   * @returns The column it blanked, or `-1` where there was nothing to repair.
   */
  #repair(row: string[], at: number): number {
    if (row[at] === CONTINUATION && at > 0) {
      row[at - 1] = BLANK;
      return at - 1;
    }
    if (cellWidth(row[at] ?? BLANK) === 2 && at + 1 < row.length) {
      row[at + 1] = BLANK;
      return at + 1;
    }
    return -1;
  }

  /** Puts a cluster at the cursor, repairing whatever it lands on. */
  #put(cluster: string, cells: number): void {
    const row = this.#buffer.rows[this.row];
    if (!row) {
      return;
    }
    const at = this.column;

    // every cell this write changes, the repaired ones included: a caret
    // recorded on a cluster this is about to destroy has to go with it, and the
    // cell that goes is the *lead's* -- one column left of the continuation
    // being written over, which is a cell the write itself never touches
    const touched = [at];
    for (const column of [this.#repair(row, at), cells === 2 ? this.#repair(row, at + 1) : -1]) {
      if (column >= 0) {
        touched.push(column);
      }
    }
    if (cells === 2) {
      touched.push(at + 1);
    }

    row[at] = cluster;
    if (cells === 2) {
      row[at + 1] = CONTINUATION;
    }

    if (this.#inverse) {
      this.lastInverse = { column: at, row: this.row };
    } else if (this.lastInverse?.row === this.row && touched.includes(this.lastInverse.column)) {
      // a cell cannot be both, and the recorded one has just been painted over
      this.lastInverse = undefined;
    }
  }

  /** Places one cluster and advances the cursor the way a terminal does. */
  #place(cluster: string): void {
    const cells = cellWidth(cluster);

    // a zero-width cluster has no cell of its own: a combining mark belongs to
    // what it modifies, which `graphemes()` has already attached it to, and a
    // control character that reached here is one a terminal would act on rather
    // than print
    if (cells === 0) {
      return;
    }

    if (this.wrapPending) {
      this.column = 0;
      this.#down();
      this.wrapPending = false;
    }

    if (cells === 2 && this.column + 2 > this.width) {
      // a terminal wraps a double-width cluster that will not fit rather than
      // splitting it. On a screen narrower than the cluster there is no row it
      // fits on, so it is dropped -- the one answer that leaves no half glyph
      if (this.width < 2) {
        return;
      }
      this.column = 0;
      this.#down();
    }

    this.#put(cluster, cells);

    this.column += cells;
    if (this.column >= this.width) {
      // nowhere to advance to, so the cursor stays on the last column written
      // and the wrap waits for the next cluster
      this.column = this.width - 1;
      this.wrapPending = true;
    }
  }

  /**
   * Resizes, the way a terminal does when its window changes.
   *
   * Rows are padded or truncated. The viewport **grows** at the bottom and
   * **shrinks from the top**, which is what a terminal does -- so the cursor and
   * the recorded caret are moved up with the content rather than left at an
   * index it moved out from under. The sentence this replaces said it grows or
   * shrinks from the bottom, which was half true and was the half that let the
   * cursor drift. A real terminal rewraps, which is precisely the thing a backend
   * cannot predict and why a resize throws the old frame away rather than
   * diffing against it -- so modelling the rewrap would be modelling something
   * nothing is allowed to rely on.
   *
   * @param width - The new width.
   * @param height - The new height.
   */
  resize(width: number, height: number): void {
    // the constructor's rule, for the same reason: a resize to `NaN` columns is
    // as much a caller error as a screen built at one, and it would leave the
    // rows a length nothing can address
    wholeCells(width, 'A screen width');
    wholeCells(height, 'A screen height');

    /** How many rows the displayed buffer lost off the top. */
    let shifted = 0;

    for (const buffer of [this.#main, this.#alt]) {
      for (const row of buffer.rows) {
        while (row.length > width) {
          row.pop();
        }
        // a truncation can cut a wide cluster's continuation off the end, which
        // leaves its lead claiming a column the row no longer has
        const last = row.at(-1);
        if (last !== undefined && cellWidth(last) === 2) {
          row[row.length - 1] = BLANK;
        }
        while (row.length < width) {
          row.push(BLANK);
        }
      }
      while (buffer.rows.length > height) {
        const top = buffer.rows.shift();
        if (buffer === this.#buffer) {
          shifted++;
        }
        if (top && buffer === this.#main) {
          buffer.scrollback.push(top);
        }
      }
      while (buffer.rows.length < height) {
        buffer.rows.push(Array.from({ length: width }, () => BLANK));
      }
    }

    this.width = width;
    this.height = height;
    // the cursor follows the row it was on rather than staying at an index the
    // content moved out from under, and nothing is left armed: a resize moves
    // the cursor, so a deferred wrap has nowhere to go. Found by review
    this.row = Math.max(0, Math.min(this.row - shifted, height - 1));
    this.column = Math.min(this.column, width - 1);
    this.wrapPending = false;
    if (this.lastInverse && (this.lastInverse.row >= height || this.lastInverse.column >= width)) {
      this.lastInverse = undefined;
    } else if (this.lastInverse) {
      this.lastInverse = {
        column: this.lastInverse.column,
        row: Math.max(0, this.lastInverse.row - shifted),
      };
    }
  }

  /**
   * Applies a chunk of output, from wherever the cursor already is.
   *
   * A sequence split across two calls is **held** rather than refused, which is
   * what a terminal does: `write('\u001b')` then `write('[H')` is one cursor
   * move, and before this the first call threw `unparsed escape`. It matters
   * because a caller replaying captured output chunks it wherever the pipe did.
   * What is still refused is a *complete* sequence this has no answer for --
   * that is the diagnostic, and the one worth keeping.
   *
   * @param output - The bytes.
   */
  write(output: string): void {
    const held = this.#held;
    this.#held = '';
    output = held + output;
    let i = 0;

    while (i < output.length) {
      const ch = output[i];

      if (ch === '\r') {
        this.column = 0;
        this.wrapPending = false;
        i++;
        continue;
      }

      if (ch === '\n') {
        this.#down();
        this.wrapPending = false;
        i++;
        continue;
      }

      if (ch === ESC) {
        const osc = OSC.exec(output.slice(i));
        if (osc) {
          // `52 ; Pc ; <base64>` is a clipboard write and is the one OSC worth
          // keeping; everything else changes no cell, which is what a screen
          // model has to say about it
          const clip = /^52;([^;]*);(.*)$/s.exec(osc[1]);
          if (clip) {
            this.clipboard.push({
              selection: clip[1],
              text: Buffer.from(clip[2], 'base64').toString('utf8'),
            });
          }
          i += osc[0].length;
          continue;
        }

        const csi = CSI.exec(output.slice(i));
        if (!csi) {
          // a tail that could still *become* a sequence is held for the next
          // call; anything else is a complete sequence with no answer here,
          // which is the diagnostic rather than something to guess past
          if (PARTIAL.test(output.slice(i))) {
            this.#held = output.slice(i);
            return;
          }
          throw new Error(`unparsed escape at ${i}: ${JSON.stringify(output.slice(i, i + 12))}`);
        }

        const [match, priv, params, final] = csi;
        const n = Number.parseInt(params, 10) || 1;
        i += match.length;

        if (priv === '?') {
          // the private modes this models: the cursor and the alternate screen
          if (params === '25') {
            this.cursorHidden = final === 'l';
          } else if (params === '1049' && final === 'h') {
            // 1049 saves the cursor, switches, and clears, which is the whole
            // reason it is the one worth using
            this.#saved = { column: this.column, row: this.row };
            this.alternate = true;
            this.#alt.rows = this.#blank();
            this.row = 0;
            this.column = 0;
            this.wrapPending = false;
            // the recorded caret is on the buffer nobody is looking at now
            this.lastInverse = undefined;
          } else if (params === '1049' && final === 'l') {
            this.alternate = false;
            this.wrapPending = false;
            this.lastInverse = undefined;
            if (this.#saved) {
              // clamped, because a resize while the alternate screen was up
              // leaves a saved position off the grid -- and `#put()` then
              // no-ops for ever, which is the `ESC[H` defect by another route
              this.row = Math.min(this.height - 1, this.#saved.row);
              this.column = Math.min(this.width - 1, this.#saved.column);
              this.#saved = undefined;
            }
          }
          // and the deferred wrap is **left alone**: a mode change moves no
          // cursor, so there is nothing to disarm -- `enableBracketedPaste()`
          // writes `ESC[?2004h` to stdout, so a full-width frame followed by
          // one had its next character overwrite the last column instead of
          // wrapping. The `1049` cases set the cursor themselves and clear it
          // there. Found by review
          continue;
        }

        switch (final) {
          case 'A': {
            this.row = Math.max(0, this.row - n);
            this.wrapPending = false;
            break;
          }
          case 'B': {
            // CUD stops at the bottom margin: it never scrolls, which is the
            // whole reason a backend reserves its rows with newlines instead
            this.row = Math.min(this.height - 1, this.row + n);
            this.wrapPending = false;
            break;
          }
          case 'C': {
            this.column = Math.min(this.width - 1, this.column + n);
            this.wrapPending = false;
            break;
          }
          case 'H': {
            // clamped at the bottom like `A`, `B` and `C`, which it was not:
            // `ESC[99999H` set the row to 99998, every write after it landed on
            // a row that does not exist and was dropped by `#put()`, and the
            // cursor never came back. Silent, and every later frame lost.
            //
            // And the **column** parameter is read, which it also was not:
            // `ESC[5;10H` is row 5 column 10 and was taken as row 5 column 0.
            // Nothing in this library emits the two-parameter form -- the only
            // `H` it writes is a bare `ESC[H` -- so this is for a caller
            // pointing the model at their own output, which is what shipping it
            // means. Both found by walking the inputs rather than by a test
            const [first, second] = params.split(';');
            this.row = Math.min(this.height - 1, cursorAt(first));
            this.column = Math.min(this.width - 1, cursorAt(second));
            this.wrapPending = false;
            break;
          }
          case 'J': {
            // `Ps` honoured rather than only the default, because `0`, `1` and
            // `2` are three different erases and two of them did nothing at
            // all: `ESC[2J` cleared no cell and `ESC[1J` cleared no cell, each
            // silently
            const mode = params === '' ? '0' : params;
            if (mode === '0' || mode === '2') {
              this.#erase(mode === '2' ? 0 : this.column, this.width);
            }
            if (mode === '1' || mode === '2') {
              this.#erase(0, mode === '2' ? this.width : this.column + 1);
            }
            for (let y = 0; y < this.height; y++) {
              const below = y > this.row;
              const above = y < this.row;
              if ((mode === '0' && below) || (mode === '1' && above) || mode === '2') {
                this.#buffer.rows[y] = Array.from({ length: this.width }, () => BLANK);
              }
            }
            this.wrapPending = false;
            break;
          }
          case 'K': {
            // the same, and this one is about a sequence the library *publishes*:
            // `ERASE_LINE` is `ESC[2K`, which is the whole line, and this blanked
            // from the cursor for it. Published rather than written -- nothing in
            // `src/` emits it -- so it is a caller's path. Found by review
            const mode = params === '' ? '0' : params;
            if (mode === '0') {
              this.#erase(this.column, this.width);
            } else if (mode === '1') {
              this.#erase(0, this.column + 1);
            } else if (mode === '2') {
              this.#erase(0, this.width);
            }
            this.wrapPending = false;
            break;
          }
          case 'm': {
            // styling, which a screen model has no opinion about -- bar the one
            // attribute something on screen is made of rather than merely wearing.
            // Read parameter by parameter, because a transition combines what it
            // closes with what it opens: green after inverse is `27;32`, so a test
            // matching the whole string would be pinning one spelling of it.
            //
            // And an extended colour's own parameters are skipped, which is the bug
            // AGENTS.md records twice and this made a third time: the canvas emits
            // `38;2;7;7;7` for an `rgb(7, 7, 7)`, so a naive walk reads a *channel*
            // as reverse video and every cell after it is recorded as the caret.
            // Only the semicolon form skips, because the colon form carries the
            // whole colour inside one parameter; six parameters rather than five
            // only where the colour space is *empty*, since a non-empty one is as
            // plausible a red channel
            const parts = params.split(';');
            for (let at = 0; at < parts.length; at++) {
              const part = parts[at];
              if (part === '38' || part === '48' || part === '58') {
                if (parts[at + 1] === '5') {
                  at += 2;
                } else if (parts[at + 1] === '2') {
                  at += parts[at + 2] === '' ? 5 : 4;
                }
                continue;
              }
              if (part === '7') {
                this.#inverse = true;
              } else if (part === '27' || part === '0' || part === '') {
                this.#inverse = false;
              }
            }
            break;
          }
          case 'n': {
            // a device status request -- `CSI 6 n` is "where is the cursor". It
            // changes nothing on screen, and the answer comes back on the *input*
            // stream, which a test supplies by feeding bytes rather than something
            // this could write. Modelled as nothing rather than left to the
            // `default` below, which threw and was swallowed by the one caller
            // that cannot report anything
            break;
          }
          default: {
            throw new Error(`unmodelled sequence: ${final}`);
          }
        }
        continue;
      }

      // a run of graphic text, read as grapheme clusters. Segmented up to the
      // next control character rather than one cluster at a time off the whole
      // remaining string, which is the same answer and is linear rather than
      // quadratic in the length of a frame
      const end = this.#nextControl(output, i);
      for (const cluster of graphemes(output.slice(i, end))) {
        this.#place(cluster);
      }
      i = end;
    }
  }

  /** Where the next thing `write()` handles itself begins, or the end. */
  #nextControl(output: string, from: number): number {
    for (let at = from + 1; at < output.length; at++) {
      const ch = output[at];
      if (ch === '\r' || ch === '\n' || ch === ESC) {
        return at;
      }
    }
    return output.length;
  }

  /** Blanks a span of the cursor's row, repairing a cluster it cuts into. */
  #erase(from: number, to: number): void {
    const row = this.#buffer.rows[this.row];
    if (!row) {
      return;
    }
    this.#repair(row, from);
    for (let x = from; x < to; x++) {
      row[x] = BLANK;
    }

    // the recorded caret was on a cell this just blanked, so it is not a caret
    // any more. The class doc's point is about a *frame* that draws none --
    // there is no frame to hang a reset on -- and an erase is a write of blanks,
    // which the plain-write rule already clears for. Found by review
    if (
      this.lastInverse?.row === this.row &&
      this.lastInverse.column >= from &&
      this.lastInverse.column < to
    ) {
      this.lastInverse = undefined;
    }
  }
}

/**
 * One coordinate of a `CUP`, which is one-based and defaults to one.
 *
 * `Number.parseInt('')` is `NaN` and `NaN || 1` is `1`, which is what makes a
 * bare `ESC[H` the origin without a branch for it -- and the floor is here
 * rather than at the call site because the two axes clamp against different
 * sizes.
 *
 * @param text - The parameter, which may be absent.
 * @returns A zero-based coordinate.
 */
function cursorAt(text: string | undefined): number {
  return Math.max(0, (Number.parseInt(text ?? '', 10) || 1) - 1);
}

/** A TTY write stream over a `Screen`, with a way to resize it from a test. */
export interface ScreenStream {
  columns: number;
  isTTY: true;
  on(event: string, fn: (...args: unknown[]) => void): ScreenStream;
  removeListener(event: string, fn: (...args: unknown[]) => void): ScreenStream;
  /** Resizes the screen and tells whoever is listening, as a TTY does. */
  resize(width: number, height: number): void;
  rows: number;
  write(chunk: string): boolean;
}

/**
 * A terminal-shaped object over a `Screen`, for `createTerminal({ stdout })`.
 *
 * @param screen - The screen to write into.
 * @returns The stream, plus the resize hook a terminal listens for.
 */
export function screenStream(screen: Screen): ScreenStream {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    columns: screen.width,
    isTTY: true as const,
    on(event: string, fn: (...args: unknown[]) => void): ScreenStream {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return this;
    },
    removeListener(event: string, fn: (...args: unknown[]) => void): ScreenStream {
      listeners.get(event)?.delete(fn);
      return this;
    },
    resize(width: number, height: number): void {
      screen.resize(width, height);
      this.columns = width;
      this.rows = height;
      for (const fn of listeners.get('resize') ?? []) {
        fn();
      }
    },
    rows: screen.height,
    write(chunk: string): boolean {
      screen.write(chunk);
      return true;
    },
  };
}
