import { ansi as defaultAnsi, type Ansi } from '../ansi/index.js';
import { stringWidth } from '../width/index.js';
import { graphemes } from '../width/index.js';

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

export interface TableOptions {
	/** The styler to mark up headings with. Defaults to the process's. */
	ansi?: Ansi;
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
 * Pads a cell to a column width, measuring columns rather than characters.
 *
 * `String.padEnd()` counts UTF-16 code units, so a CJK cell comes out half a
 * column short per character and an emoji one short -- which is the whole
 * reason the table does its own padding.
 *
 * @param text - The cell.
 * @param width - The column width.
 * @param align - How to line it up.
 * @returns The padded cell.
 */
export function padCell(text: string, width: number, align: Align = 'left'): string {
	const short = width - stringWidth(text);
	if (short <= 0) {
		return text;
	}

	if (align === 'right') {
		return ' '.repeat(short) + text;
	}

	if (align === 'center') {
		const left = Math.floor(short / 2);
		return ' '.repeat(left) + text + ' '.repeat(short - left);
	}

	return text + ' '.repeat(short);
}

/**
 * Cuts a cell down to a width, in columns, with an ellipsis where it was cut.
 *
 * Cut by grapheme cluster rather than by character: slicing a string in the
 * middle of a surrogate pair leaves half a code point, and slicing before a
 * combining mark leaves the mark to attach itself to whatever follows.
 *
 * @param text - The cell.
 * @param width - The most columns it may take.
 * @returns The cell, no wider than `width`.
 */
export function truncateCell(text: string, width: number): string {
	if (width <= 0) {
		return '';
	}
	if (stringWidth(text) <= width) {
		return text;
	}
	if (width === 1) {
		return '…';
	}

	let out = '';
	let used = 0;

	// one column is kept back for the ellipsis
	for (const cluster of graphemes(text)) {
		const w = stringWidth(cluster);
		if (used + w > width - 1) {
			break;
		}
		out += cluster;
		used += w;
	}

	return `${out}…`;
}

/**
 * Lays a list of rows out in aligned columns.
 *
 * No borders: a build tool's table sits in a log next to everything else it
 * printed, and rules around it are noise. Columns are sized to their widest
 * cell, measured in display columns so that CJK text and emoji line up.
 *
 * @param rows - The rows, as objects or as arrays of cells.
 * @param opts - The columns and the spacing.
 * @returns The table, with no trailing newline.
 */
export function table(
	rows: readonly (readonly unknown[] | Record<string, unknown>)[],
	opts: TableOptions = {}
): string {
	if (!rows.length) {
		return '';
	}

	const ansi = opts.ansi ?? defaultAnsi;
	const gap = opts.gap === undefined ? 2 : Math.max(0, Math.floor(opts.gap));
	const indent = ' '.repeat(Math.max(0, Math.floor(opts.indent ?? 0)));

	// a column may be a name, a declaration, or nothing at all -- in which case
	// the first row says what the columns are
	const first = rows[0];
	const declared: Column[] = (
		opts.columns ??
		(Array.isArray(first)
			? first.map(() => ({}))
			: Object.keys(first as Record<string, unknown>).map((key) => ({ header: key, key })))
	).map((column) => (typeof column === 'string' ? { header: column, key: column } : column));

	const cells: string[][] = rows.map((row) =>
		declared.map((column, i) => {
			const value = Array.isArray(row)
				? row[i]
				: (row as Record<string, unknown>)[column.key ?? String(i)];
			return value === undefined || value === null ? '' : String(value);
		})
	);

	const showHead = opts.head ?? declared.some((column) => column.header !== undefined);
	const headers = declared.map((column) => column.header ?? '');

	// widest cell per column, the heading included, then cut to `maxWidth`
	const widths = declared.map((column, i) => {
		const widest = Math.max(
			showHead ? stringWidth(headers[i]) : 0,
			...cells.map((row) => stringWidth(row[i]))
		);
		return column.maxWidth && column.maxWidth > 0 ? Math.min(widest, column.maxWidth) : widest;
	});

	/**
	 * Lays one row out.
	 *
	 * @param row - The cells.
	 * @param style - Applied to each cell, for the heading row.
	 * @returns The line, without trailing spaces.
	 */
	function line(row: string[], style?: (text: string) => string): string {
		const parts = row.map((cell, i) => {
			const cut = truncateCell(cell, widths[i]);
			const align = declared[i].align ?? 'left';

			// the last column is not padded, because trailing spaces are invisible
			// and make a copied line longer than what it shows. Only trailing ones:
			// a right or centre aligned cell is padded on the left, which is what
			// puts it where it belongs, so skipping that would un-align the column
			const trailing = i === row.length - 1 && align === 'left';
			const padded = trailing ? cut : padCell(cut, widths[i], align);

			return style ? style(padded) : padded;
		});

		return (indent + parts.join(' '.repeat(gap))).replace(/\s+$/, '');
	}

	const out = showHead ? [line(headers, (text) => ansi.bold(text))] : [];
	for (const row of cells) {
		out.push(line(row));
	}

	return out.join('\n');
}
