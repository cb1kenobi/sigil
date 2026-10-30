import { ansi as defaultAnsi } from '../ansi/index.js';
import {
  box,
  type Element,
  renderToString,
  text as textNode,
  toDisplayText,
} from '../element/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { stringWidth } from '../width/index.js';

export type Align = 'left' | 'right' | 'center';

export interface Column {
  /** How the cell is lined up. Defaults to `left`. */
  align?: Align;
  /** The heading. */
  header?: string;
  /** The widest the column may get before its cells are truncated. */
  maxWidth?: number;
  /** Which property of a row object this column shows. */
  key?: string;
}

export interface TableOptions extends StyledOptions {
  /** The columns. Inferred from the first row's keys when not given. */
  columns?: (Column | string)[];
  /** The columns between one column and the next. Defaults to 2. */
  gap?: number;
  /** How far the whole table is indented. Defaults to 0. */
  indent?: number;
  /** Whether to print the header row. Defaults to true when any column has one. */
  head?: boolean;
}

/**
 * A cell that is already a tree, such as what `badgeView()` returns.
 *
 * A string cell is text: its escape sequences are dropped, because a `text`
 * draws no control character, so a styled string put in one prints its `ESC`
 * removed and the rest as literal characters. A view is the one cell form that
 * keeps its own styling, and its `width` is what the column is measured with --
 * the table cannot ask a tree how wide it is without laying it out, which is the
 * work the declared widths exist to avoid.
 */
export interface TableCellView {
  /** The cell's tree. */
  element: Element;
  /** How many columns it takes. */
  width: number;
}

/** A row, however it was given. */
export type TableRow = readonly unknown[] | Record<string, unknown>;

/** A cell as the table holds it: what it draws, and how wide that is. */
interface Cell {
  text: string;
  view?: TableCellView;
  width: number;
}

/**
 * Whether a value is a view rather than something to print.
 *
 * Checked by shape and not by class, so a view from another copy of the package
 * is one, and a plain object a row happens to hold -- which prints as
 * `[object Object]` -- is not unless it has both fields.
 *
 * @param value - A cell.
 * @returns Whether it is a view.
 */
function isView(value: unknown): value is TableCellView {
  return (
    typeof value === 'object' &&
    value !== null &&
    'element' in value &&
    typeof (value as TableCellView).width === 'number' &&
    Number.isFinite((value as TableCellView).width)
  );
}

/**
 * The columns a set of rows has, and the cells under them.
 *
 * @param rows - The rows.
 * @param opts - The declared columns, if there are any.
 * @returns The columns, their cells, and their headings.
 */
function readRows(
  rows: readonly TableRow[],
  opts: TableOptions
): { cells: Cell[][]; columns: Column[]; headers: string[] } {
  // a column may be a name, a declaration, or nothing at all -- in which case
  // the first row says what the columns are
  const first = rows[0];
  const columns: Column[] = (
    opts.columns ??
    (Array.isArray(first)
      ? first.map(() => ({}))
      : Object.keys(first as Record<string, unknown>).map((key) => ({ header: key, key })))
  ).map((column) => (typeof column === 'string' ? { header: column, key: column } : column));

  const cells = rows.map((row) =>
    columns.map((column, i) => {
      const value = Array.isArray(row)
        ? row[i]
        : (row as Record<string, unknown>)[column.key ?? String(i)];
      if (isView(value)) {
        return { text: '', view: value, width: Math.max(0, Math.floor(value.width)) };
      }

      const shown = value === undefined || value === null ? '' : cellText(String(value));
      return { text: shown, width: stringWidth(shown) };
    })
  );

  return { cells, columns, headers: columns.map((column) => cellText(column.header ?? '')) };
}

/**
 * A cell as it will be drawn, on one line.
 *
 * Two things, and both are about the widths adding up. `toDisplayText()` is what
 * a `text` element will draw, and measuring anything else means a tab -- which
 * measures nothing and draws a space -- costs the column a column. And a newline
 * becomes a space, because a row of a table is a line: a cell two lines tall
 * would push every row after it down by one and leave the column beside it
 * looking at the wrong row.
 *
 * @param value - The cell.
 * @returns The cell, on one line, as it will be drawn.
 */
function cellText(value: string): string {
  return toDisplayText(value).replaceAll('\n', ' ');
}

/**
 * How wide each column comes out.
 *
 * The widest cell, the heading included, cut down to the column's `maxWidth`.
 * Measured in display columns rather than characters, so a CJK cell and an emoji
 * line up with everything else -- which is the same measurement the layout engine
 * takes, asked here because a *shared* column width is the one thing flexbox
 * cannot work out for itself: each row would size its own cells and no two rows
 * would agree.
 *
 * @param headers - The headings.
 * @param cells - The rows.
 * @param columns - The declarations.
 * @param head - Whether the heading row is shown.
 * @returns One width per column.
 */
function columnWidths(
  headers: string[],
  cells: Cell[][],
  columns: Column[],
  head: boolean
): number[] {
  return columns.map((column, i) => {
    const widest = Math.max(
      head ? stringWidth(headers[i]) : 0,
      ...cells.map((row) => row[i].width)
    );
    return column.maxWidth && column.maxWidth > 0 ? Math.min(widest, column.maxWidth) : widest;
  });
}

/**
 * One row of cells.
 *
 * Each cell is a `text` as wide as its column, which is what used to be
 * `padCell()`: a box the width of the column with the text aligned inside it is
 * the box model doing the padding, and the trailing blanks a left-aligned cell
 * leaves are dropped when the grid is read back as lines. `text-overflow` is what
 * used to be `truncateCell()`, and `white-space: nowrap` is what makes either
 * reachable -- a cell that wrapped would be a row two lines tall.
 *
 * @param values - The cells.
 * @param widths - The column widths.
 * @param columns - The declarations, for the alignment.
 * @param gap - The columns between one column and the next.
 * @param classes - What to put on each cell, for the heading row.
 * @returns The row.
 */
function rowOf(
  values: Cell[],
  widths: number[],
  columns: Column[],
  gap: number,
  classes: string
): Element {
  return box(
    { class: 'sigil-table-row', 'column-gap': gap, 'flex-shrink': 0 },
    ...values.map((value, i) =>
      value.view
        ? viewCell(value.view, widths[i], columns[i].align ?? 'left', classes)
        : textNode(value.text, {
            class: classes,
            // the declared width is kept whatever the row adds up to: a table is
            // sized to its content and a narrow terminal is allowed to wrap it,
            // which is what it has always done. Shrinking instead would put the
            // columns of one row somewhere the next row's are not
            'flex-shrink': 0,
            'text-align': columns[i].align ?? 'left',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
            width: widths[i],
          })
    )
  );
}

/** Where a view sits in a column wider than it, by the column's alignment. */
const JUSTIFY: Record<Align, string> = {
  center: 'center',
  left: 'flex-start',
  right: 'flex-end',
};

/**
 * A view as a cell: a box as wide as its column with the tree set inside it.
 *
 * The box is what a text cell's own width and `text-align` are, since a tree
 * has no alignment of its own -- and it clips, which is `text-overflow`'s
 * stand-in, because a tree cannot be cut with an ellipsis and a badge wider
 * than a `maxWidth` column is cut where the column ends.
 *
 * @param view - The cell.
 * @param width - The column's width.
 * @param align - The column's alignment.
 * @param classes - What the other cells of this row carry.
 * @returns The cell.
 */
function viewCell(view: TableCellView, width: number, align: Align, classes: string): Element {
  return box(
    {
      class: classes,
      'flex-shrink': 0,
      'justify-content': JUSTIFY[align],
      overflow: 'hidden',
      width,
    },
    view.element
  );
}

/**
 * Builds the element tree for a table.
 *
 * @param rows - The rows, as objects or as arrays of cells.
 * @param opts - The columns and the spacing.
 * @returns The tree, and how wide it wants to be.
 */
export function tableView(
  rows: readonly TableRow[],
  opts: TableOptions = {}
): { element: Element; width: number } {
  const gap = opts.gap === undefined ? 2 : Math.max(0, Math.floor(opts.gap));
  const indent = Math.max(0, Math.floor(opts.indent ?? 0));
  const { cells, columns, headers } = readRows(rows, opts);
  const head = opts.head ?? columns.some((column) => column.header !== undefined);
  const widths = columnWidths(headers, cells, columns, head);

  const body = rows.length
    ? cells.map((row) => rowOf(row, widths, columns, gap, 'sigil-table-cell'))
    : [];
  const children = head
    ? [
        rowOf(
          headers.map((header) => ({ text: header, width: stringWidth(header) })),
          widths,
          columns,
          gap,
          'sigil-table-head sigil-heading'
        ),
        ...body,
      ]
    : body;

  const natural =
    indent +
    widths.reduce((total, width) => total + width, 0) +
    gap * Math.max(0, widths.length - 1);

  return {
    element: box(
      { class: 'sigil-table', 'flex-direction': 'column', 'padding-left': indent },
      ...children
    ),
    width: Math.max(1, natural),
  };
}

/**
 * Lays a list of rows out in aligned columns.
 *
 * No borders: a build tool's table sits in a log next to everything else it
 * printed, and rules around it are noise. Columns are sized to their widest
 * cell, measured in display columns so that CJK text and emoji line up.
 *
 * A facade over `tableView()`: the tree is laid out by the layout engine and
 * painted onto a grid of its own, and what comes back is the grid read as lines.
 * The column arithmetic that used to live here is the box model now -- the width
 * of a cell is a declared width, its alignment is `text-align`, and a cell too
 * wide for its column is cut by `text-overflow`.
 *
 * @param rows - The rows, as objects or as arrays of cells.
 * @param opts - The columns and the spacing.
 * @returns The table, with no trailing newline.
 */
export function table(rows: readonly TableRow[], opts: TableOptions = {}): string {
  if (!rows.length) {
    return '';
  }

  const { element, width } = tableView(rows, opts);

  // as wide as it came out, which is what a table has always been: a cell longer
  // than the terminal runs past the edge and the terminal wraps it, rather than
  // every other column being squeezed for its benefit. A caller that wants a
  // column bounded says so with that column's `maxWidth`
  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    width,
  });
}
