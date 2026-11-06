import { Screen } from '@ttylabs/sigil/testing';
import { graphemes, stringWidth } from '@ttylabs/sigil/width';
import { createSgrState } from '@ttylabs/sigil/wrap';

/**
 * A prompt's screen, with the colour it was drawn in.
 *
 * A prompt does not print its screen; it prints the *difference* from the last
 * one -- cursor moves, a few cells, an erase -- so the bytes of a run say nothing
 * about what a reader was looking at, and the page has to draw what they were.
 * `Screen` from `@ttylabs/sigil/testing` is the model that replays those bytes
 * and it is the one the repository's own prompt tests use, but it keeps
 * characters only: its class comment says a claim about colour belongs in the
 * bytes. This is the bytes, replayed through it, with a record beside it of what
 * styling was in effect when each cell was written.
 *
 * It does not interpret a sequence itself. Every cursor move, erase and line
 * break goes to `Screen`; this only notices the SGR sequences, which `Screen`
 * ignores, and the two erases, which have to clear the record along with the
 * cells. So there is one answer to "where is the cursor" and it is not this
 * file's.
 *
 * What it does not model is a screen that scrolls, because a record keyed by row
 * would then name the wrong rows. `toSgr()` throws instead, which is the signal
 * to give the scene more rows than it uses.
 *
 * The alternate screen is a second record, as it is a second buffer to
 * `Screen`: a full-screen app draws on it, and `toSgr()` answers whichever of the
 * two is in front -- which is what the reader of a running app is looking at.
 */

const ESC = String.fromCharCode(0x1b);

/**
 * One token of output: an SGR sequence, an erase, a query, or anything else.
 *
 * A query is a CSI with a private marker (`ESC[>q`, which asks the terminal's
 * name and version) or the device-attributes request `ESC[c`: a full-screen app
 * asks both as it starts, they draw nothing, and `Screen` does not parse them,
 * so they are dropped here before it sees them.
 */
const TOKEN = new RegExp(
  `(${ESC}\\[[<=>][\\d;:]*[ -/]*[@-~]|${ESC}\\[0?c)|${ESC}\\[([\\d;:]*)([mJK])|${ESC}\\[[\\d;:?]*[A-Za-z]|${ESC}\\][^${ESC}\\u0007]*(?:${ESC}\\\\|\\u0007)|[\\r\\n\\b]|[^${ESC}\\r\\n\\b]+|${ESC}`,
  'gu'
);

/**
 * The styling in effect, as the one sequence that would put it back
 * (`ESC[1;36m`), or `''` for none. Two cells written in the same state compare
 * equal.
 */
type Style = string;

export class StyledScreen extends Screen {
  /** Row, then column, to the style that cell was written in, for the main screen. */
  readonly #main: (Style | undefined)[][];
  /** The same for the alternate screen, which entering it clears. */
  #alt: (Style | undefined)[][] = [];
  readonly #state = createSgrState();

  constructor(width: number, height: number) {
    super(width, height);
    this.#main = Array.from({ length: height }, () => []);
  }

  /** The record of whichever screen is in front. */
  get #styles(): (Style | undefined)[][] {
    return this.alternate ? this.#alt : this.#main;
  }

  override write(output: string): void {
    for (const match of output.matchAll(TOKEN)) {
      const [token, query, params, final] = match;

      if (query) {
        continue;
      }

      if (final === 'm') {
        // the tracker the wrapper uses: a close code takes one attribute away
        // and a reset takes them all, which a list of what was seen would not
        this.#state.apply(token);
        continue;
      }

      if (final === 'K' || final === 'J') {
        const mode = params === '' ? '0' : params;
        this.#erase(final, mode as string);
        super.write(token);
        continue;
      }

      if (token.startsWith(ESC) || token === '\r' || token === '\n' || token === '\b') {
        const was = this.alternate;
        super.write(token);
        if (this.alternate && !was) {
          // entering it clears it, so its record starts empty
          this.#alt = Array.from({ length: this.height }, () => []);
        }
        continue;
      }

      // text, a cluster at a time, because a cluster is what lands in a cell and
      // a line can wrap in the middle of a token. Where it landed is read off
      // where the cursor ended up: a terminal that fills the last column does not
      // advance, it arms a wrap, so that is the end of the row
      for (const cluster of graphemes(token)) {
        const cells = stringWidth(cluster);
        super.write(cluster);

        if (cells > 0) {
          const end = this.wrapPending ? this.width : this.column;
          const line = this.#styles[this.row];
          for (let at = end - cells; at < end; at++) {
            line![at] = this.#state.open() || undefined;
          }
        }
      }
    }
  }

  /** Clears the record where the cells are about to be blanked. */
  #erase(final: string, mode: string): void {
    const row = this.row;
    const clear = (y: number, from: number, to: number) => {
      const line = this.#styles[y];
      for (let x = from; x < to; x++) {
        if (line) {
          line[x] = undefined;
        }
      }
    };

    if (final === 'K') {
      if (mode === '0') {
        clear(row, this.column, this.width);
      } else if (mode === '1') {
        clear(row, 0, this.column + 1);
      } else if (mode === '2') {
        clear(row, 0, this.width);
      }
      return;
    }

    for (let y = 0; y < this.height; y++) {
      if (mode === '2' || (mode === '0' && y > row) || (mode === '1' && y < row)) {
        clear(y, 0, this.width);
      }
    }
    if (mode === '0') {
      clear(row, this.column, this.width);
    } else if (mode === '1') {
      clear(row, 0, this.column + 1);
    }
  }

  /**
   * The screen as text with its escape sequences, one line per row.
   *
   * Trailing blank rows and trailing unstyled blanks are dropped. A cell is
   * written after a reset and the sequences it was written in, so the output is
   * the same shape a program prints and `sgrRows()` reads it as one.
   *
   * @returns The screen, with its colour.
   */
  toSgr(): string {
    if (!this.alternate && this.log.length !== this.height) {
      throw new Error('a scene scrolled: give it a taller screen than the rows it uses');
    }
    const lines: string[] = [];

    for (let y = 0; y < this.height; y++) {
      let line = '';
      let last: Style | undefined;
      let end = 0;
      const cells: [string, Style | undefined][] = [];

      for (let x = 0; x < this.width; x++) {
        const cell = this.cellAt(x, y);
        // the far half of a wide cluster draws nothing of its own
        if (cell === '') {
          continue;
        }
        const style = this.#styles[y]?.[x];
        cells.push([cell ?? ' ', style]);
        // a blank is only part of the row if something is drawn on it
        if ((cell ?? ' ') !== ' ' || style !== undefined) {
          end = cells.length;
        }
      }

      for (const [cell, style] of cells.slice(0, end)) {
        if (style !== last) {
          line += (last ? `${ESC}[0m` : '') + (style ?? '');
          last = style;
        }
        line += cell;
      }
      lines.push(line + (last ? `${ESC}[0m` : ''));
    }

    while (lines.length > 0 && lines.at(-1) === '') {
      lines.pop();
    }
    return lines.join('\n');
  }
}
