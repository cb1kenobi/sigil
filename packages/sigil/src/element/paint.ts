/**
 * The two passes that put an element tree on screen: arrange, then paint.
 *
 * Arrange runs the layout engine over the tree and writes each box back onto the
 * element that earned it. Paint walks the result in document order and draws
 * backgrounds, borders, text, and whatever a `raw` element draws for itself.
 *
 * What is deliberately not here: clipping, `overflow`, and `z-index`, which are
 * SIG-64's. Paint order is document order, and a box that overflows its parent
 * is drawn where the layout put it -- which is what `checkInvariants()` allows
 * and what the layout engine already documents itself as producing.
 */

import { ATTR, DEFAULT_COLOR, type Painter, type Style as CellStyle } from '../canvas/index.js';
import { type Box, type LayoutOptions, type LayoutResult, layout } from '../layout/index.js';
import type { Style } from '../style/index.js';
import { stringWidth } from '../width/index.js';
import { wrap } from '../wrap/index.js';
import type { Element } from './index.js';

/**
 * The characters each border style is drawn with.
 *
 * Top-left, top, top-right, right, bottom-right, bottom, bottom-left, left. The
 * property is named for a character set rather than for a rendering mode --
 * `solid` and `dashed` mean nothing to a terminal -- so this table is the whole
 * of what `border-style` means.
 */
const BORDERS: Record<string, readonly string[]> = {
	ascii: ['+', '-', '+', '|', '+', '-', '+', '|'],
	bold: ['┏', '━', '┓', '┃', '┛', '━', '┗', '┃'],
	double: ['╔', '═', '╗', '║', '╝', '═', '╚', '║'],
	round: ['╭', '─', '╮', '│', '╯', '─', '╰', '│'],
	single: ['┌', '─', '┐', '│', '┘', '─', '└', '│'],
};

/**
 * The cell style a resolved style paints with.
 *
 * One `Color` type is shared with the canvas already, so this is the attributes
 * and nothing else -- the resolved style carries them as booleans because that
 * is what a stylesheet writes, and a cell carries them as bits because that is
 * what a diff compares.
 *
 * @param style - The resolved style.
 * @returns The cell style.
 */
export function cellStyle(style: Style): CellStyle {
	let attrs = ATTR.none;
	if (style.bold) {
		attrs |= ATTR.bold;
	}
	if (style.dim) {
		attrs |= ATTR.dim;
	}
	if (style.italic) {
		attrs |= ATTR.italic;
	}
	if (style.underline) {
		attrs |= ATTR.underline;
	}
	if (style.strikethrough) {
		attrs |= ATTR.strikethrough;
	}
	if (style.overline) {
		attrs |= ATTR.overline;
	}
	if (style.inverse) {
		attrs |= ATTR.inverse;
	}

	return { attrs, bg: style.backgroundColor, fg: style.color, link: '' };
}

/**
 * Lays a tree out and writes every box back onto the element it belongs to.
 *
 * Matched by index rather than by identity, which is what the layout engine
 * guarantees and says so: `result.children[i]` answers for `node.children[i]`
 * whatever `order`, `display: none`, or the same node appearing twice did to the
 * placement.
 *
 * @param root - The root element.
 * @param opts - The space available.
 * @returns The laid-out tree, for anything that wants it directly.
 */
export function arrange(root: Element, opts: LayoutOptions): LayoutResult {
	const result = layout(root, opts);

	const walk = (element: Element, node: LayoutResult): void => {
		element.box = node.box;
		element.content = node.content;
		for (const [i, child] of element.children.entries()) {
			const laid = node.children[i];
			if (laid) {
				walk(child, laid);
			}
		}
	};

	walk(root, result);
	return result;
}

/** Draws a border around a box, if its style asks for one. */
function paintBorder(painter: Painter, area: Box, style: Style, cell: CellStyle): void {
	const chars = BORDERS[style.borderStyle];
	if (!chars || area.width <= 0 || area.height <= 0) {
		return;
	}

	const [tl, top, tr, right, br, bottom, bl, left] = chars;
	const edge: CellStyle = { ...cell, fg: style.borderColor };
	const { height, width, x, y } = area;
	const last = y + height - 1;
	const end = x + width - 1;

	// a one-cell-wide or one-row-tall border is the corners overlapping, and the
	// corners win: a box that narrow has no edge to draw
	painter.text(x, y, tl, edge);
	painter.text(end, y, tr, edge);
	painter.text(x, last, bl, edge);
	painter.text(end, last, br, edge);

	for (let i = x + 1; i < end; i++) {
		painter.text(i, y, top, edge);
		painter.text(i, last, bottom, edge);
	}
	for (let i = y + 1; i < last; i++) {
		painter.text(x, i, left, edge);
		painter.text(end, i, right, edge);
	}
}

/** Draws a text element's content inside the box the layout gave it. */
function paintText(painter: Painter, element: Element, area: Box, cell: CellStyle): void {
	const { style } = element;
	const content = element.displayText;
	const lines =
		style.whiteSpace === 'nowrap' || area.width <= 0
			? content.split('\n')
			: wrap(content, { width: area.width }).split('\n');

	for (const [i, line] of lines.entries()) {
		if (i >= area.height) {
			// the rows past the bottom of the box are not this pass's to invent a
			// policy for: clipping is SIG-64's, and painting them would draw over
			// whatever the layout put underneath
			break;
		}

		const slack = Math.max(0, area.width - stringWidth(line));
		const offset =
			style.textAlign === 'right'
				? slack
				: style.textAlign === 'center'
					? Math.floor(slack / 2)
					: 0;

		painter.text(area.x + offset, area.y + i, line, cell);
	}
}

/**
 * Walks a laid-out tree and draws it.
 *
 * Document order, which is paint order: a later sibling draws over an earlier
 * one. `z-index` is parsed and is not read here, because a paint order that
 * honours it is SIG-64's along with clipping.
 *
 * @param root - The root element, already arranged.
 * @param painter - The painter to draw through.
 */
export function paint(root: Element, painter: Painter): void {
	const walk = (element: Element): void => {
		const area = element.box;
		if (!area || element.style.display === 'none') {
			return;
		}

		const { style } = element;
		const cell = cellStyle(style);

		// `hidden` hides this element and not its subtree: `visibility` inherits,
		// so a descendant is hidden because it inherited the value rather than
		// because this one was, and a descendant that sets `visible` is drawn. That
		// is CSS, and it is the only reason this is a skip rather than a return
		if (style.visibility !== 'hidden') {
			if (style.backgroundColor !== DEFAULT_COLOR) {
				painter.fill(area.x, area.y, area.width, area.height, cell);
			}

			paintBorder(painter, area, style, cell);

			const inner = element.content ?? area;
			if (element.type === 'text') {
				paintText(painter, element, inner, cell);
			} else if (element.type === 'raw') {
				element.rawPaint?.(painter, inner, element);
			}
		}

		for (const child of element.children) {
			walk(child);
		}
	};

	walk(root);
}
