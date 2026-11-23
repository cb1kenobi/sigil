import { cellWidth } from '../canvas/index.js';
import { toDisplayText } from '../element/index.js';
import { graphemes } from '../width/index.js';
import { isSpaceCluster, snap } from './editing.js';

/**
 * The field layout, in a module that imports no prompt (SIG-615).
 *
 * `layoutField()` and `offsetIn()` were written in `prompt.ts`, so the text area
 * -- which wraps and places its lines with exactly these two -- imported the whole
 * prompt stack to call them: `components/text-area` was 283,108 B over 45 modules
 * and `prompt` was 264,315 B over 41 when this was measured. `prompt.ts` re-exports every name it moved,
 * so none changed, and `number()`, `multiline()` and the text area all import the
 * module they actually want.
 */

/**
 * What a multiline field claims is a coordinate -- a caret derived from an
 * offset, a goal column that survives a short row and a wide cluster -- and
 * those are functions of a string, an offset and a width. The screen model a
 * component test reads holds characters rather than styling, so asserting them
 * through it is asserting them through a keyhole: the cell under the caret holds
 * the same character whether or not a caret was drawn there. So the arithmetic
 * is asserted directly and the field is asserted through the screen, which is
 * the split `rowWindow()` and `thumbExtent()` already keep for the scroll box.
 *
 * `layoutField()`, `offsetIn()` and the shapes they trade in are in the barrel,
 * and each has this module's subpath: `number()` and the text area are registry
 * entries, an ejected copy imports only what is published, and both lay their
 * field out with exactly these two. That makes `FieldLayout` a promise to the app
 * that ejected it -- narrow, and made on purpose; see "Ejecting `number`, `date`
 * and the palette" in this directory's `AGENTS.md`.
 */

/** One cluster of a field's value, and where it was drawn. */
export interface FieldCell {
  /** The cluster's offset in the value. */
  at: number;
  /** What is drawn for it, which is what a `text` would draw for it. */
  text: string;
  /** How many columns it takes. */
  width: number;
  /** The column it starts at. */
  x: number;
}

/** One row of a field, which is a row on screen rather than a line of the value. */
export interface FieldRow {
  cells: FieldCell[];
  /** The offset the row begins at, which is where an empty row's caret goes. */
  start: number;
  /** The columns its cells take. */
  width: number;
}

/** A value laid out at a width, with the caret placed in it. */
export interface FieldLayout {
  /** Where the caret is drawn, and the cluster it marks. */
  caret: { row: number; text: string; x: number };
  rows: FieldRow[];
  /** The columns the field asks for: its widest row, plus the caret's own. */
  width: number;
}

/** What the two layers of a field read: the rows, the window, and the caret. */
export interface FieldFrame {
  layout: FieldLayout;
  /**
   * The token each offset of the value was highlighted as, where it was. A cell
   * whose cluster starts at a highlighted offset is left to the layer for that
   * token rather than painted by the field, so whoever sets this draws those cells.
   */
  tokens?: readonly (string | undefined)[];
  /** The first row on screen, when the value is taller than the field. */
  top: number;
  /** How many of its rows are on screen. */
  visible: number;
}

/** A cluster of the value, with where it is. */
interface Cluster {
  at: number;
  text: string;
}

/** A run of clusters that are all whitespace or all not, which is what wraps. */
interface ClusterRun {
  clusters: Cluster[];
  space: boolean;
  width: number;
}

/**
 * What one cluster draws, which is what a `text` draws for it.
 *
 * A newline is the line terminator rather than something to draw: it is a
 * cluster of the value and therefore an offset the caret can sit on, and it
 * takes no column. Everything else goes through the same function a `text`
 * reads, which is what makes a tab one space here as well -- the grid models no
 * tab stops, and a field that disagreed with every other text in the library
 * about what a tab is would be a column out per tab.
 *
 * The newline branch fails its own sabotage and is kept, because the sabotage is
 * **equivalent** rather than the branch dead: `cellWidth('\n')` is zero --
 * measured, along with every other control character -- so the cell comes out
 * unpaintable either way. What it buys is that nothing can ever hand a raw `\n`
 * to `CellBuffer.put()`, which *throws* on one. Dropping the mapping altogether
 * is the sharper sabotage and is caught.
 *
 * @param cluster - One grapheme cluster of the value.
 * @returns What to paint, which is empty for anything with no cell.
 */
function clusterText(cluster: string): string {
  return cluster === '\n' ? '' : toDisplayText(cluster);
}

/** How many columns one cluster takes, which is what the grid will give it. */
function clusterWidth(cluster: string): number {
  const text = clusterText(cluster);
  return text === '' ? 0 : cellWidth(text);
}

/** Splits a line's clusters into the runs `wrap()` breaks between. */
function clusterRuns(clusters: readonly Cluster[]): ClusterRun[] {
  const runs: ClusterRun[] = [];
  let current: Cluster[] = [];
  let space = false;
  let width = 0;

  for (const cluster of clusters) {
    const blank = isSpaceCluster(cluster.text);
    if (current.length > 0 && blank !== space) {
      runs.push({ clusters: current, space, width });
      current = [];
      width = 0;
    }
    space = blank;
    current.push(cluster);
    width += clusterWidth(cluster.text);
  }
  if (current.length > 0) {
    runs.push({ clusters: current, space, width });
  }

  return runs;
}

/**
 * Where a caret goes on a row, given the column it would like.
 *
 * **A caret may not be painted on the far half of a wide cluster**, and that is
 * not about how it looks: `CellBuffer` carries a write on either half of one to
 * the other, so a space on the continuation blanks the lead and the character is
 * *gone*. Measured -- `漢` in a two-column grid, a space at column one, and the
 * row comes back as two blanks.
 *
 * Two columns are the only place it can happen and both are reachable. A cluster
 * wider than the wrap limit is placed at column zero anyway, because the break
 * guard asks `x > 0` -- there is nowhere else to put it -- so a field of one or
 * two columns holds a row two columns wide, the reported width is the room, and
 * the clamp under `edge` lands on column one. And a zero-width cell is clamped
 * to the wrap column by `place()`, so a newline after such a cluster is *already*
 * there: `漢\nmore` with End pressed on the first line is the same cell.
 *
 * So the caret backs up to the cluster's lead and **marks the cluster**, which is
 * this field's own rule applied to the only cluster there is room for. It is
 * wrong about where the next character goes -- in a two-column field holding a
 * wide character there is no column that is right about that -- and it is the only
 * answer that keeps the character on screen.
 *
 * @param row - The row the caret is on.
 * @param at - The column it would like.
 * @returns The column to paint in, and what to paint there.
 */
function caretOn(row: FieldRow, at: number): { text: string; x: number } {
  for (const cell of row.cells) {
    if (cell.width > 0 && at >= cell.x && at < cell.x + cell.width) {
      return { text: cell.text, x: cell.x };
    }
  }

  return { text: ' ', x: at };
}

/**
 * A value laid out as rows of cells, with the caret placed among them.
 *
 * **This is what the `raw` node buys and why the field is one.** A wrapping
 * field is the problem the single-line prompt scrolls sideways to avoid: there
 * is no inline layout, so the three pieces the caret splits a value into are
 * three flex items, and a wrapped first item leaves the other two beside its
 * *box* rather than after its last line. A `raw` is one node that measures like
 * a text and paints its own cells, so the value is wrapped once here and the
 * caret is a cell coordinate derived from the offset.
 *
 * **Soft wrap only.** The value keeps exactly the breaks the person typed, and a
 * row is where the field *drew* a break rather than anything in the value.
 *
 * **The caret marks the cluster at the cursor**, which is the single-line
 * field's own rule -- reverse video over a whole grapheme cluster -- and it is
 * what answers the end-of-a-row-versus-start-of-the-next question with no second
 * rule to remember: a cursor at a soft break is drawn at the start of the next
 * row, because that is where the cluster it names was placed. Past the last
 * cluster there is nothing to mark, so the caret is a column of its own.
 *
 * **Every cluster is placed, including the whitespace a break throws away.**
 * `wrap()` drops the trailing whitespace of a line and is right to -- a terminal
 * draws nothing for it. A field cannot: a space is an offset the caret has to be
 * able to sit on, so the gap stays on the row it ended. What that costs is one
 * declared divergence: whitespace that would land past the wrap column is placed
 * *at* it, so a run of several spaces at a break shares one column. They are all
 * blanks, so nothing on screen says so; what it buys is that the caret is always
 * inside the box, with no phantom row for an invisible character.
 *
 * **It wraps at one column less than the room**, which is the single-line
 * field's own rule said again: the caret always takes a column, whether it is on
 * a character or past the last one. The alternative is a caret at column
 * `width`, drawn on a row below the one it belongs to -- and then pressing End
 * on a full row makes the field a row taller, so a key that moved nothing
 * reflows everything under it.
 *
 * @param value - What has been typed, or the placeholder standing in for it.
 * @param cursor - Where the caret is, as an offset into it.
 * @param room - The columns the field has.
 * @returns The rows, the caret, and the width the field asks for.
 */
export function layoutField(value: string, cursor: number, room: number): FieldLayout {
  const limit = Math.max(1, room - 1);
  const at = snap(value, Math.max(0, Math.min(cursor, value.length)));
  const rows: FieldRow[] = [];

  let cells: FieldCell[] = [];
  let start = 0;
  /** The column the next cluster would take, before the clamp. */
  let x = 0;

  /** Ends the row being built and starts one at `next`. */
  const flush = (next: number): void => {
    let width = 0;
    for (const cell of cells) {
      width = Math.max(width, cell.x + cell.width);
    }
    rows.push({ cells, start, width });
    cells = [];
    start = next;
    x = 0;
  };

  const place = (cluster: Cluster): void => {
    const text = clusterText(cluster.text);
    const width = text === '' ? 0 : cellWidth(text);
    cells.push({ at: cluster.at, text, width, x: Math.min(x, limit) });
    x += width;
  };

  // the value's clusters, grouped into the logical lines its newlines define.
  // The terminator belongs to the line it ends, because its offset is a place
  // the caret goes: pressing End on a line puts it there
  const lines: { clusters: Cluster[]; start: number; terminator: Cluster | undefined }[] = [];
  let line: Cluster[] = [];
  let lineStart = 0;
  let offset = 0;

  for (const text of graphemes(value)) {
    const cluster = { at: offset, text };
    offset += text.length;
    if (text === '\n') {
      lines.push({ clusters: line, start: lineStart, terminator: cluster });
      line = [];
      lineStart = offset;
    } else {
      line.push(cluster);
    }
  }
  lines.push({ clusters: line, start: lineStart, terminator: undefined });

  for (const logical of lines) {
    start = logical.start;

    /** The whitespace since the last word, which decides where a break falls. */
    let gap: Cluster[] = [];
    let gapWidth = 0;

    for (const run of clusterRuns(logical.clusters)) {
      if (run.space) {
        gap = run.clusters;
        gapWidth = run.width;
        continue;
      }

      const breaking = x > 0 && x + gapWidth + run.width > limit;
      // the gap goes on the row it ended either way, which is where this parts
      // company with `wrap()` and why
      for (const cluster of gap) {
        place(cluster);
      }
      gap = [];
      gapWidth = 0;
      if (breaking) {
        flush(run.clusters[0].at);
      }

      for (const cluster of run.clusters) {
        // only reachable for a word that did not fit a row of its own, since
        // the row was already broken for one that did: this is where it is cut
        if (x > 0 && x + clusterWidth(cluster.text) > limit) {
          flush(cluster.at);
        }
        place(cluster);
      }
    }

    for (const cluster of gap) {
      place(cluster);
    }
    if (logical.terminator) {
      place(logical.terminator);
    }
    flush(logical.terminator ? logical.terminator.at + 1 : value.length);
  }

  let widest = 0;
  for (const row of rows) {
    widest = Math.max(widest, row.width);
  }
  // the caret's own column is what the `+ 1` is, and it is what makes the clamp
  // below a no-op anywhere but a one-column field -- where `limit` cannot be
  // zero, so a cell really can land on the column the box ends at
  const width = Math.min(Math.max(1, room), widest + 1);
  const edge = width - 1;

  for (const [row, built] of rows.entries()) {
    for (const cell of built.cells) {
      if (cell.at === at) {
        // through `caretOn()` whatever the cell is, which is one rule rather
        // than two: a cell of positive width finds itself there and takes its
        // own text, and a cell with no cell at all -- a newline, a lone
        // combining mark, a control character a caller handed in -- has nothing
        // to mark, so it comes back a blank unless the column it was clamped to
        // belongs to a cluster. `place()` clamps a zero-width cell to the wrap
        // column, which a wide cluster may already be sitting on
        const on = caretOn(built, Math.min(edge, cell.x));
        return { caret: { row, text: on.text, x: on.x }, rows, width };
      }
    }
  }

  // past the last cluster, which is the one position no cluster owns -- and it is
  // the last row's, because every other row's end is the next row's start
  const last = rows.at(-1);
  const on = last ? caretOn(last, Math.min(edge, last.width)) : { text: ' ', x: 0 };
  return { caret: { row: rows.length - 1, text: on.text, x: on.x }, rows, width };
}

/**
 * The offset a vertical move lands on, given the column it is aiming for.
 *
 * **The goal is a display column rather than an offset**, which is the thing a
 * from-scratch textarea gets wrong: a remembered offset drifts left through a
 * short row, and an offset and a column stop being the same number the moment a
 * row holds a wide character. So Up-Up-Down comes back to the column it started
 * in, through a short row and through a row of CJK.
 *
 * The last cluster whose column is at or before the goal, which is where a caret
 * can be: aiming past the end of a row lands on its last position, and aiming at
 * the far half of a wide cluster lands on that cluster rather than between its
 * halves.
 *
 * @param layout - The value as it is drawn.
 * @param length - The value's length, for the one position no cluster owns.
 * @param row - The row to land on.
 * @param column - The column to aim for.
 * @returns The offset.
 */
export function offsetIn(layout: FieldLayout, length: number, row: number, column: number): number {
  const index = Math.max(0, Math.min(row, layout.rows.length - 1));
  const target = layout.rows[index];

  // the position past the last cluster, which only the last row has: every other
  // row's end is the next row's start, and belongs to that row.
  //
  // Aimed at the column the caret would be *drawn* in rather than at the row's
  // own extent, because the two part company exactly where the whitespace clamp
  // bit: a row ending in a run of spaces is `limit + 1` wide while the caret past
  // it is drawn at `limit`, so a goal column -- which can never exceed the edge --
  // could not reach the end of the value at all. `layoutField()` computes that
  // column the same way, which is what keeps the two agreeing
  if (index === layout.rows.length - 1 && column >= Math.min(layout.width - 1, target.width)) {
    return length;
  }

  let found = target.start;
  for (const cell of target.cells) {
    if (cell.x > column) {
      break;
    }
    // at or before, and the *last* such cell: a run of whitespace clamped to the
    // wrap column shares it, and the caret belongs on the last of them
    found = cell.at;
  }

  return found;
}
