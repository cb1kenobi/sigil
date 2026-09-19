/**
 * The help screen as an element tree.
 *
 * What used to be `layout.ts` -- a two-column list with its own column widths,
 * its own padding and its own indent arithmetic -- is the box model now. A row
 * is a flex row; the label column is a declared width; the description takes
 * what is left and wraps in it; the indent is padding. None of that is help's to
 * work out any more, which was the point of moving it.
 *
 * What help still decides, because it is about *what help says* rather than how
 * it is drawn, is all here: which rows there are, what a label reads as, when a
 * label is too wide to share a line with its description, and when there is not
 * enough room for two columns at all.
 */

import { box, type Element, paragraph, text as textNode, type TextRun } from '../element/index.js';
import { stringWidth } from '../width/index.js';

/** One row of a two-column list: a term and what it means. */
export interface Definition {
	/** What it means, as runs, so a parenthetical can be dimmed. */
	desc?: readonly (TextRun | string)[];
	label: string;
}

export interface ListOptions {
	/** The columns between the label and its description. */
	gap: number;
	/** How far the labels are indented. */
	indent: number;
	/**
	 * The widest a label column is allowed to get before the descriptions start
	 * on their own lines instead. A long flag should not push every description
	 * into a gutter two columns wide.
	 */
	maxLabel: number;
	/** The column to wrap at. */
	width: number;
}

/**
 * The narrowest a description column may be before the list gives up on two
 * columns. Below this, wrapping is a word per line.
 */
const MIN_DESC = 20;

/**
 * A two-column list: the label on the left, its description in the column to
 * the right of it.
 *
 * A label too wide for the column takes a line of its own and its description
 * starts on the next one, which is the only way to keep the description column
 * from being squeezed to nothing by one long flag.
 *
 * @param items - The rows.
 * @param opts - Where the columns are.
 * @returns The list.
 */
export function definitions(items: readonly Definition[], opts: ListOptions): Element {
	const { gap, indent, maxLabel, width } = opts;

	// a label wider than the column is going to take a line of its own, so it
	// does not get to widen the column for everything else: one long flag would
	// otherwise leave every short one trailing twenty spaces before its
	// description
	const fitting = items.map((item) => stringWidth(item.label)).filter((w) => w <= maxLabel);
	const labelWidth = Math.max(...fitting, 0);
	const column = indent + labelWidth + gap;

	// when there is not enough room left for a description to read as prose, the
	// two columns become one: every label takes a line and its description is
	// indented under it. Wrapping to a handful of columns is a word per line, and
	// running past the terminal's edge is worse still
	const stacked = width - column < MIN_DESC;

	return box(
		{ 'flex-direction': 'column' },
		...items.map((item) => row(item, { column, gap, indent, labelWidth, maxLabel, stacked, width }))
	);
}

interface RowOptions extends ListOptions {
	/** Where a description starts, from the left margin. */
	column: number;
	/** How wide the label column came out. */
	labelWidth: number;
	/** Whether the list gave up on two columns. */
	stacked: boolean;
}

/**
 * One row of a definition list.
 *
 * @param item - The row.
 * @param opts - Where the columns are.
 * @returns The row.
 */
function row(item: Definition, opts: RowOptions): Element {
	const { column, gap, indent, labelWidth, stacked, width } = opts;
	const label = labelLines(item.label, width, indent);

	// a label wider than the room it has keeps its own width rather than being
	// stretched to the box it sits in: the grid a string is painted into is as
	// wide as what came out, so a flag name longer than the terminal survives and
	// the terminal wraps it -- which is the rule `labelLines()` records, and which
	// a box shrunk to the screen would silently turn into a truncation
	const labelWide = Math.max(...label.split('\n').map((line) => stringWidth(line)));
	const labelProps: Record<string, number | string> = {
		'flex-shrink': 0,
		'white-space': 'nowrap',
		// only where it overhangs, because a declared width is what stops the box
		// from being stretched to the column and the text from being cut off there;
		// where the label fits, its own content is already the answer
		...(labelWide > labelWidth ? { width: labelWide } : {}),
	};

	if (!item.desc?.length) {
		return box(
			{ 'align-items': 'flex-start', 'padding-left': indent },
			textNode(label, labelProps)
		);
	}

	if (stacked) {
		// the one-column fallback: a label per line, its description under it
		return box(
			{ 'align-items': 'flex-start', 'flex-direction': 'column', 'padding-left': indent },
			textNode(label, labelProps),
			// at least the padding and a column to put something in: a caller that
			// set an `indent` as wide as the screen left the description a border-box
			// width its own padding ate, and every description disappeared
			description(item.desc, { 'padding-left': 2, width: Math.max(3, width - indent) })
		);
	}

	if (stringWidth(item.label) > labelWidth) {
		// the label does not fit its column, so it takes the line and the whole
		// description starts on the next one, in the column it would have been in
		return box(
			{ 'align-items': 'flex-start', 'flex-direction': 'column', 'padding-left': indent },
			textNode(label, labelProps),
			description(item.desc, {
				'padding-left': labelWidth + gap,
				width: Math.max(labelWidth + gap + 1, width - indent),
			})
		);
	}

	return box(
		{ 'column-gap': gap, 'flex-direction': 'row', 'padding-left': indent },
		// the label keeps its column whatever the description needs, which is what
		// lines the descriptions up: shrinking it is what `flex-shrink: 0` refuses
		textNode(item.label, { 'flex-shrink': 0, 'white-space': 'nowrap', width: labelWidth }),
		description(item.desc, { width: Math.max(1, width - column) })
	);
}

/**
 * A description, which wraps in the column the label left it.
 *
 * Told that width rather than growing into it, and the difference is a
 * measurement rather than a preference: a row's intrinsic height is taken with
 * every child offered the whole content box, while placement hands each one a
 * share -- so a description that wraps to three lines in its share measures two
 * lines tall in the room it was offered, and the block after it is drawn over
 * the third. A declared width is measured at the width it will be placed at,
 * which is the whole of what this needs. Help knows where its columns are: that
 * is the one piece of arithmetic it kept, and it is one subtraction rather than
 * the padding, the wrapping and the alignment it gave up.
 *
 * @param runs - What it says.
 * @param props - The width, and any indent.
 * @returns The description.
 */
function description(runs: readonly (TextRun | string)[], props: Record<string, number>): Element {
	return paragraph(runs, { 'flex-shrink': 0, ...props });
}

/**
 * A label on lines of its own, broken after its commas when it does not fit.
 *
 * After commas and nowhere else, because a label is one of two things: a list of
 * names, which breaks between them, or a name and its hint, which does not.
 * Breaking `--target [name]` at the space would read as two separate things, and
 * breaking inside `--target` would give a flag nobody can type.
 *
 * So a single name wider than the width is printed whole and runs past the edge.
 * That is the better of the two failures: the name survives.
 *
 * Handed back as one string with newlines in it rather than as several elements,
 * because that is what `white-space: nowrap` reads -- the break is the label's
 * own and not one the wrapper is free to move.
 *
 * @param label - The label.
 * @param width - The column to wrap at.
 * @param indent - How far the label is indented, which is room it does not have.
 * @returns The label, with its own line breaks in it.
 */
export function labelLines(label: string, width: number, indent: number): string {
	const room = Math.max(width - indent, 1);

	if (stringWidth(label) <= room) {
		return label;
	}

	const parts = label.split(', ');
	const lines: string[] = [];
	let line = '';

	for (const [index, part] of parts.entries()) {
		const piece = index < parts.length - 1 ? `${part},` : part;
		const candidate = line === '' ? piece : `${line} ${piece}`;

		if (line !== '' && stringWidth(candidate) > room) {
			lines.push(line);
			line = piece;
		} else {
			line = candidate;
		}
	}

	if (line !== '') {
		lines.push(line);
	}

	return lines.join('\n');
}

/**
 * A titled list.
 *
 * @param title - The heading.
 * @param items - The rows.
 * @param opts - Where the columns are.
 * @returns The block.
 */
export function section(title: string, items: readonly Definition[], opts: ListOptions): Element {
	return box({ 'flex-direction': 'column' }, heading(title), definitions(items, opts));
}

/**
 * A heading, which is a paragraph so that a long one wraps like anything else.
 *
 * @param title - The heading, without its colon.
 * @returns The heading.
 */
export function heading(title: string): Element {
	return paragraph([{ class: 'sigil-help-heading', text: `${title}:` }]);
}

/**
 * A labelled line whose continuation hangs under the first word rather than
 * under the left margin: `Usage:` and `Alias:`.
 *
 * A flex row of a label and a paragraph *is* a hanging indent, which is why
 * there is no such option anywhere here: the paragraph's box starts after the
 * label and every line of it starts at that box's left edge.
 *
 * @param label - The label, which is bold.
 * @param runs - The rest of the line.
 * @param width - The column to wrap at.
 * @returns The block.
 */
export function hanging(
	label: string,
	runs: readonly (TextRun | string)[],
	width: number
): Element {
	return box(
		{ 'column-gap': 1, 'flex-direction': 'row' },
		textNode(label, { class: 'sigil-help-heading', 'flex-shrink': 0, 'white-space': 'nowrap' }),
		paragraph(runs, {
			'flex-shrink': 0,
			width: Math.max(1, width - stringWidth(label) - 1),
		})
	);
}
