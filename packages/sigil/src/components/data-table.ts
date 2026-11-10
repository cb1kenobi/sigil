/**
 * A data table: a list view whose rows have columns, a heading that sorts them,
 * and rows that can change every second without the selection moving.
 *
 * htop's process list, k9s's resource view and a database client's result grid.
 * `table()` prints, `tableView()` is static and `selectRow()` is a prompt; this is
 * the element.
 *
 * ```js
 * import { DataTable } from '@ttylabs/sigil/components/data-table';
 *
 * const procs = DataTable({
 *   rows: processes, // a State or a Computed is followed
 *   key: (p) => p.pid,
 *   columns: [
 *     { key: 'pid', header: 'PID', align: 'right' },
 *     { key: 'cpu', header: 'CPU%', align: 'right', descendingFirst: true },
 *     { key: 'name', header: 'NAME', grow: 1, minWidth: 8 },
 *   ],
 *   sort: { column: 'cpu', descending: true },
 *   props: { height: 20 },
 * });
 * ```
 *
 * It is built **on** `ListView` rather than beside it: the rows are a list's rows,
 * so the windowing, the cursor and the selection by key, and what happens to them
 * when the data changes, are the list's answers and not a second copy of them.
 * What the table adds is the heading, the order the rows are handed to the list
 * in, and the column widths. `AGENTS.md` has the reasons under "A data table".
 */

import { box, type Element, type ElementPropsWithout, toDisplayLine } from '../element/index.js';
import { __ } from '../i18n/index.js';
import type { DescribeOptions, KeyEvent, MouseEvent } from '../input/index.js';
import { createEffect } from '../renderer/index.js';
import { Computed, State, untrack } from '../signals/index.js';
import { stringWidth } from '../width/index.js';
import { truncate } from '../wrap/index.js';
import {
  describeListView,
  type ListControl,
  listControl,
  type ListItems,
  listRowInset,
  ListView,
} from './list-view.js';
import { unicodeSupported } from './note.js';
import { refuseOwnedHooks } from './owned-hooks.js';
import type { SelectRowColumn } from './select-row.js';
import {
  cellOrder,
  type TableCell,
  tableCell,
  type TableCellView,
  type TableRow,
  tableRowView,
  tableValue,
  tableWidths,
} from './table.js';

/**
 * A column: `selectRow()`'s, which is `table()`'s with a sort, and what an element
 * that is laid out again whenever the terminal changes needs to know about width.
 *
 * A column is named by its `key`, which is also the property of a row object it
 * reads, or by its place among the columns -- `'0'`, `'1'` -- where it has none.
 * That name is what a {@link DataTableSort} says it sorts by.
 */
export interface DataTableColumn<T = TableRow> extends SelectRowColumn {
  /**
   * Whether the first sort by this column runs from the largest down, for a column
   * whose interesting end is the top: CPU, memory, a date. A second sort runs the
   * other way and a third clears it, as for every column. Defaults to `false`.
   */
  descendingFirst?: boolean;
  /**
   * What the cell draws, from the value it holds: a string, or a `TableCellView`
   * such as `badgeView()` returns. Defaults to the value itself -- a view drawn as
   * one, anything else as text. The sort reads the value and never this, so a
   * column can draw `1.2 GB` and order by the bytes.
   */
  format?: (value: unknown, row: T) => string | TableCellView;
  /**
   * How much of the room left over this column takes, against the other columns'
   * `grow`, once every column shown has its width. Defaults to `0`. A name or a
   * command line is the usual one: the column that has more to say the wider it is.
   */
  grow?: number;
  /**
   * The narrowest this column gives way to before any column is hidden. Defaults
   * to its width, so a column does not narrow unless it says it may.
   */
  minWidth?: number;
  /**
   * Which columns are hidden first when the table is too narrow for them all: the
   * lowest `priority`, and among equals the one furthest right. Defaults to `0`.
   * The first column kept is never hidden.
   */
  priority?: number;
  /**
   * What the cell holds, for a row the column cannot read by `key` -- a computed
   * value, a nested one. The sort orders by this. Defaults to the row's `key`
   * property, or its place in an array row.
   */
  value?: (row: T) => unknown;
  /**
   * The column's width, declared rather than measured. Left out, the column is as
   * wide as its heading and the widest cell it has held, up to `maxWidth`.
   * Declaring it is what a large or a fast-changing table wants: a measured column
   * formats every row it has not seen before.
   */
  width?: number;
}

/** What a table is sorted by: a column's name, and which way. */
export interface DataTableSort {
  /** The column's `key`, or its place among the columns for one with no `key`. */
  column: string;
  /** From the largest down. Defaults to `false`. */
  descending?: boolean;
}

/** What a table reads its columns from: an array, or a `State` or a `Computed` of one. */
export type DataTableColumns<T> =
  | readonly (DataTableColumn<T> | string)[]
  | ListItems<DataTableColumn<T> | string>;

export interface DataTableProps<T, K = T> {
  /** Draw the pointer, the marks and the sort arrow with ASCII only. */
  ascii?: boolean;
  /**
   * The columns, in the order they are drawn. A string is a column whose heading
   * and `key` are that string. A `State` or a `Computed` of them is followed, which
   * is how an app hides a column, adds one or changes a width: replace the array.
   */
  columns: DataTableColumns<T>;
  /** The current row, as its key, or the state that holds it: `ListView`'s `current`. */
  current?: K | State<K | undefined>;
  /** Whether a row is disabled: drawn muted and passed over, as in a list. */
  disabled?: (row: T) => boolean;
  /** What to show under the heading when there are no rows. Defaults to "Nothing to show". */
  empty?: string | (() => Element);
  /**
   * Whether the cursor follows its row when the rows re-sort or update. Defaults to
   * `false`: the cursor stays where it is on screen and takes whichever row is
   * there now, which is htop's default -- a table sorted by a live column re-sorts
   * every tick, and a highlight that moved with its row would jump each second.
   * `true` keeps it on the row's key wherever that row goes, `ListView`'s default.
   * A `State` can be toggled while the table is up, as htop's `F` does.
   */
  follow?: boolean | State<boolean>;
  /** The columns between one column and the next. Defaults to 2, as for `table()`. */
  gap?: number;
  /** Whether to draw the heading. Defaults to `true` when any column has one. */
  head?: boolean;
  /**
   * What identifies a row, which the cursor and the selection hold. Defaults to
   * the row itself, which is right for rows that are never replaced; rows fetched
   * again every second -- a process list -- want their own id here, or the cursor
   * loses its row on every update.
   */
  key?: (row: T) => K;
  /** Whether more than one row can be selected, as in a list. */
  multiple?: boolean;
  /** Called with the current row's key and the row on Enter or a double-click. */
  onActivate?: (key: K, row: T) => void;
  /** The host box's own props: a height, a border, a class. */
  props?: ElementPropsWithout<'onKey' | 'onResize'>;
  /**
   * The rows. An array is fixed; a `State` or a `Computed` is followed, keeping the
   * cursor and the selection on their keys and rebuilding the rows on screen whose
   * row is a different object than before. Replace the array to change it, and
   * replace a row to change that row.
   */
  rows: readonly T[] | ListItems<T>;
  /** Whether to draw a scrollbar. Defaults to `true`. */
  scrollbar?: boolean;
  /** The selected rows, as keys, or the state that holds them: `ListView`'s `selected`. */
  selected?: Iterable<K> | State<ReadonlySet<K>>;
  /**
   * What the rows are sorted by, or the state that holds it: a value is where it
   * starts, a `State` is the state itself, which a click on a heading and a digit
   * write and an app may write. Left out, the rows are in the order they came.
   */
  sort?: DataTableSort | State<DataTableSort | undefined>;
  /** `j`, `k`, `g` and `G`, as in a list. */
  vim?: boolean;
}

/** What a component built on a table holds it by: the list's control, and the sort. */
export interface DataTableControl<K> extends ListControl<K> {
  /** The list the rows are in, which is the element that takes the focus. */
  readonly list: Element;
  /**
   * Measures the columns again from every row and builds the rows in view again,
   * for rows changed in place. Rows replaced by new objects need no call.
   */
  refresh(): void;
  /** The names of the columns on screen, in order: what a narrow table kept. */
  shown(): readonly string[];
  /** What the rows are sorted by. */
  readonly sort: State<DataTableSort | undefined>;
  /**
   * Sorts by a column as a click on its heading does: the first time in its first
   * direction, the second the other way, and the third back to the order the rows
   * came in.
   *
   * @returns Whether the column sorts -- `false` for one that is `sortable: false`
   *   or is not a column.
   */
  sortBy(column: string): boolean;
}

/** Where a table's keys are described, which is the whole of what is asked of a router. */
export interface DataTableDescriber {
  describe(keys: string, opts: DescribeOptions): () => void;
}

/** One column to fit: its width, how far it may narrow, its share of the rest, its rank. */
export interface FitColumn {
  /** Its share of the room left over. Defaults to 0. */
  grow?: number;
  /** The narrowest it gives way to before a column is hidden. */
  min: number;
  /** Lower is hidden first. Defaults to 0. */
  priority?: number;
  /** The width it wants. */
  width: number;
}

/** The marks on a sorted heading. */
const ARROWS = {
  ascii: { ascending: '^', descending: 'v' },
  unicode: { ascending: '▲', descending: '▼' },
} as const;

/** How many columns a digit can reach. */
const DIGITS = 9;

/**
 * Fits columns into a width: which are shown, and how wide each is.
 *
 * Three steps, in an order that is the decision. **Hide** first, but only while
 * even the columns' minimums do not fit: the lowest `priority` goes, and among
 * equals the one furthest right, and the last column standing is never hidden.
 * **Narrow** next, toward each column's `min`, one cell at a time from whichever
 * column has the most to give -- so two columns that may narrow give way evenly,
 * and the rightmost first where they tie. **Grow** last, handing what is left over
 * to the columns with a `grow`, in proportion, the remainder from the left.
 *
 * Exported because the arithmetic is worth asserting on its own, which is the
 * reason `rowWindow()` and `fitKeyHelp()` are.
 *
 * @param columns - The columns, in order.
 * @param room - The columns there are, or `Infinity` where nothing has said yet.
 * @param gap - The columns between one column and the next.
 * @returns Each column's width, or `undefined` for a column that is hidden.
 */
export function fitColumns(
  columns: readonly FitColumn[],
  room: number,
  gap: number
): (number | undefined)[] {
  const shown = columns.map((_, i) => i);
  const width = columns.map((column) => Math.max(0, Math.floor(column.width)));
  const min = columns.map((column, i) =>
    Math.min(width[i] as number, Math.max(0, Math.floor(column.min)))
  );
  const total = (of: readonly number[]): number =>
    shown.reduce((sum, i) => sum + (of[i] as number), 0) + gap * Math.max(0, shown.length - 1);

  if (!Number.isFinite(room)) {
    return width;
  }
  const space = Math.max(0, Math.floor(room));

  while (shown.length > 1 && total(min) > space) {
    // the lowest priority, and the one furthest right among equals
    let drop = 0;
    for (let at = 1; at < shown.length; at++) {
      const rank = columns[shown[at] as number]?.priority ?? 0;
      if (rank <= (columns[shown[drop] as number]?.priority ?? 0)) {
        drop = at;
      }
    }
    shown.splice(drop, 1);
  }

  let over = total(width) - space;
  while (over > 0) {
    let give = -1;
    for (const i of shown) {
      const slack = (width[i] as number) - (min[i] as number);
      if (slack > 0 && (give < 0 || slack >= (width[give] as number) - (min[give] as number))) {
        give = i;
      }
    }
    if (give < 0) {
      break;
    }
    width[give] = (width[give] as number) - 1;
    over--;
  }

  const spare = space - total(width);
  const growing = shown.filter((i) => (columns[i]?.grow ?? 0) > 0);
  const weight = growing.reduce((sum, i) => sum + (columns[i]?.grow ?? 0), 0);
  if (spare > 0 && weight > 0) {
    let left = spare;
    for (const i of growing) {
      const share = Math.floor((spare * (columns[i]?.grow ?? 0)) / weight);
      width[i] = (width[i] as number) + share;
      left -= share;
    }
    for (let n = 0; left > 0; n++, left--) {
      const i = growing[n % growing.length] as number;
      width[i] = (width[i] as number) + 1;
    }
  }

  return columns.map((_, i) => (shown.includes(i) ? width[i] : undefined));
}

/** A column as the table holds it. */
interface Spec<T> {
  column: DataTableColumn<T>;
  /** The heading as drawn, before an arrow. */
  heading: string;
  id: string;
  index: number;
  sortable: boolean;
}

/** Which columns are on screen, and how wide each is. */
interface Layout {
  shown: readonly number[];
  widths: readonly number[];
}

interface Model {
  control: DataTableControl<unknown>;
  /** Which digits sort, for the describer: one per sortable column on screen. */
  digits: State<readonly number[]>;
  list: Element;
}

/** Each table's control, keyed by the host `DataTable()` returned. */
const MODELS = new WeakMap<Element, Model>();

/**
 * Builds a data table.
 *
 * @param props - The rows, the columns, the sort, the selection, and the host's props.
 * @returns The host element. The list inside it takes the focus, and Tab reaches it.
 */
export function DataTable<T, K = T>(props: DataTableProps<T, K>): Element {
  refuseOwnedHooks('DataTable', props.props, ['onKey', 'onResize']);
  const isSource = (value: unknown): boolean =>
    Array.isArray(value) || typeof (value as { get?: unknown } | undefined)?.get === 'function';
  if (!isSource(props.rows)) {
    throw new TypeError(__`Expected data table rows to be an array, a State or a Computed`);
  }
  if (!isSource(props.columns)) {
    throw new TypeError(__`Expected data table columns to be an array, a State or a Computed`);
  }
  for (const name of ['disabled', 'key', 'onActivate'] as const) {
    if (props[name] !== undefined && typeof props[name] !== 'function') {
      throw new TypeError(__`Expected data table ${name} to be a function`);
    }
  }

  const readRows = (): readonly T[] =>
    Array.isArray(props.rows) ? props.rows : (props.rows as ListItems<T>).get();
  const readColumns = (): readonly (DataTableColumn<T> | string)[] =>
    Array.isArray(props.columns)
      ? props.columns
      : (props.columns as ListItems<DataTableColumn<T> | string>).get();
  const gap = props.gap === undefined ? 2 : Math.max(0, Math.floor(props.gap));
  const ascii = props.ascii ?? !unicodeSupported();
  const arrows = ascii ? ARROWS.ascii : ARROWS.unicode;
  const multiple = props.multiple === true;
  const inset = listRowInset({ ascii, multiple });
  const gutter = props.scrollbar === false ? 0 : 1;

  const specs = new Computed<readonly Spec<T>[]>(() => {
    const seen = new Set<string>();
    return readColumns().map((given, index) => {
      const column: DataTableColumn<T> =
        typeof given === 'string' ? { header: given, key: given } : given;
      for (const name of ['compare', 'format', 'value'] as const) {
        if (column[name] !== undefined && typeof column[name] !== 'function') {
          throw new TypeError(__`Expected data table column ${name} to be a function`);
        }
      }
      const id = column.key ?? String(index);
      if (seen.has(id)) {
        throw new TypeError(
          __`Expected every data table column to have a name of its own: ${id} is used twice`
        );
      }
      seen.add(id);
      return {
        column,
        heading: toDisplayLine(column.header ?? ''),
        id,
        index,
        sortable: column.sortable ?? true,
      };
    });
  });
  const headOf = (list: readonly Spec<T>[]): boolean =>
    props.head ?? list.some((spec) => spec.column.header !== undefined);

  const sort =
    props.sort instanceof State ? props.sort : new State<DataTableSort | undefined>(props.sort);
  const initial = untrack(() => sort.get());
  if (
    initial !== undefined &&
    !untrack(() => specs.get()).some((spec) => spec.id === initial.column)
  ) {
    throw new TypeError(
      __`Expected data table sort to name a column: ${String(initial.column)} is not one`
    );
  }

  const valueOf = (row: T, spec: Spec<T>): unknown =>
    spec.column.value
      ? spec.column.value(row)
      : tableValue(row as unknown as TableRow, spec.column, spec.index);
  const cellOf = (row: T, spec: Spec<T>): TableCell => {
    const value = valueOf(row, spec);
    return tableCell(spec.column.format ? spec.column.format(value, row) : value);
  };

  // -- the order the rows are handed to the list in ------------------------------

  const sorted = new Computed<readonly T[]>(() => {
    const all = readRows();
    const by = sort.get();
    const spec = by === undefined ? undefined : specs.get().find((s) => s.id === by.column);
    if (spec === undefined || !spec.sortable) {
      return all;
    }
    const order = cellOrder(spec.column.compare, by?.descending === true);
    // each value read once rather than once per comparison, and the sort is
    // stable, so rows that tie keep the order the app handed them in -- which is
    // what stops two processes at 0.0% trading places every second
    return all
      .map((row) => ({ row, value: valueOf(row, spec) }))
      .sort((a, b) => order(a.value, b.value))
      .map((entry) => entry.row);
  });

  // -- the widths ------------------------------------------------------------------

  /** The columns the widths were measured for; a new set starts again. */
  let measuredFor: readonly Spec<T>[] | undefined;
  /** Each column's widest, heading included: only ever grows. */
  let widest: number[] = [];
  /** The row objects already measured, so an update measures only what is new. */
  let seen = new WeakSet<object>();
  /** The columns the layout last had room for, in cells; `Infinity` before one. */
  let room = Number.POSITIVE_INFINITY;
  let layout: Layout = { shown: [], widths: [] };
  /** The list, once it is built: the first layout is worked out before it is. */
  let built: ListControl<K> | undefined;
  const digits = new State<readonly number[]>([]);

  /**
   * Measures the rows not measured yet, and keeps the widest each column has held.
   * `tableWidths()` does the measuring, over the new rows and the heading.
   */
  const measure = (list: readonly Spec<T>[], rows: readonly T[]): void => {
    if (list !== measuredFor) {
      measuredFor = list;
      widest = list.map(() => 0);
      seen = new WeakSet();
      // a new column set is a new layout even where it fits to the same columns at
      // the same widths: swapped columns, a new format or align, a column that stopped
      // sorting -- so `relayout()` has nothing to call the same, and rebuilds the rows
      // in view and the digits rather than leaving them drawn with the old columns
      layout = { shown: [], widths: [] };
    }
    const head = headOf(list);
    const fresh = rows.filter((row) => {
      if (typeof row !== 'object' || row === null) {
        return true;
      }
      if (seen.has(row)) {
        return false;
      }
      seen.add(row);
      return true;
    });
    // a column with a declared width is never measured, so its cells are not
    // even formatted: a column of badges builds no badge to be measured
    const blank: TableCell = { text: '', width: 0 };
    const cells = fresh.map((row) =>
      list.map((spec) => (spec.column.width === undefined ? cellOf(row, spec) : blank))
    );
    const measured = tableWidths(
      // a sortable heading keeps two columns back for its arrow, so turning a sort
      // on does not move every column to its right -- `selectRow()`'s rule
      list.map((spec) => (head && spec.sortable ? `${spec.heading}  ` : spec.heading)),
      cells,
      list.map((spec) => ({ maxWidth: spec.column.maxWidth })),
      head
    );
    widest = widest.map((was, i) => Math.max(was, measured[i] as number));
  };

  /** Fits the columns into the room, and redraws whatever that changed. */
  const relayout = (): boolean => {
    const list = untrack(() => specs.get());
    const fitted = fitColumns(
      list.map((spec, i) => {
        const { grow, maxWidth, minWidth, priority, width: declared } = spec.column;
        let width = declared ?? (widest[i] as number);
        if (declared === undefined && maxWidth !== undefined && maxWidth > 0) {
          width = Math.min(width, maxWidth);
        }
        width = Math.max(width, minWidth ?? 0);
        return { grow, min: minWidth ?? width, priority, width };
      }),
      room,
      gap
    );
    const shown: number[] = [];
    const widths: number[] = [];
    for (const [i, width] of fitted.entries()) {
      if (width !== undefined) {
        shown.push(i);
        widths.push(width);
      }
    }
    const same =
      shown.length === layout.shown.length &&
      shown.every((at, n) => at === layout.shown[n] && widths[n] === layout.widths[n]);
    if (same) {
      return false;
    }
    layout = { shown, widths };
    digits.set(shown.filter((i) => i < DIGITS && (list[i] as Spec<T>).sortable));
    drawHead();
    built?.refresh();
    return true;
  };

  // -- the heading -------------------------------------------------------------

  const header = box({
    class: 'sigil-data-table-head',
    'flex-direction': 'row',
    'flex-shrink': 0,
  });

  function sortBy(id: string): boolean {
    const spec = untrack(() => specs.get()).find((s) => s.id === id);
    if (spec === undefined || !spec.sortable) {
      return false;
    }
    const now = untrack(() => sort.get());
    const first = spec.column.descendingFirst === true;
    // the three states a column can be in, `selectRow()`'s: its first direction,
    // the other one, and back to the order the rows came in
    sort.set(
      now?.column !== id
        ? { column: id, descending: first }
        : (now.descending === true) === first
          ? { column: id, descending: !first }
          : undefined
    );
    return true;
  }

  function drawHead(): void {
    const list = untrack(() => specs.get());
    const by = untrack(() => sort.get());
    while (header.children.length > 0) {
      header.removeChild(header.children[0] as Element);
    }
    const head = headOf(list);
    header.setProps({ display: head ? 'flex' : 'none' });
    if (!head) {
      return;
    }
    const columns = layout.shown.map((i) => (list[i] as Spec<T>).column);
    const headings = layout.shown.map((i, n): TableCell => {
      const spec = list[i] as Spec<T>;
      const width = layout.widths[n] as number;
      const shown =
        by?.column === spec.id && spec.sortable
          ? `${truncate(spec.heading, Math.max(0, width - 2))} ${
              by.descending === true ? arrows.descending : arrows.ascending
            }`
          : spec.heading;
      return { text: shown, width: stringWidth(shown) };
    });
    const row = tableRowView(
      headings,
      layout.widths as number[],
      columns,
      gap,
      'sigil-table-head sigil-heading'
    );
    for (const [n, cell] of row.children.entries()) {
      const spec = list[layout.shown[n] as number] as Spec<T>;
      cell.toggleClass('is-sorted', by?.column === spec.id);
      if (!spec.sortable) {
        continue;
      }
      cell.addClass('is-sortable');
      // the click and not the press, as a list row takes it
      cell.onMouse = (event: MouseEvent): void => {
        if (event.kind === 'click' && event.button === 'left') {
          event.stop();
          sortBy(spec.id);
        }
      };
    }
    header.append(box({ class: 'sigil-data-table-inset', 'flex-shrink': 0, width: inset }), row);
  }

  // -- the rows ------------------------------------------------------------------

  // measured and laid out before the list is built, so its first rows are built
  // at the widths they will keep
  createEffect(() => {
    const list = specs.get();
    const rows = readRows();
    untrack(() => {
      measure(list, rows);
      relayout();
    });
  });

  const list_ = ListView<T, K>({
    ascii,
    current: props.current,
    disabled: props.disabled,
    empty: props.empty,
    follow: props.follow ?? false,
    items: sorted,
    key: props.key,
    multiple,
    onActivate: props.onActivate,
    props: {
      class: 'sigil-data-table-body',
      'flex-basis': 0,
      'flex-grow': 1,
      'min-height': 0,
    },
    row: (row) => {
      const list = untrack(() => specs.get());
      const columns = layout.shown.map((i) => list[i] as Spec<T>);
      return tableRowView(
        columns.map((spec) => cellOf(row, spec)),
        layout.widths as number[],
        columns.map((spec) => spec.column),
        gap,
        'sigil-table-cell'
      );
    },
    scrollbar: props.scrollbar,
    vim: props.vim,
  });
  const control = listControl<K>(list_) as ListControl<K>;
  built = control;

  createEffect(() => {
    sort.get();
    specs.get();
    untrack(drawHead);
  });

  const host = box({ ...props.props, 'flex-direction': 'column' });
  host.addClass('sigil-data-table');
  host.append(header, list_);

  host.onResize = (element): boolean => {
    const size = element.content ?? element.box;
    room = size === undefined ? Number.POSITIVE_INFINITY : Math.max(0, size.width - inset - gutter);
    return relayout();
  };

  // a digit sorts by the column it numbers, as `selectRow()`'s do; it reaches here
  // from the list, which claims no digit, and a column that is hidden or does not
  // sort leaves its digit to whatever is around the table
  host.onKey = (event: KeyEvent): void => {
    const k = event.key;
    if (event.paste || k.ctrl || k.meta || !/^[1-9]$/.test(k.name)) {
      return;
    }
    const index = Number(k.name) - 1;
    const spec = untrack(() => specs.get())[index];
    if (spec === undefined || !layout.shown.includes(index) || !sortBy(spec.id)) {
      return;
    }
    event.stop();
  };

  MODELS.set(host, {
    control: {
      activate: () => control.activate(),
      list: list_,
      refresh(): void {
        // forgetting the measurement forgets the layout too, so this always
        // rebuilds the rows in view, whether or not a width moved
        measuredFor = undefined;
        measure(
          untrack(() => specs.get()),
          untrack(readRows)
        );
        relayout();
      },
      reveal: (key) => control.reveal(key as K | undefined),
      scroll: control.scroll,
      selection: control.selection as ListControl<unknown>['selection'],
      shown: () => layout.shown.map((i) => (untrack(() => specs.get())[i] as Spec<T>).id),
      sort,
      sortBy,
    },
    digits,
    list: list_,
  });

  return host;
}

/**
 * The control of a table: the list's -- `selection`, `scroll`, `reveal()`,
 * `activate()` -- and `list`, `sort`, `sortBy()`, `shown()` and `refresh()`.
 *
 * @param host - What `DataTable()` returned.
 * @returns The control, or `undefined` for an element no table built.
 */
export function dataTableControl<K = unknown>(host: Element): DataTableControl<K> | undefined {
  return MODELS.get(host)?.control as DataTableControl<K> | undefined;
}

/**
 * Describes a table's keys to a router, for a key-help footer.
 *
 * The list's keys, as `describeListView()` describes them, and a digit for each
 * column on screen that sorts -- which a footer folds into one line, `1/2/3
 * sort`. The digits follow the columns: a column a narrow terminal hid has its
 * digit taken off, and put back when it returns, so the footer never names a
 * digit that does nothing.
 *
 * @param router - What to describe the keys to.
 * @param tables - Hosts that `DataTable()` returned.
 * @returns Takes every description back off.
 */
export function describeDataTable(
  router: DataTableDescriber,
  ...tables: readonly Element[]
): () => void {
  const found = tables.map((host) => {
    const model = MODELS.get(host);
    if (model === undefined) {
      throw new TypeError(__`Expected an element that DataTable() returned`);
    }
    return model;
  });

  const off: Array<() => void> = [];
  for (const model of found) {
    off.push(describeListView(router, model.list));
    // an effect, so a column a resize hid or brought back takes its digit with it
    off.push(
      createEffect(() => {
        const digits = model.digits.get();
        const described = untrack(() =>
          digits.map((i) =>
            router.describe(String(i + 1), {
              description: __`sort`,
              priority: 1,
              scope: model.list,
            })
          )
        );
        return () => {
          for (const fn of described) {
            fn();
          }
        };
      })
    );
  }

  return () => {
    for (const fn of off) {
      fn();
    }
  };
}
