/**
 * An interactive table: pick a row, and sort by a column on the way.
 *
 * The answer to "pick a deployment from this list" where the deployment is more
 * than a label -- a name, a region, an age -- and a `select()` would mean
 * flattening the columns into one string and padding them by hand. The columns
 * are `table()`'s: the same `Column` and `TableRow`, measured the same way, so
 * one declaration prints a table and asks about one.
 *
 * ```js
 * const row = await selectRow({
 *   message: 'Which deployment?',
 *   rows: [
 *     { name: 'api', region: 'us-east', age: 3 },
 *     { name: 'web', region: 'eu-west', age: 12 },
 *   ],
 *   columns: [{ key: 'name' }, { key: 'region' }, { key: 'age', align: 'right' }],
 * });
 * // { name: 'web', region: 'eu-west', age: 12 }
 * ```
 *
 * Up and Down move a cursor over whole rows and Enter answers with the row that
 * was passed in. A digit sorts by that column; pressing it again reverses the
 * order and a third time puts the rows back as they came.
 */

import { box, type Element, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { byCodeUnit } from '../util/by-code-unit.js';
import { stringWidth } from '../width/index.js';
import { truncate } from '../wrap/index.js';
import {
  type AccessibleOptions,
  listWindow,
  PROMPT_SYMBOLS,
  promptAnswered,
  promptAnswerSlot,
  promptAsLines,
  promptFooter,
  promptHeadLine,
  promptHeadWidths,
  promptKeys,
  type PromptOptions,
  PromptError,
  promptListRows,
  runPrompt,
  select,
} from './prompt.js';
import {
  type Column,
  type TableCell,
  tableCells,
  type TableRow,
  tableRowView,
  tableValue,
  tableWidths,
} from './table.js';

/** What a column may say about being sorted, on top of what `table()` reads. */
export interface SelectRowColumn extends Column {
  /**
   * How two values of this column are ordered, for a column whose values are not
   * ordered the way `compareCells()` would order them: a version, a size with a
   * unit, a name in some locale. It is handed the values the rows hold rather than
   * the text drawn, and is never handed an empty one. A `TableCellView` is a
   * value here, handed over as the row holds it, so a view that carries what it
   * stands for -- `{ ...badgeView('FAIL'), rank: 2 }` -- can be ordered by that.
   */
  compare?: (a: unknown, b: unknown) => number;
  /**
   * Whether a digit sorts by this column. Defaults to `true`, except for a column
   * whose every cell is a `TableCellView` and which gives no `compare`: the default
   * order cannot read a view, so its digit would move nothing.
   */
  sortable?: boolean;
}

export interface SelectRowOptions<R extends object = TableRow>
  extends PromptOptions, AccessibleOptions {
  /**
   * The columns, as for `table()`. Inferred from the first row's keys when not
   * given.
   */
  columns?: (SelectRowColumn | string)[];
  /** The columns between one column and the next. Defaults to 2. */
  gap?: number;
  /** Whether to draw the heading row. Defaults to `true` when any column has one. */
  head?: boolean;
  /**
   * How many body rows the table may take. Defaults to what the terminal has left
   * under the question and the heading. Named for the height rather than `rows`,
   * which is what the other list prompts call it, because here `rows` is the data
   * -- as it is for `table()`.
   */
  height?: number;
  /**
   * Which row starts under the cursor, by index into `rows`. Defaults to 0.
   */
  initial?: number;
  /**
   * Whether the cursor wraps from one end of the table to the other. Defaults to
   * `true`.
   */
  loop?: boolean;
  /** What to pick from, as objects or as arrays of cells. Never changed. */
  rows: readonly R[];
  /**
   * What is shown once answered, for a row whose cells joined with commas are too
   * long a line to leave behind. A `TableCellView` cell has no text to join, so
   * the default leaves it out; a row whose view is the point of it says so here.
   */
  short?: (row: R) => string;
  /**
   * An answer to start from: the row that is this one starts under the cursor,
   * and beats `initial`. The row itself, compared the way a `Map` compares keys --
   * so it is found when `rows` is the same objects it was answered from, and
   * dropped, leaving `initial` to decide, when it is not.
   */
  value?: R;
}

/**
 * What a cell is ordered by, or `undefined` where it has nothing to be ordered by.
 *
 * Empty is a missing value, `null`, and the two numbers that are not one: `NaN`
 * and an invalid `Date`. A boolean orders as the number it is.
 *
 * @param value - The cell's value.
 * @returns A number, a bigint or a string, or `undefined`.
 */
function orderKey(value: unknown): bigint | number | string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time;
  }
  if (typeof value === 'number') {
    return Number.isNaN(value) ? undefined : value;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'boolean') {
    return Number(value);
  }
  return String(value);
}

/**
 * Whether a cell has a value to order by.
 *
 * @param value - The cell's value.
 * @returns `false` for a missing value, `null`, `NaN` and an invalid `Date`.
 */
function hasValue(value: unknown): boolean {
  return orderKey(value) !== undefined;
}

/**
 * Orders two cell values, the way a column sorts when it does not say.
 *
 * Numbers, bigints, dates and booleans order by what they are, so `9` comes
 * before `10`. Anything else orders as the text it is, folded to lower case first
 * so `alpha` sorts before `Zeta`, and by code unit after that -- not by
 * `localeCompare()`, which needs ICU and is the lever a column's own `compare` is
 * for. A number comes before a text where a column holds both, and a value that
 * is empty comes after everything.
 *
 * @param a - One value.
 * @param b - The other.
 * @returns Negative where `a` comes first, positive where `b` does, and `0` where
 *   neither does.
 */
export function compareCells(a: unknown, b: unknown): number {
  const x = orderKey(a);
  const y = orderKey(b);

  if (x === undefined || y === undefined) {
    return x === y ? 0 : x === undefined ? 1 : -1;
  }

  const textual = [typeof x === 'string', typeof y === 'string'];
  if (textual[0] !== textual[1]) {
    return textual[0] ? 1 : -1;
  }
  if (typeof x === 'string' && typeof y === 'string') {
    return byCodeUnit(x.toLowerCase(), y.toLowerCase()) || byCodeUnit(x, y);
  }
  // a number, a bigint, a date's time or a boolean, which `<` orders across
  // kinds where `byCodeUnit()` takes strings alone
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The marks on a sorted heading. */
const ARROW = { ascending: '▲', descending: '▼' } as const;

/** How many columns a digit can reach. */
const DIGITS = 9;

/**
 * Asks for a row of a table.
 *
 * Up and Down move the cursor, wrapping unless `loop: false`; Home and End go to
 * the first and last row and Page Up and Page Down a screen at a time. **Enter
 * answers** with the row exactly as it was passed in. **A digit sorts** by that
 * column, and pressing it again reverses the order, and a third time puts the rows
 * back as they came; the cursor stays on the row it was on, wherever that goes.
 * The heading stays on screen however far the rows scroll.
 *
 * @param opts - What to ask and what to pick from.
 * @returns The row the person chose.
 */
export function selectRow<R extends object = TableRow>(opts: SelectRowOptions<R>): Promise<R> {
  const data = opts.rows;
  // `object` and not `TableRow` as the constraint: an `interface` has no index
  // signature, so it is not a `Record<string, unknown>`, and the rows a caller
  // has are as often a declared type as a literal
  const asRows = data as readonly TableRow[];

  if (data.length === 0) {
    return Promise.reject(new PromptError(`"${opts.message}" has no rows to offer`));
  }

  const terminal = opts.terminal ?? defaultTerminal;
  const loop = opts.loop ?? true;
  const gap = opts.gap === undefined ? 2 : Math.max(0, Math.floor(opts.gap));
  const { cells, columns, headers } = tableCells(asRows, { columns: opts.columns });
  const head = opts.head ?? columns.some((column) => column.header !== undefined);
  // a column of views and nothing else has nothing the default order can read, so
  // its digit would draw an arrow and move no row: it sorts only when it says so,
  // or gives the `compare` that knows what the views stand for
  const sortable = columns.map((column, i) => {
    const { compare, sortable: asked } = column as SelectRowColumn;
    return (
      i < DIGITS &&
      (asked ??
        (compare !== undefined || cells.some((row) => (row[i] as TableCell).view === undefined)))
    );
  });
  // measured over every row rather than over the ones on screen, so a column does
  // not change width as the window moves. A sortable heading keeps two columns
  // back for its arrow, which is what it costs for the table not to jump when a
  // sort is turned on
  const widths = tableWidths(
    headers.map((header, i) => (head && sortable[i] ? `${header}  ` : header)),
    cells,
    columns,
    head
  );
  const values = data.map((row) =>
    columns.map((column, i) => tableValue(row as TableRow, column, i))
  );

  const unsorted = data.map((_, i) => i);
  let order = unsorted;
  let sortBy: number | undefined;
  let descending = false;
  const named = opts.value === undefined ? -1 : data.indexOf(opts.value);
  let at =
    named >= 0 ? named : Math.min(Math.max(0, Math.floor(opts.initial ?? 0) || 0), data.length - 1);
  let top = 0;

  /** What a row is shown as once answered: its own `short`, or its cells joined. */
  const shortOf = (index: number): string =>
    opts.short
      ? opts.short(data[index] as R)
      : (cells[index] as TableCell[])
          .map((cell) => cell.text)
          .filter(Boolean)
          .join(', ');

  if (promptAsLines(opts)) {
    // `select()` over the rows, each read as one line: a cell after its column's
    // heading, since a row of bare values heard in order is a row of values
    // nobody can tell apart, and a cell with nothing to say -- empty, or a view
    // with no text -- left out. No sorting: a digit is a number to choose by
    // here, and the rows are in the order they were handed over
    return select<R>({
      ...opts,
      accessible: true,
      choices: data.map((row, index) => ({
        label: (cells[index] as TableCell[])
          .flatMap((cell, i) => {
            if (!cell.text) {
              return [];
            }
            const heading = head ? headers[i] : undefined;
            return [heading ? `${heading}: ${cell.text}` : cell.text];
          })
          .join(', '),
        short: shortOf(index),
        value: row,
      })),
      initial: at,
      value: undefined,
    });
  }

  /** The index into `data` of the row under the cursor. */
  const under = (): number => order[at] as number;

  /**
   * Puts the rows in the order the sort says, keeping the cursor on its row.
   *
   * An empty cell is placed last whichever way the column runs, because "no value"
   * has no place in an ascending order that reversing it would improve. The sort
   * is stable, so rows that tie keep the order they came in both ways.
   */
  function resort(): void {
    const keep = under();
    if (sortBy === undefined) {
      order = unsorted;
    } else {
      const column = sortBy;
      const own = (columns[column] as SelectRowColumn).compare;
      const compare = own ?? compareCells;
      const flip = descending ? -1 : 1;
      // a view is a tree and has no order of its own, so the default puts it with
      // the empty cells -- where `String()` would have filed every one of them
      // under `[object Object]`, between the texts. A column's own `compare` is
      // handed it as the value the row holds, since whoever built the view knows
      // what it stands for
      const present = (row: number): boolean =>
        ((cells[row] as TableCell[])[column] as TableCell).view === undefined
          ? hasValue((values[row] as unknown[])[column])
          : own !== undefined;
      order = [...unsorted].sort((a, b) => {
        const x = (values[a] as unknown[])[column];
        const y = (values[b] as unknown[])[column];
        if (!present(a) || !present(b)) {
          return present(a) ? -1 : present(b) ? 1 : 0;
        }
        return compare(x, y) * flip;
      });
    }
    at = order.indexOf(keep);
  }

  /** Sorts by a column, or reverses or clears the sort if it already is. */
  function sortOn(column: number): void {
    if (sortBy !== column) {
      sortBy = column;
      descending = false;
    } else if (!descending) {
      descending = true;
    } else {
      sortBy = undefined;
      descending = false;
    }
    resort();
  }

  return runPrompt<R>(opts, () => {
    const header = head
      ? box({
          class: 'sigil-table-select-head',
          'padding-left': stringWidth(PROMPT_SYMBOLS.cursor) + 1,
        })
      : undefined;
    const headRoom = promptHeadWidths(opts.message, Math.max(1, terminal.width));
    const answer = promptAnswerSlot(headRoom.rest);
    const { line, mark } = promptHeadLine(opts.message, headRoom.message, answer.beside);
    const list = box({ class: 'sigil-table-select-list', 'flex-direction': 'column' });
    const position = textNode('', {
      class: 'sigil-table-position sigil-muted',
      display: 'none',
      'padding-left': stringWidth(PROMPT_SYMBOLS.cursor) + 1,
    });

    // a digit per sortable column, each one a binding of its own with the same
    // description, which the footer folds into one line -- `1/2/3 sort`. Only the
    // columns that sort are bound, so the line names no digit that does nothing,
    // which the `1-3` this replaced did for a column between two that sort.
    // The arrows and the paging keys are answered and not listed, as in every
    // list prompt
    const keys = promptKeys<{ value: R } | void>();
    keys.on('up', () => moveBy(-1));
    keys.on('down', () => moveBy(1));
    keys.on('home', () => void (at = 0));
    keys.on('end', () => void (at = order.length - 1));
    keys.on('pageup', () => void (at = Math.max(0, at - page())));
    keys.on('pagedown', () => void (at = Math.min(order.length - 1, at + page())));
    keys.on('enter', () => ({ value: data[under()] as R }), {
      description: __`pick`,
      priority: 2,
    });
    for (const [column, sorts] of sortable.entries()) {
      if (sorts) {
        keys.on(String(column + 1), () => sortOn(column), {
          description: __`sort`,
          priority: 1,
        });
      }
    }

    const footer = promptFooter(keys, terminal.width, opts.back);
    const view = box(
      { class: 'sigil-prompt sigil-table-select', 'flex-direction': 'column' },
      ...[line, answer.under, header, list, position, footer].filter(
        (part): part is Element => part !== undefined
      )
    );

    /** Up or Down, wrapping if it may. */
    function moveBy(by: -1 | 1): void {
      const next = at + by;
      at =
        next < 0 || next >= order.length
          ? loop
            ? (next + order.length) % order.length
            : at
          : next;
    }

    /** A page, in rows: the window less one, so a row stays in view. */
    const page = (): number => Math.max(1, room().rows - 1);

    /**
     * How many body rows there are room for, and whether a line goes to saying
     * where in the table they are. The line is spent only when some rows are off
     * screen, so a table that fits is the table and nothing else.
     */
    const room = (): { footer: boolean; rows: number } => {
      // the key footer's row is kept back with the question's and the heading's
      const fits = promptListRows(
        opts.height,
        terminal.height,
        headRoom.lines + (head ? 1 : 0) + 1
      );
      const footer = data.length > fits && fits > 1;
      return { footer, rows: footer ? fits - 1 : fits };
    };

    /** The heading cells, with the arrow on the column that is sorted. */
    const headings = (): TableCell[] =>
      headers.map((heading, i) => {
        const shown =
          i === sortBy
            ? `${truncate(heading, Math.max(0, (widths[i] as number) - 2))} ${
                descending ? ARROW.descending : ARROW.ascending
              }`
            : heading;
        return { text: shown, width: stringWidth(shown) };
      });

    function draw(): void {
      const { footer, rows } = room();
      top = listWindow(order.length, at, rows, top);
      const visible = Math.max(1, Math.min(rows, order.length));

      for (const parent of header ? [header, list] : [list]) {
        while (parent.children.length > 0) {
          parent.removeChild(parent.children[0] as Element);
        }
      }
      header?.append(
        tableRowView(headings(), widths, columns, gap, 'sigil-table-head sigil-heading')
      );

      for (const [place, index] of order.entries()) {
        if (place < top || place >= top + visible) {
          continue;
        }
        const current = place === at;
        list.append(
          box(
            { class: current ? 'sigil-choice is-active sigil-accent' : 'sigil-choice' },
            // the pointer is on every row and `visibility` takes it off the others,
            // for the reason the choice list records: hidden content still takes
            // its space
            textNode(PROMPT_SYMBOLS.cursor, {
              class: current ? 'sigil-choice-pointer' : '',
              'margin-right': 1,
              visibility: current ? 'visible' : 'hidden',
              'white-space': 'nowrap',
            }),
            tableRowView(cells[index] as TableCell[], widths, columns, gap, 'sigil-table-cell')
          )
        );
      }

      position.setText(footer ? `${at + 1}/${order.length}` : '');
      position.setProps({ display: footer ? 'flex' : 'none' });
    }

    draw();

    return {
      key(k) {
        const done = keys.match(k)?.(k);
        if (done) {
          return done;
        }
        draw();
      },

      settle(row): void {
        promptAnswered(mark);
        answer.show(shortOf(data.indexOf(row)));
        header?.setProps({ display: 'none' });
        footer.setProps({ display: 'none' });
        list.setProps({ display: 'none' });
        position.setProps({ display: 'none' });
      },

      view,
    };
  });
}
